import type { TimelineItem, UserInputQuestion } from "../../../shared/domain.js";
import { validProjectDirectory } from "../../domain/project-directory.js";
import type { DomainDiagnostic } from "../../domain/session-domain.js";
import { normalizeSessionTitle, truncateText } from "../../domain/session-text.js";
import { mergeBindingMetadata } from "../shared/binding-protocol.js";
import type { DecodedRecord } from "../shared/jsonl-decoder.js";
import { MAX_MESSAGE_CHARS, MAX_SESSION_DIAGNOSTICS } from "../shared/limits.js";
import { claudeRecordBindings } from "./interaction.js";

type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): string | null => (typeof value === "string" ? value : null);

function normalizeQuestions(callId: string, values: readonly unknown[]): UserInputQuestion[] {
  return values.flatMap((value, index): UserInputQuestion[] => {
    if (!object(value) || typeof value.question !== "string") return [];
    const options: Array<UserInputQuestion["options"][number]> = [];
    if (Array.isArray(value.options)) {
      for (const option of value.options) {
        if (!object(option) || typeof option.label !== "string") continue;
        options.push({ label: option.label, description: string(option.description) ?? "" });
      }
    }
    return [
      {
        id: `${callId}:${index}`,
        header: string(value.header) ?? "",
        question: value.question,
        options,
      },
    ];
  });
}

export interface ClaudeState extends ClaudeIdentityState {
  readonly timeline: readonly TimelineItem[];
  readonly diagnostics: readonly DomainDiagnostic[];
  readonly questions: ReadonlyMap<string, readonly UserInputQuestion[]>;
  readonly decoderDiagnostics: readonly DomainDiagnostic[];
  readonly normalizerDiagnostics: readonly DomainDiagnostic[];
}

export interface ClaudeIdentityState {
  readonly line: number;
  readonly nativeId: string;
  readonly firstCwd: string | null;
  readonly cwd: string | null;
  readonly project: string | null;
  readonly taskName: string | null;
  readonly customTitle: string | null;
  readonly aiTitle: string | null;
  readonly firstUser: string | null;
  readonly version: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly identityConflict: boolean;
}
export function createClaudeState(nativeId: string): ClaudeState {
  return {
    timeline: [],
    diagnostics: [],
    questions: new Map(),
    decoderDiagnostics: [],
    normalizerDiagnostics: [],
    line: 0,
    nativeId,
    firstCwd: null,
    cwd: null,
    project: null,
    taskName: null,
    customTitle: null,
    aiTitle: null,
    firstUser: null,
    version: null,
    createdAt: null,
    updatedAt: null,
    identityConflict: false,
  };
}

export function appendClaudeRecords(
  previous: ClaudeState,
  records: readonly DecodedRecord[],
  diagnostics: readonly DomainDiagnostic[] = [],
): ClaudeState {
  if (
    records.length === 0 &&
    JSON.stringify(previous.decoderDiagnostics) === JSON.stringify(diagnostics)
  )
    return previous;
  const state = {
    ...previous,
    timeline: [...previous.timeline],
    diagnostics: [...previous.normalizerDiagnostics],
    questions: new Map(previous.questions),
  };
  type NewItem<T = TimelineItem> = T extends TimelineItem ? Omit<T, "id" | "ordinal"> : never;
  const emit = (item: NewItem) => {
    const ordinal = state.timeline.length;
    if (item.kind === "message")
      item = { ...item, markdown: truncateText(item.markdown, MAX_MESSAGE_CHARS).text };
    state.timeline.push({ ...item, id: `${state.nativeId}:${ordinal}`, ordinal } as TimelineItem);
  };
  const retainDiagnostic = (diagnostic: DomainDiagnostic) => {
    const index = state.diagnostics.findIndex(
      (existing) => (existing.ordinal ?? Infinity) > (diagnostic.ordinal ?? Infinity),
    );
    if (index >= 0) state.diagnostics.splice(index, 0, diagnostic);
    else if (state.diagnostics.length < MAX_SESSION_DIAGNOSTICS) state.diagnostics.push(diagnostic);
    state.diagnostics.length = Math.min(state.diagnostics.length, MAX_SESSION_DIAGNOSTICS);
  };

  for (const { ordinal, value: row } of records) {
    state.line = ordinal;
    if (!object(row) || row.isSidechain === true || row.parent_tool_use_id != null) continue;
    // API copies and progress/subagent notifications never supply conversation or bindings.
    if (!["user", "assistant", "custom-title", "ai-title", "system"].includes(String(row.type)))
      continue;
    if (!appendClaudeIdentity(state, row, ordinal, retainDiagnostic)) continue;
    const timestamp = string(row.timestamp);
    if (row.type === "custom-title") {
      state.customTitle = normalizeSessionTitle(string(row.customTitle)) || state.customTitle;
      continue;
    }
    if (row.type === "ai-title") {
      state.aiTitle = normalizeSessionTitle(string(row.aiTitle)) || state.aiTitle;
      continue;
    }
    if (row.type !== "user" && row.type !== "assistant") continue;
    if (row.isMeta === true || row.isCompactSummary === true || row.subtype === "subagent")
      continue;
    const message = row.message;
    if (!object(message) || message.role !== row.type) continue;
    const role = row.type;
    let phase: "update" | "response" | null = null;
    if (role === "assistant") {
      if (message.stop_reason === "tool_use") phase = "update";
      else if (message.stop_reason === "end_turn") phase = "response";
    }
    let blocks: unknown[] = [];
    if (typeof message.content === "string") blocks = [{ type: "text", text: message.content }];
    else if (Array.isArray(message.content)) blocks = message.content;
    let text: string[] = [];
    const flush = () => {
      const markdown = truncateText(text.join("\n\n"), MAX_MESSAGE_CHARS).text;
      text = [];
      if (!markdown.trim()) return;
      if (role === "user") state.firstUser ??= markdown;
      emit({ kind: "message", role, phase, itemType: null, markdown, timestamp });
    };
    for (const block of blocks) {
      if (!object(block)) {
        flush();
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        const content = block.text;
        if (
          role === "user" &&
          /^\s*(?:<bash-(?:input|stdout|stderr)>|<local-command-|<command-name>|<command-message>|<task-notification>|<subagent|<teammate-message|<system-reminder>|<system-context>|\[Request interrupted by user)/.test(
            content,
          )
        ) {
          flush();
          continue;
        }
        text.push(content);
        continue;
      }
      flush();
      if (role === "assistant" && block.type === "tool_use" && object(block.input)) {
        const callId = string(block.id);
        if (
          block.name === "ExitPlanMode" &&
          typeof block.input.plan === "string" &&
          block.input.plan.trim()
        ) {
          emit({
            kind: "message",
            role,
            phase: "response",
            itemType: "plan",
            markdown: block.input.plan,
            timestamp,
          });
        }
        if (block.name === "AskUserQuestion" && callId && Array.isArray(block.input.questions)) {
          const questions = normalizeQuestions(callId, block.input.questions);
          state.questions.set(callId, questions);
          emit({ kind: "user_input", stage: "request", callId, questions, timestamp });
        }
      }
      if (
        role === "user" &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        const callId = block.tool_use_id;
        const questions = state.questions.get(callId);
        if (!questions) continue;
        let result: unknown = block.content;
        if (typeof result === "string") {
          try {
            result = JSON.parse(result);
          } catch {
            /* Unstructured results are unavailable unless explicitly rejected. */
          }
        }
        let structured: ObjectValue | null = null;
        if (object(row.toolUseResult)) structured = row.toolUseResult;
        else if (object(result)) structured = result;
        const values = structured && object(structured.answers) ? structured.answers : null;
        const answers = questions.map((q) => {
          const answer = values?.[q.question] ?? values?.[q.id];
          let answerValues: string[] = [];
          if (typeof answer === "string") answerValues = [answer];
          else if (Array.isArray(answer) && answer.every((v) => typeof v === "string"))
            answerValues = [...answer];
          return { questionId: q.id, answers: answerValues };
        });
        const rejected =
          structured?.denied === true ||
          structured?.rejected === true ||
          (typeof result === "string" &&
            /^(?:The user (?:doesn't want to proceed|declined|rejected)|User (?:declined|rejected)|Request interrupted by user)/i.test(
              result,
            ));
        const response = {
          kind: "user_input",
          stage: "response",
          callId,
          timestamp,
        } as const;
        if (rejected) emit({ ...response, outcome: "aborted" });
        else if (answers.length > 0 && answers.every((a) => a.answers.length > 0))
          emit({ ...response, outcome: "answered", answers });
        else
          emit({
            ...response,
            outcome: "unavailable",
            summary: "Answer could not be reliably interpreted",
          });
        state.questions.delete(callId);
      }
    }
    flush();
  }
  const metadata = mergeBindingMetadata(
    { projectDirectory: state.project, taskName: state.taskName },
    records.flatMap(claudeRecordBindings).map((event) => event.attempt),
  );
  return {
    ...state,
    project: metadata.projectDirectory,
    taskName: metadata.taskName,
    decoderDiagnostics: diagnostics,
    normalizerDiagnostics: state.diagnostics,
    diagnostics: [...diagnostics, ...state.diagnostics].slice(0, MAX_SESSION_DIAGNOSTICS),
  };
}

/** Native identity and directory/version/time evidence is accumulated separately from content. */
function appendClaudeIdentity(
  state: { -readonly [K in keyof ClaudeIdentityState]: ClaudeIdentityState[K] },
  row: ObjectValue,
  ordinal: number,
  retainDiagnostic: (diagnostic: DomainDiagnostic) => void,
): boolean {
  const identities = [string(row.sessionId), string(row.session_id)].filter(Boolean);
  if (identities.some((identity) => identity !== state.nativeId)) {
    state.identityConflict = true;
    retainDiagnostic({
      code: "conflicting_native_session_id",
      severity: "warning",
      message: "Claude record identity conflicts with its session file",
      ordinal: ordinal,
    });
    return false;
  }
  const timestamp = string(row.timestamp);
  if (timestamp && Number.isFinite(Date.parse(timestamp))) {
    state.createdAt ??= timestamp;
    state.updatedAt = timestamp;
  }
  if (validProjectDirectory(row.cwd)) {
    state.firstCwd ??= row.cwd;
    state.cwd = row.cwd;
  }
  state.version = string(row.version) ?? state.version;
  return true;
}

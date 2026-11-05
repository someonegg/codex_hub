import type { TimelineItem, UserInputQuestion } from "../../../shared/domain.js";
import type { DomainDiagnostic } from "../../domain/session-domain.js";
import { normalizeSessionTitle, truncateText } from "../../domain/session-text.js";
import { mergeBindingMetadata } from "../shared/binding-protocol.js";
import type { DecodedRecord } from "../shared/jsonl-decoder.js";
import { MAX_MESSAGE_CHARS, MAX_SESSION_DIAGNOSTICS } from "../shared/limits.js";
import { appendClaudeIdentity, type ClaudeIdentityState } from "./identity.js";
import { claudeRecordBindings } from "./interaction.js";
import { normalizeQuestionResponse, normalizeQuestions } from "./user-input-normalizer.js";

type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): string | null => (typeof value === "string" ? value : null);

export interface ClaudeState extends ClaudeIdentityState {
  readonly timeline: readonly TimelineItem[];
  readonly diagnostics: readonly DomainDiagnostic[];
  readonly questions: ReadonlyMap<string, readonly UserInputQuestion[]>;
  readonly decoderDiagnostics: readonly DomainDiagnostic[];
  readonly normalizerDiagnostics: readonly DomainDiagnostic[];
}

export type { ClaudeIdentityState } from "./identity.js";
/** Decoder codes are renamed to adapter-neutral session diagnostics. */
export function claudeDecoderDiagnostics(
  diagnostics: readonly DomainDiagnostic[],
): DomainDiagnostic[] {
  return diagnostics.map((d) =>
    d.code === "malformed_json" ? { ...d, code: "invalid_jsonl" } : d,
  );
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
  bindings = records.flatMap(claudeRecordBindings),
): ClaudeState {
  if (
    records.length === 0 &&
    JSON.stringify(previous.decoderDiagnostics) === JSON.stringify(diagnostics)
  )
    return previous;
  const state = {
    ...previous,
    diagnostics: [...previous.normalizerDiagnostics],
  };
  const newItems: TimelineItem[] = [];
  let pendingQuestions = previous.questions;
  const mutableQuestions = () => {
    if (pendingQuestions === previous.questions) pendingQuestions = new Map(previous.questions);
    return pendingQuestions as Map<string, readonly UserInputQuestion[]>;
  };
  type NewItem<T = TimelineItem> = T extends TimelineItem ? Omit<T, "id" | "ordinal"> : never;
  const emit = (item: NewItem) => {
    const ordinal = previous.timeline.length + newItems.length + 1;
    if (item.kind === "message")
      item = { ...item, markdown: truncateText(item.markdown, MAX_MESSAGE_CHARS).text };
    newItems.push({ ...item, id: `${state.nativeId}:${ordinal}`, ordinal } as TimelineItem);
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
          mutableQuestions().set(callId, questions);
          emit({ kind: "user_input", stage: "request", callId, questions, timestamp });
        }
      }
      if (
        role === "user" &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        const callId = block.tool_use_id;
        const questions = pendingQuestions.get(callId);
        if (!questions) continue;
        emit(
          normalizeQuestionResponse(callId, questions, block.content, row.toolUseResult, timestamp),
        );
        mutableQuestions().delete(callId);
      }
    }
    flush();
  }
  const metadata = mergeBindingMetadata(
    { projectDirectory: state.project, taskName: state.taskName },
    bindings.map((event) => event.attempt),
  );
  return {
    ...state,
    timeline: newItems.length ? [...previous.timeline, ...newItems] : previous.timeline,
    questions: pendingQuestions,
    project: metadata.projectDirectory,
    taskName: metadata.taskName,
    decoderDiagnostics: diagnostics,
    normalizerDiagnostics: state.diagnostics,
    diagnostics: [...diagnostics, ...state.diagnostics].slice(0, MAX_SESSION_DIAGNOSTICS),
  };
}

import { validTaskName } from "../../../shared/task-name.js";
import { validProjectDirectory } from "../../domain/project-directory.js";
import type {
  DomainAgentInteraction,
  InteractionBindingAttempt,
} from "../../domain/session-domain.js";
import { shellQuote } from "../../interaction/tmux-launcher.js";
import { bindingAttempts } from "../shared/binding-protocol.js";
import type { DecodedRecord } from "../shared/jsonl-decoder.js";
import { DEFAULT_KEY_BINDINGS, interruptSteps } from "../shared/session-management.js";

export const validClaudeId = (id: string) =>
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id);

export function claudeBindingCommand(
  operationId = "",
  projectDirectory?: string | null,
  taskName: string | null = null,
): string {
  if (operationId && !validClaudeId(operationId)) throw new Error("Invalid operation ID");
  if (taskName !== null && !validTaskName(taskName)) throw new Error("Invalid task name");
  return `! printf 'AHUB_TMUX_BIND_V2\\n%s\\n%s\\n%s\\n%s\\n%s\\n' "\${TMUX%%,*}" "$TMUX_PANE" ${shellQuote(operationId)} ${shellQuote(validProjectDirectory(projectDirectory) ? projectDirectory : "")} ${shellQuote(JSON.stringify(taskName))}`;
}

/** Only call with the main user record's native bash stdout wrapper. */
export function claudeBindingAttempts(text: string, ordinal: number): InteractionBindingAttempt[] {
  const found: InteractionBindingAttempt[] = [];
  for (const match of text.matchAll(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/g)) {
    const lines = match[1]!.replace(/\r\n?/g, "\n").split("\n");
    found.push(...bindingAttempts(lines, ordinal, validClaudeId));
  }
  return found;
}

export function claudeInteraction(
  projectDirectory: string | null,
  taskName: string | null,
): DomainAgentInteraction {
  return {
    transport: "tmux",
    bindingCommand: claudeBindingCommand("", projectDirectory, taskName),
    interruptSteps,
    keyBindings: DEFAULT_KEY_BINDINGS,
  };
}

/** Only native main-session user shell wrappers can supply binding evidence. */
export function claudeRecordBindings(record: DecodedRecord) {
  const row = record.value;
  if (
    row.type !== "user" ||
    row.isSidechain === true ||
    row.parent_tool_use_id != null ||
    row.isMeta === true ||
    row.isCompactSummary === true ||
    row.subtype === "subagent"
  )
    return [];
  const message = row.message;
  if (
    !message ||
    typeof message !== "object" ||
    !("role" in message) ||
    message.role !== "user" ||
    !("content" in message)
  )
    return [];
  const content =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  if (!Array.isArray(content)) return [];
  const attempts = content.flatMap((block) =>
    block &&
    block.type === "text" &&
    typeof block.text === "string" &&
    /^\s*<bash-(?:input|stdout|stderr)>/.test(block.text)
      ? claudeBindingAttempts(block.text, record.ordinal)
      : [],
  );
  const time = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  return attempts.map((attempt, position) => ({
    time: Number.isFinite(time) ? time : 0,
    ordinal: record.ordinal,
    position,
    attempt,
  }));
}

import { TASK_NAME_ERROR, validTaskName } from "../../../shared/task-name.js";
import { validProjectDirectory } from "../../domain/project-directory.js";
import type {
  DomainAgentInteraction,
  InteractionBindingAttempt,
} from "../../domain/session-domain.js";
import { bindingAttempts } from "../shared/binding-protocol.js";
import type { DecodedRecord } from "../shared/jsonl-decoder.js";
import { isObject } from "../shared/jsonl-decoder.js";
import { DEFAULT_KEY_BINDINGS, interruptSteps } from "../shared/session-management.js";

const BINDING_MARKER = "AHUB_TMUX_BIND_V3";

export function codexInteraction(
  projectDirectory?: string | null,
  taskName?: string | null,
): DomainAgentInteraction {
  return {
    transport: "tmux",
    bindingCommand: codexBindingCommand(undefined, projectDirectory, taskName),
    keyBindings: DEFAULT_KEY_BINDINGS,
    interruptSteps,
  };
}

export function codexBindingAttemptsFrom(record: DecodedRecord): InteractionBindingAttempt[] {
  if (record.value.type !== "response_item") return [];
  const metadata = record.value.metadata;
  if (isObject(metadata) && metadata.inherited_user_message === true) return [];
  const payload = record.value.payload;
  if (!isObject(payload) || payload.type !== "message" || payload.role !== "user") {
    return [];
  }
  const text = contentText(payload.content);
  if (text === null || !/^\s*<user_shell_command>/.test(text)) return [];
  const shellBlocks = [...text.matchAll(/<user_shell_command>([\s\S]*?)<\/user_shell_command>/g)];
  const found: InteractionBindingAttempt[] = [];
  for (const block of shellBlocks) {
    const lines = (block[1] ?? "").split("\n").map((line) => line.replace(/\r$/, ""));
    found.push(...bindingAttempts(lines, record.ordinal, validOperationId));
  }
  const lastOpen = text.lastIndexOf("<user_shell_command>");
  const lastClose = text.lastIndexOf("</user_shell_command>");
  if (lastOpen > lastClose) {
    const incomplete = text.slice(lastOpen + "<user_shell_command>".length);
    const incompleteLines = incomplete.replace(/\r\n?/g, "\n").split("\n");
    for (const line of incompleteLines) {
      if (line === BINDING_MARKER) found.push({ ordinal: record.ordinal, valid: false });
    }
  }
  return found;
}

function contentText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const part of value) {
    if (!isObject(part) || typeof part.text !== "string") continue;
    if (part.type === "input_text" || part.type === "text") parts.push(part.text);
  }
  return parts.length === 0 ? null : parts.join("\n\n");
}

export function codexBindingCommand(
  operationId?: string,
  projectDirectory?: string | null,
  taskName?: string | null,
): string {
  if (taskName !== undefined && taskName !== null && !validTaskName(taskName))
    throw new Error(TASK_NAME_ERROR);
  if (operationId !== undefined && !validOperationId(operationId))
    throw new Error("Invalid operation ID");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const project = validProjectDirectory(projectDirectory) ? projectDirectory : "";

  return `! printf '${BINDING_MARKER}\\n%s\\n%s\\n%s\\n%s\\n%s\\n' "\${TMUX%%,*}" "$AHUB_TMUX_SESSION_NAME" ${quote(operationId ?? "")} ${quote(project)} ${quote(JSON.stringify(taskName ?? null))}`;
}

function validOperationId(id: string): boolean {
  return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id);
}

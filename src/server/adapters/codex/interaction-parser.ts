import { isAbsolute } from "node:path";

import { validProjectDirectory } from "../../domain/project-directory.js";
import type {
  DomainAgentInteraction,
  InteractionBindingAttempt,
  InteractionKeyBindings,
} from "../../domain/session-domain.js";
import type { DecodedRecord } from "./rollout-decoder.js";
import { isObject } from "./rollout-decoder.js";

export const CODEX_INTERACTION_KEY_BINDINGS = {
  enter: "Enter",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  interrupt: "C-c",
  plan: "BTab",
} as const satisfies InteractionKeyBindings;

export function codexInteraction(projectDirectory?: string | null): DomainAgentInteraction {
  return {
    transport: "tmux",
    bindingCommand: codexBindingCommand(undefined, projectDirectory),
    keyBindings: CODEX_INTERACTION_KEY_BINDINGS,
  };
}

export function codexBindingAttemptsFrom(record: DecodedRecord): InteractionBindingAttempt[] {
  if (record.value.type !== "response_item") return [];
  const payload = record.value.payload;
  if (!isObject(payload) || payload.type !== "message" || payload.role !== "user") {
    return [];
  }
  const text = contentText(payload.content);
  if (text === null || !text.includes("<user_shell_command>")) return [];
  const shellBlocks = [...text.matchAll(/<user_shell_command>([\s\S]*?)<\/user_shell_command>/g)];
  const found: InteractionBindingAttempt[] = [];
  for (const block of shellBlocks) {
    const lines = (block[1] ?? "").split("\n").map((line) => line.replace(/\r$/, ""));
    for (let index = 0; index < lines.length; index += 1) {
      if (!["CODEX_HUB_TMUX_BIND_V3", "CODEX_HUB_TMUX_BIND_V4"].includes(lines[index]!)) continue;
      const project = lines[index] === "CODEX_HUB_TMUX_BIND_V4" ? lines[index + 4] : undefined;
      const tmux = lines[index + 1] ?? "";
      const paneId = lines[index + 2] ?? "";
      const operationId = lines[index + 3] ?? "";
      found.push(
        isAbsolute(tmux) && /^%\d+$/.test(paneId) && (!operationId || validOperationId(operationId))
          ? {
              ordinal: record.ordinal,
              valid: true,
              socketPath: tmux,
              paneId,
              ...(operationId ? { operationId } : {}),
              ...(validProjectDirectory(project) ? { projectDirectory: project } : {}),
            }
          : { ordinal: record.ordinal, valid: false },
      );
    }
  }
  const lastOpen = text.lastIndexOf("<user_shell_command>");
  const lastClose = text.lastIndexOf("</user_shell_command>");
  if (lastOpen > lastClose) {
    const incomplete = text.slice(lastOpen + "<user_shell_command>".length);
    const incompleteLines = incomplete.replace(/\r\n?/g, "\n").split("\n");
    for (const line of incompleteLines) {
      if (/^CODEX_HUB_TMUX_BIND_V[34]$/.test(line))
        found.push({ ordinal: record.ordinal, valid: false });
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
): string {
  if (operationId !== undefined && !validOperationId(operationId))
    throw new Error("Invalid operation ID");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const project = validProjectDirectory(projectDirectory) ? projectDirectory : "";
  return `! printf 'CODEX_HUB_TMUX_BIND_V4\\n%s\\n%s\\n%s\\n%s\\n' "$(tmux display-message -p '#{socket_path}')" "$TMUX_PANE" ${quote(operationId ?? "")} ${quote(project)}`;
}

function validOperationId(id: string): boolean {
  return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id);
}

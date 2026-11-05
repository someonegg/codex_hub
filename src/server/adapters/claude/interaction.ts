import { isAbsolute } from "node:path";

import { validTaskName } from "../../../shared/task-name.js";
import { validProjectDirectory } from "../../domain/project-directory.js";
import type {
  DomainAgentInteraction,
  InteractionBindingAttempt,
} from "../../domain/session-domain.js";
import { shellQuote } from "../../interaction/tmux-launcher.js";

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
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== "AHUB_TMUX_BIND_V2") continue;
      const socketPath = lines[i + 1] ?? "";
      const paneId = lines[i + 2] ?? "";
      const operationId = lines[i + 3] ?? "";
      const projectDirectory = lines[i + 4];
      let taskName: string | null | undefined;
      try {
        const value: unknown = JSON.parse(lines[i + 5] ?? "");
        if (value === null || validTaskName(value)) taskName = value === null ? null : value.trim();
      } catch {
        /* Optional metadata does not invalidate a pane binding. */
      }
      if (
        !isAbsolute(socketPath) ||
        !/^%\d+$/.test(paneId) ||
        (operationId && !validClaudeId(operationId))
      ) {
        found.push({ ordinal, valid: false });
        continue;
      }
      found.push({
        ordinal,
        valid: true,
        socketPath,
        paneId,
        ...(operationId ? { operationId } : {}),
        ...(validProjectDirectory(projectDirectory) ? { projectDirectory } : {}),
        ...(taskName !== undefined ? { taskName } : {}),
      });
    }
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
    interruptSteps: () => [
      { keys: ["C-u"], delayMs: 0 },
      { keys: ["Escape"], delayMs: 100 },
    ],
    keyBindings: {
      enter: "Enter",
      up: "Up",
      down: "Down",
      left: "Left",
      right: "Right",
      BTab: "BTab",
      "0": "0",
      "1": "1",
      "2": "2",
      "3": "3",
      "4": "4",
      "5": "5",
      "6": "6",
      "7": "7",
      "8": "8",
      "9": "9",
    },
  };
}

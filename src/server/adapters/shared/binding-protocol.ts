import { isAbsolute } from "node:path";

import { validTaskName } from "../../../shared/task-name.js";
import { validProjectDirectory } from "../../domain/project-directory.js";
import type { InteractionBindingAttempt } from "../../domain/session-domain.js";

/** Parse protocol fields only after the adapter has established native provenance. */
export function bindingAttempts(
  lines: readonly string[],
  ordinal: number,
  validOperationId: (id: string) => boolean,
): InteractionBindingAttempt[] {
  const found: InteractionBindingAttempt[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] !== "AHUB_TMUX_BIND_V1" && lines[index] !== "AHUB_TMUX_BIND_V2") continue;
    const socketPath = lines[index + 1] ?? "";
    const paneId = lines[index + 2] ?? "";
    const operationId = lines[index + 3] ?? "";
    const projectDirectory = lines[index + 4];
    let taskName: string | undefined;
    if (lines[index] === "AHUB_TMUX_BIND_V2") {
      try {
        const value: unknown = JSON.parse(lines[index + 5] ?? "");
        if (validTaskName(value)) taskName = value.trim() || undefined;
      } catch {
        /* Optional metadata cannot invalidate a binding. */
      }
    }
    if (
      !isAbsolute(socketPath) ||
      !/^%\d+$/.test(paneId) ||
      (operationId && !validOperationId(operationId))
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
      ...(taskName ? { taskName } : {}),
    });
  }
  return found;
}
export function mergeBindingMetadata(
  previous: { projectDirectory: string | null; taskName: string | null },
  attempts: readonly InteractionBindingAttempt[],
) {
  let { projectDirectory, taskName } = previous;
  for (const attempt of attempts) {
    if (!attempt.valid) continue;
    if (validProjectDirectory(attempt.projectDirectory))
      projectDirectory = attempt.projectDirectory;
    if (validTaskName(attempt.taskName) && attempt.taskName.trim())
      taskName = attempt.taskName.trim();
  }
  return { projectDirectory, taskName };
}

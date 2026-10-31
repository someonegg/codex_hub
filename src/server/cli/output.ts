import stringWidth from "string-width";

import type { TmuxTarget } from "../../shared/api-contract.js";
import { ResourceValidationError } from "../hosting/validation-error.js";
import { CommandError } from "./command-error.js";

export function singleLine(value: string): string {
  return value.replace(/[\r\n\t]/g, " ");
}

// Keep complete values (especially opaque IDs and URLs) and use deterministic
// widths for both terminals and redirected output. Ambiguous characters are narrow.
export function formatTable(headers: string[], rows: string[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(singleLine));
  const widths = headers.map((_, column) =>
    lines.reduce((width, row) => Math.max(width, stringWidth(row[column] ?? "")), 0),
  );
  return lines
    .map((row) =>
      row
        .map((cell, column) =>
          column === headers.length - 1
            ? cell
            : cell + " ".repeat(widths[column]! - stringWidth(cell) + 2),
        )
        .join("")
        .trimEnd(),
    )
    .join("\n");
}

export function formatTmux(target: TmuxTarget | null): string {
  if (!target) return "unknown";
  return singleLine(
    `${target.socketPath} ${target.paneId} (session: ${target.sessionName ?? "unknown"})`,
  );
}

export function output(result: unknown, json: boolean, human: string): void {
  console.log(json ? JSON.stringify(result) : human);
}

export function outputFailure(error: unknown, json: boolean): void {
  let failure: CommandError;
  if (error instanceof CommandError) {
    failure = error;
  } else {
    const code = error instanceof ResourceValidationError ? "invalid_arguments" : "command_failed";
    const message = error instanceof Error ? error.message : "Command failed";
    failure = new CommandError(code, message);
  }
  if (json)
    console.log(
      JSON.stringify({
        error: { code: failure.code, message: failure.message, ...failure.diagnostics },
      }),
    );
  else {
    const lines = [failure.message];
    if (failure.diagnostics) {
      lines.push(
        `Session: ${failure.diagnostics.sessionId ?? "unknown"}`,
        `Tmux: ${formatTmux(failure.diagnostics.tmux)}`,
      );
    }
    console.error(lines.join("\n"));
  }
  process.exitCode = failure.exitCode;
}

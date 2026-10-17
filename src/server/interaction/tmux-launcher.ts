import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SessionLaunchError } from "../management/session-manager.js";
import { TmuxInteractionService } from "./tmux-service.js";
import type { TmuxBinding } from "./transport.js";

const execute = promisify(execFile);

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function attachCommand(socket: string | undefined, session: string): string {
  return [
    "tmux",
    ...(socket ? ["-S", shellQuote(socket)] : []),
    "attach-session",
    "-t",
    shellQuote(session),
  ].join(" ");
}

/** Launch argv directly; user values are never interpreted by a shell. */
export class TmuxLauncher {
  readonly transport = new TmuxInteractionService();

  constructor(readonly socketPath?: string) {}

  async launch(id: string, directory: string, command: readonly string[]): Promise<TmuxBinding> {
    const fallbackAttach = attachCommand(this.socketPath, `codex-hub-${id}`);
    let stdout: string;
    try {
      ({ stdout } = await execute(
        "tmux",
        [
          ...(this.socketPath ? ["-S", this.socketPath] : []),
          "new-session",
          "-d",
          "-P",
          "-F",
          "#{socket_path}|#{pane_id}",
          "-s",
          `codex-hub-${id}`,
          "-x",
          "120",
          "-y",
          "40",
          "-c",
          directory,
          ...command,
        ],
        { timeout: 5_000 },
      ));
    } catch (error) {
      const uncertain =
        !!error &&
        typeof error === "object" &&
        (("killed" in error && error.killed) ||
          ("code" in error && error.code === "timeout") ||
          ("signal" in error && error.signal != null));
      throw new SessionLaunchError(
        uncertain ? "unknown" : "not_started",
        error instanceof Error ? error.message : String(error),
        uncertain ? fallbackAttach : null,
      );
    }
    const output = stdout.trimEnd();
    const separator = output.lastIndexOf("|");
    const socketPath = output.slice(0, separator);
    const paneId = output.slice(separator + 1);
    if (
      separator < 1 ||
      !socketPath.startsWith("/") ||
      socketPath.includes("\n") ||
      !/^%\d+$/.test(paneId)
    ) {
      throw new SessionLaunchError("unknown", "Invalid launched tmux target", fallbackAttach);
    }
    const target = { socketPath, paneId };
    try {
      await execute(
        "tmux",
        ["-S", socketPath, "set-option", "-p", "-t", paneId, "remain-on-exit", "off"],
        { timeout: 5_000 },
      );
      return await this.transport.connect({ valid: true, ordinal: 0, ...target });
    } catch (error) {
      throw new SessionLaunchError(
        "unknown",
        error instanceof Error ? error.message : String(error),
        attachCommand(socketPath, `codex-hub-${id}`),
        target,
      );
    }
  }
}

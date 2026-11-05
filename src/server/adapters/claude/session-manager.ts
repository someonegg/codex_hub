import { realpath, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { validProjectDirectory } from "../../domain/project-directory.js";
import { attachCommand, TmuxLauncher } from "../../interaction/tmux-launcher.js";
import {
  LAUNCH_ATTACH_DELAY_MS,
  SessionLaunchError,
  type SessionLaunchOptions,
  type SessionManager,
} from "../../management/session-manager.js";
import { claudeBindingCommand, validClaudeId } from "./interaction.js";

export class ClaudeSessionManager implements SessionManager {
  constructor(
    private readonly home: string,
    private readonly tmux = new TmuxLauncher(),
  ) {}
  isValidNativeId = validClaudeId;
  async resolveDirectory(input: string) {
    if (!validProjectDirectory(input)) throw new Error("Directory must be an absolute local path");
    const directory = await realpath(input);
    if (!(await stat(directory)).isDirectory())
      throw Object.assign(new Error("Path is not a directory"), { code: "ENOTDIR" });
    return { directory };
  }
  async launch(options: SessionLaunchOptions) {
    if (options.resumeNativeId !== undefined && !this.isValidNativeId(options.resumeNativeId))
      throw new Error("Invalid resume identity");
    const target = await this.tmux.launch(options.operationId, options.workingDirectory, [
      "env",
      `CLAUDE_CONFIG_DIR=${this.home}`,
      "claude",
      ...(options.resumeNativeId ? ["--resume", options.resumeNativeId] : []),
      ...(options.worktree ? ["--worktree"] : []),
      ...(options.yolo ? ["--dangerously-skip-permissions"] : []),
    ]);
    try {
      const deadline = Date.now() + LAUNCH_ATTACH_DELAY_MS;
      while (Date.now() < deadline) {
        const { content } = await this.tmux.transport.captureTerminal(target);
        if (/Is this a project you created or one you trust/.test(content))
          throw new Error(
            "Claude requires workspace trust. Attach to tmux, approve the directory, then run: " +
              claudeBindingCommand(
                options.operationId,
                options.projectDirectory,
                options.taskName ?? null,
              ),
          );
        if (/^❯[ \u00a0]*$/m.test(content)) {
          await this.tmux.transport.sendMessage(
            target,
            claudeBindingCommand(
              options.operationId,
              options.projectDirectory,
              options.taskName ?? null,
            ),
          );
          return target;
        }
        await delay(100);
      }
      throw new Error(
        "Claude did not reach its interactive prompt. Attach to tmux to complete startup and run the binding command.",
      );
    } catch (error) {
      throw new SessionLaunchError(
        "unknown",
        error instanceof Error ? error.message : String(error),
        attachCommand(target.socketPath, `ahub-${options.operationId}`),
        target,
      );
    }
  }
  exitSteps() {
    return [
      { keys: ["C-c"] as const, delayMs: 0 },
      { keys: ["C-c"] as const, delayMs: 1000 },
      { keys: ["C-c"] as const, delayMs: 1000 },
    ];
  }
}
export const createClaudeSessionManager = (home: string, socket?: string): SessionManager =>
  new ClaudeSessionManager(home, new TmuxLauncher(socket));

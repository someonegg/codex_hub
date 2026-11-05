import { setTimeout as delay } from "node:timers/promises";

import { attachCommand, TmuxLauncher } from "../../interaction/tmux-launcher.js";
import {
  LAUNCH_ATTACH_DELAY_MS,
  SessionLaunchError,
  type SessionLaunchOptions,
  type SessionManager,
} from "../../management/session-manager.js";
import { exitSteps, resolveDirectory } from "../shared/session-management.js";
import { claudeBindingCommand, validClaudeId } from "./interaction.js";

/**
 * Fragile coupling to the Claude Code TUI: this matches the visual prompt the
 * CLI renders once its interactive REPL is ready. A Claude Code release that
 * changes the prompt glyph or spacing will keep launches working but degrade
 * them to the LAUNCH_ATTACH_DELAY_MS timeout with a manual attach command in
 * the launch error. Revisit this pattern when launches consistently time out
 * right after a CLI upgrade.
 */
const INTERACTIVE_PROMPT_PATTERN = /^❯[ \u00a0]*$/m;

export class ClaudeSessionManager implements SessionManager {
  constructor(
    private readonly home: string,
    private readonly tmux = new TmuxLauncher(),
  ) {}
  isValidNativeId = validClaudeId;
  resolveDirectory = resolveDirectory;
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
        if (INTERACTIVE_PROMPT_PATTERN.test(content)) {
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
  exitSteps = exitSteps;
}
export const createClaudeSessionManager = (home: string, socket?: string): SessionManager =>
  new ClaudeSessionManager(home, new TmuxLauncher(socket));

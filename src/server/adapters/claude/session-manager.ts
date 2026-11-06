import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { attachCommand, TmuxLauncher } from "../../interaction/tmux-launcher.js";
import {
  SessionLaunchError,
  type SessionLaunchOptions,
  type SessionManager,
} from "../../management/session-manager.js";
import { exitSteps, resolveDirectory } from "../shared/session-management.js";
import { claudeBindingCommand, validClaudeId } from "./interaction.js";
import { claudePromptPosition } from "./prompt-readiness.js";

/** Never deliver bootstrap input unless the native prompt is confirmed ready. */
export const BINDING_PROMPT_WAIT_MS = 15_000;

export class ClaudeSessionManager implements SessionManager {
  constructor(
    private readonly home: string,
    private readonly tmux = new TmuxLauncher(),
  ) {}
  readonly interruptAfterBinding = true;
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
      const deadline = Date.now() + BINDING_PROMPT_WAIT_MS;
      let previousPrompt: number | null = null;
      let ready = false;
      while (Date.now() < deadline) {
        const snapshot = await this.tmux.transport.captureTerminalWithCursor(target);
        if (Date.now() >= deadline) break;
        const prompt = claudePromptPosition(snapshot);
        if (prompt !== null && prompt === previousPrompt) {
          ready = true;
          break;
        }
        previousPrompt = prompt;
        await delay(100);
      }
      if (!ready)
        throw new Error(
          "Claude Code prompt readiness was not confirmed before timeout. Attach to tmux to check the session.",
        );
      await this.tmux.transport.sendMessage(
        target,
        claudeBindingCommand(
          options.operationId,
          options.projectDirectory,
          options.taskName ?? null,
        ),
      );
      return target;
    } catch (error) {
      throw new SessionLaunchError(
        "unknown",
        error instanceof Error ? error.message : String(error),
        attachCommand(target.socketPath, `ahub-${options.operationId}`),
        target,
      );
    }
  }
  async delete(nativeId: string): Promise<void> {
    if (!this.isValidNativeId(nativeId)) throw new Error("Invalid Claude session identity");
    const projects = join(this.home, "projects");
    let entries;
    try {
      entries = await readdir(projects, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const project of entries) {
      if (!project.isDirectory()) continue;
      const directory = join(projects, project.name);
      const session = join(directory, nativeId);
      try {
        if ((await lstat(session)).isDirectory()) {
          await rm(join(session, "subagents"), { recursive: true, force: true });
          try {
            await rmdir(session);
          } catch (error) {
            if (
              !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
                (error as NodeJS.ErrnoException).code ?? "",
              )
            )
              throw error;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rm(join(directory, `${nativeId}.jsonl`), { force: true });
    }
  }
  exitSteps = exitSteps;
}
export const createClaudeSessionManager = (home: string, socket?: string): SessionManager =>
  new ClaudeSessionManager(home, new TmuxLauncher(socket));

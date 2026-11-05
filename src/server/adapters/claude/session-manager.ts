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

/** Prompt detection is an optimization; send once after this delay regardless. */
export const BINDING_PROMPT_WAIT_MS = 15_000;
const INTERACTIVE_PROMPT_PATTERN = /^❯[ \u00a0]*$/m;

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
      while (Date.now() < deadline) {
        const { content } = await this.tmux.transport.captureTerminal(target);
        if (INTERACTIVE_PROMPT_PATTERN.test(content)) break;
        await delay(100);
      }
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

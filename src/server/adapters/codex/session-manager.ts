import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { TmuxLauncher } from "../../interaction/tmux-launcher.js";
import type { SessionLaunchOptions, SessionManager } from "../../management/session-manager.js";
import { exitSteps, resolveDirectory } from "../shared/session-management.js";
import { codexBindingCommand } from "./interaction-parser.js";

const execute = promisify(execFile);
export class CodexSessionManager implements SessionManager {
  constructor(
    private readonly agent: string,
    private readonly tmux = new TmuxLauncher(),
  ) {}

  resolveDirectory = resolveDirectory;
  isValidNativeId(nativeId: string): boolean {
    return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(nativeId);
  }
  launch({
    operationId,
    workingDirectory,
    worktree,
    yolo,
    resumeNativeId,
    projectDirectory,
    taskName,
  }: SessionLaunchOptions) {
    if (resumeNativeId !== undefined && !this.isValidNativeId(resumeNativeId))
      throw new Error("Invalid resume identity");
    return this.tmux.launch(operationId, workingDirectory, [
      "env",
      `CODEX_HOME=${this.agent}`,
      "codex",
      ...(resumeNativeId ? ["resume", resumeNativeId] : []),
      "--no-daemon",
      "--no-alt-screen",
      ...(worktree ? ["--worktree"] : []),
      ...(yolo ? ["--yolo"] : []),
      codexBindingCommand(operationId, projectDirectory, taskName ?? null),
    ]);
  }
  exitSteps = exitSteps;
  async archive(nativeId: string) {
    await this.#command(["archive", nativeId]);
  }
  async delete(nativeId: string) {
    await this.#command(["delete", nativeId, "--force"]);
  }
  async #command(args: string[]) {
    if (!this.isValidNativeId(args[1]!)) throw new Error("Session has no valid native UUID");
    await execute("codex", args, {
      env: { ...process.env, CODEX_HOME: this.agent },
      timeout: 25_000,
      maxBuffer: 64 * 1024,
    });
  }
}

export const createCodexSessionManager = (agent: string, socket?: string): SessionManager =>
  new CodexSessionManager(agent, new TmuxLauncher(socket));

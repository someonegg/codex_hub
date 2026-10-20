import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";

import { validProjectDirectory } from "../../domain/project-directory.js";
import { TmuxLauncher } from "../../interaction/tmux-launcher.js";
import type { SessionManager } from "../../management/session-manager.js";
import { codexBindingCommand } from "./interaction-parser.js";

const execute = promisify(execFile);
export class CodexSessionManager implements SessionManager {
  constructor(
    private readonly home: string,
    private readonly tmux = new TmuxLauncher(),
  ) {}

  async resolveDirectory(input: string) {
    if (!validProjectDirectory(input)) throw new Error("Directory must be an absolute local path");
    const directory = await realpath(input);
    if (!(await stat(directory)).isDirectory())
      throw Object.assign(new Error("Path is not a directory"), { code: "ENOTDIR" });
    return { directory };
  }
  launch(
    operationId: string,
    directory: string,
    worktree: boolean,
    yolo = false,
    resumeNativeId?: string,
    projectDirectory?: string | null,
  ) {
    if (resumeNativeId && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(resumeNativeId))
      throw new Error("Invalid resume identity");
    return this.tmux.launch(operationId, directory, [
      "env",
      `CODEX_HOME=${this.home}`,
      "codex",
      ...(resumeNativeId ? ["resume", resumeNativeId] : []),
      "--no-daemon",
      "--no-alt-screen",
      ...(worktree ? ["--worktree"] : []),
      ...(yolo ? ["--yolo"] : []),
      codexBindingCommand(operationId, projectDirectory),
    ]);
  }
  exitSteps() {
    return [
      { keys: ["C-c"] as const, delayMs: 0 },
      { keys: ["C-c"] as const, delayMs: 1_000 },
      { keys: ["C-c"] as const, delayMs: 1_000 },
    ];
  }
  async archive(nativeId: string) {
    await this.#command(["archive", nativeId]);
  }
  async delete(nativeId: string) {
    await this.#command(["delete", nativeId, "--force"]);
  }
  async #command(args: string[]) {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(args[1]!))
      throw new Error("Session has no valid native UUID");
    await execute("codex", args, {
      env: { ...process.env, CODEX_HOME: this.home },
      timeout: 25_000,
      maxBuffer: 64 * 1024,
    });
  }
}

export const createCodexSessionManager = (home: string, socket?: string): SessionManager =>
  new CodexSessionManager(home, new TmuxLauncher(socket));

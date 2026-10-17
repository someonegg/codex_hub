import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import { TmuxLauncher } from "../../interaction/tmux-launcher.js";
import type { SessionManager } from "../../management/session-manager.js";
import { codexBindingCommand } from "./interaction-parser.js";
import { ProjectDirectoryResolver } from "./project-directory-resolver.js";

const execute = promisify(execFile);
export class CodexSessionManager implements SessionManager {
  readonly #projects = new ProjectDirectoryResolver();
  constructor(
    private readonly home: string,
    private readonly tmux = new TmuxLauncher(),
  ) {}

  async resolveDirectory(input: string) {
    if (!isAbsolute(input) || input.includes("\0"))
      throw new Error("Directory must be an absolute local path");
    const directory = await realpath(input);
    if (!(await stat(directory)).isDirectory()) throw new Error("Path is not a directory");
    return { directory, project: (await this.#projects.resolve(directory))! };
  }
  launch(operationId: string, directory: string, worktree: boolean) {
    return this.tmux.launch(operationId, directory, [
      "env",
      `CODEX_HOME=${this.home}`,
      "codex",
      "--no-daemon",
      "--no-alt-screen",
      ...(worktree ? ["--worktree"] : []),
      codexBindingCommand(operationId),
    ]);
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

import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { codexBindingCommand } from "../../src/server/adapters/codex/interaction-parser.js";
import { CodexSessionManager } from "../../src/server/adapters/codex/session-manager.js";
import { validProjectDirectory } from "../../src/server/domain/project-directory.js";
import {
  resolveResumeDirectory,
  type SessionManager,
} from "../../src/server/management/session-manager.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

it.each([null, undefined, "", "relative", "/a\0b", "/a\rb", "/a\nb"])(
  "rejects invalid project path %j",
  (value) => {
    expect(validProjectDirectory(value)).toBe(false);
  },
);
it.each(["/a\0b"])("emits an empty project field for invalid %j", (path) => {
  expect(codexBindingCommand(undefined, path)).toMatch(/'' ''$/);
});
it("preserves and safely quotes shell characters in project paths", () => {
  const path = "/a space/'quote'/$HOME;$(echo bad)`echo bad`";
  expect(validProjectDirectory(path)).toBe(true);
  const command = codexBindingCommand(undefined, path)
    .slice(2)
    .replace("\"$(tmux display-message -p '#{socket_path}')\"", "'/tmp/socket'");
  const output = execFileSync("bash", ["-c", command], {
    env: { ...process.env, TMUX_PANE: "%1" },
    encoding: "utf8",
  });
  expect(output.split("\n")).toEqual(["AHUB_TMUX_BIND_V1", "/tmp/socket", "%1", "", path, ""]);
});

it("validates create directories, resolves symlinks and passes the explicit project through worktree launch", async () => {
  const home = await createTempDirectory("create-directory-");
  const directory = join(home, "project");
  await mkdir(directory);
  await symlink(directory, join(home, "link"));
  await writeFile(join(home, "file"), "x");
  const launch = vi.fn(async (_operation: string, _directory: string, _args: string[]) => ({
    socketPath: "/tmp/socket",
    paneId: "%1",
  }));
  const manager = new CodexSessionManager(home, { launch } as never);
  const resolved = await manager.resolveDirectory(join(home, "link"));
  expect(resolved.directory).toMatch(/\/project$/);
  await expect(manager.resolveDirectory(join(home, "file"))).rejects.toThrow("not a directory");
  await expect(manager.resolveDirectory(join(home, "missing"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  for (const path of ["relative", "/a\nb", "/a\rb", "/a\0b"])
    await expect(manager.resolveDirectory(path)).rejects.toThrow("absolute local path");
  await manager.launch({
    operationId: "00000000-0000-4000-8000-000000000001",
    directory: resolved.directory,
    worktree: true,
    yolo: false,
    projectDirectory: "/original/project",
  });
  expect(launch.mock.calls[0]![2]).toContain("--worktree");
  expect(launch.mock.calls[0]![2].at(-1)).toContain("'/original/project'");
});
it("selects resume directories in order, deduplicates and only falls back for missing/non-directory paths", async () => {
  const resolveDirectory = vi.fn(async (directory: string) => ({ directory: directory + "/real" }));
  const manager = { resolveDirectory } as unknown as SessionManager;
  const session = { workingDirectory: "/working", projectDirectory: "/project" };
  expect(await resolveResumeDirectory(manager, session)).toEqual({ directory: "/working/real" });
  for (const code of ["ENOENT", "ENOTDIR"]) {
    resolveDirectory.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    expect(await resolveResumeDirectory(manager, session)).toEqual({ directory: "/project/real" });
  }
  resolveDirectory.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
  await expect(resolveResumeDirectory(manager, session)).rejects.toThrow("denied");
  resolveDirectory.mockClear();
  resolveDirectory.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  await expect(
    resolveResumeDirectory(manager, { workingDirectory: "/same", projectDirectory: "/same" }),
  ).rejects.toThrow("no available");
  expect(resolveDirectory).toHaveBeenCalledTimes(1);
  resolveDirectory.mockClear();
  await expect(
    resolveResumeDirectory(manager, { workingDirectory: "bad", projectDirectory: null }),
  ).rejects.toThrow("no available");
  expect(resolveDirectory).not.toHaveBeenCalled();
});

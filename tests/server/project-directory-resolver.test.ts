import { execFile } from "node:child_process";
import { appendFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { CodexSessionSource } from "../../src/server/adapters/codex/codex-session-source.js";
import { ProjectDirectoryResolver } from "../../src/server/adapters/codex/project-directory-resolver.js";
import { SessionReadService } from "../../src/server/application/session-read-service.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const execFileAsync = promisify(execFile);

describe("project directory resolution", () => {
  it("groups repository subdirectories and detached worktrees under the main working tree", async () => {
    const base = await realpath(await createTempDirectory("codex-project roots-"));
    const main = join(base, "main repository");
    const worktree = join(base, "linked worktree");
    await execFileAsync("git", ["init", main]);
    await execFileAsync("git", ["-C", main,
      "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
      "commit", "--allow-empty", "-m", "initial"]);
    await execFileAsync("git", ["-C", main, "worktree", "add", "--detach", worktree]);
    const mainChild = join(main, "nested");
    const worktreeChild = join(worktree, "nested");
    await Promise.all([mkdir(mainChild), mkdir(worktreeChild)]);
    const resolver = new ProjectDirectoryResolver();
    const directories = [main, mainChild, worktree, worktreeChild];
    const resolved = await resolver.resolveAll(directories);
    expect(directories.map((directory) => resolved.get(directory)))
      .toEqual([main, main, main, main]);

    const home = join(base, "codex-home");
    await mkdir(join(home, "sessions"), { recursive: true });
    await Promise.all(directories.map((cwd, index) => writeFile(
      join(home, `sessions/rollout-session-${index}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: `session-${index}`, cwd } })}\n`,
    )));
    const reader = new SessionReadService([new CodexSessionSource(home, "project-groups")]);
    const list = await reader.list({ project: main });
    expect(list.total).toBe(4);
    expect(list.projects).toEqual([{ project: main, count: 4 }]);
    expect(list.sessions.every((session) => session.projectDirectory === main)).toBe(true);
    expect(list.sessions.map((session) => session.workingDirectory).sort())
      .toEqual([...directories].sort());
    expect((await reader.list({ project: worktree })).total).toBe(0);
  });

  it("preserves non-repository, missing, relative and bare repository paths, and null", async () => {
    const base = await createTempDirectory("codex-project-fallback-");
    const bare = join(base, "bare.git");
    await execFileAsync("git", ["init", "--bare", bare]);
    const directories = [base, join(base, "missing"), "relative/directory", bare, null];
    const resolved = await new ProjectDirectoryResolver().resolveAll(directories);
    expect(directories.map((directory) => resolved.get(directory))).toEqual(directories);
  });

  it("coalesces pending queries and retries both successful and failed results after 30 seconds", async () => {
    let now = 0;
    let complete!: (result: string) => void;
    const query = vi.fn<(directory: string) => Promise<string | null>>()
      .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
      .mockRejectedValueOnce(new Error("Git unavailable or timed out"))
      .mockResolvedValue("/main-again");
    const resolver = new ProjectDirectoryResolver(query, () => now);
    const first = resolver.resolve("/worktree");
    now = 60_000;
    const concurrent = resolver.resolve("/worktree");
    expect(query).toHaveBeenCalledTimes(1);
    complete("/main");
    expect(await first).toBe("/main");
    expect(await concurrent).toBe("/main");
    now += 29_999;
    expect(await resolver.resolve("/worktree")).toBe("/main");
    expect(query).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await resolver.resolve("/worktree")).toBe("/worktree");
    now += 29_999;
    expect(await resolver.resolve("/worktree")).toBe("/worktree");
    expect(query).toHaveBeenCalledTimes(2);
    now += 1;
    expect(await resolver.resolve("/worktree")).toBe("/main-again");
  });

  it("limits concurrent queries to four and releases slots after failures", async () => {
    let active = 0;
    let maximum = 0;
    const query = vi.fn(async (directory: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      if (directory.endsWith("0")) throw new Error("unavailable");
      return "/main";
    });
    const directories = Array.from({ length: 12 }, (_, index) => `/worktree-${index}`);
    const resolved = await new ProjectDirectoryResolver(query).resolveAll(directories);
    expect(maximum).toBe(4);
    expect(resolved.size).toBe(12);
    expect(resolved.get("/worktree-0")).toBe("/worktree-0");
    expect(resolved.get("/worktree-11")).toBe("/main");
  });

  it("refreshes expired directory metadata without decoding unchanged logs or invalidating timeline cursors", async () => {
    const home = await createTempDirectory("codex-project-refresh-");
    await mkdir(join(home, "sessions"));
    const path = join(home, "sessions/rollout-refresh.jsonl");
    await writeFile(path, [
      JSON.stringify({ type: "session_meta", payload: { id: "refresh", cwd: "/worktree" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "one" } }),
      "",
    ].join("\n"));
    let now = 0;
    const query = vi.fn<(directory: string) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue("/main");
    const source = new CodexSessionSource(
      home, "directory-refresh", undefined, undefined, undefined, undefined,
      new ProjectDirectoryResolver(query, () => now),
    );
    const reader = new SessionReadService([source], 0);
    const before = await source.refresh();
    const firstList = await reader.list({});
    const id = firstList.sessions[0]!.id;
    const page = (await reader.getItems(id, {}))!;
    expect(page.session.projectDirectory).toBe("/worktree");
    expect(await source.refresh()).toBe(before);

    // Appends reuse the directory cache but still perform incremental log decoding.
    await appendFile(path, `${JSON.stringify({
      type: "event_msg", payload: { type: "agent_message", message: "two" },
    })}\n`);
    const appended = await source.refresh();
    expect(source.lastRefreshTelemetry()).toMatchObject({ appendFiles: 1, fullFiles: 0 });
    expect(query).toHaveBeenCalledTimes(1);
    now = 30_000;
    const after = await source.refresh();
    expect(query).toHaveBeenCalledTimes(2);
    expect(after.signature).not.toBe(appended.signature);
    expect(after.sessions[0]!.normalized.timeline).toBe(appended.sessions[0]!.normalized.timeline);
    expect(source.lastRefreshTelemetry()).toMatchObject({ fullFiles: 0, appendFiles: 0, decodeBytes: 0 });
    expect(before.sessions[0]!.normalized.session.projectDirectory).toBe("/worktree");
    expect(after.sessions[0]!.normalized.session).toMatchObject({
      workingDirectory: "/worktree", projectDirectory: "/main",
    });
    expect(await source.refresh()).toBe(after);
    const next = (await reader.getItems(id, { cursor: page.cursor }))!;
    expect(next.session.projectDirectory).toBe("/main");
    expect(next.items).toHaveLength(1);
    expect((await reader.list({ project: "/main" })).total).toBe(1);
    expect((await reader.list({ project: "/worktree" })).total).toBe(0);
  });
});

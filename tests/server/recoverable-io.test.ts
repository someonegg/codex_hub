import type * as FsPromises from "node:fs/promises";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { CodexSessionSource } from "../../src/server/adapters/codex/codex-session-source.js";
import { CheckpointedRolloutDecoder } from "../../src/server/adapters/codex/rollout-decoder.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const faults = vi.hoisted(() => new Map<string, Error>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>();
  const wrap =
    (name: "realpath" | "stat" | "lstat" | "readdir" | "access") =>
    async (...args: unknown[]) => {
      const fault = faults.get(`${name}:${String(args[0])}`);
      if (fault) throw fault;
      return (fs[name] as (...args: unknown[]) => unknown)(...args);
    };
  return {
    ...fs,
    realpath: wrap("realpath"),
    stat: wrap("stat"),
    lstat: wrap("lstat"),
    readdir: wrap("readdir"),
    access: wrap("access"),
  };
});
afterEach(() => faults.clear());

const codes = ["ENOENT", "EACCES", "EPERM", "ESTALE", "EISDIR", "ENOTDIR"];
async function fixture() {
  const home = await realpath(await createTempDirectory("codex-io-faults-"));
  const sessions = join(home, "sessions");
  const archived = join(home, "archived_sessions");
  await mkdir(sessions);
  await mkdir(archived);
  const damaged = join(sessions, "rollout-damaged.jsonl");
  await writeFile(damaged, '{"type":"session_meta","payload":{"id":"damaged"}}\n');
  const healthy = join(archived, "rollout-healthy.jsonl");
  await writeFile(healthy, '{"type":"session_meta","payload":{"id":"healthy"}}\n');
  return { home, sessions, damaged, healthy };
}

it("skips all per-file checks for successfully cached archives", async () => {
  const { home, healthy } = await fixture();
  const source = new CodexSessionSource(home, "archive-checks");
  const initial = await source.refresh();
  for (const operation of ["lstat", "realpath", "stat", "access"]) {
    faults.set(`${operation}:${healthy}`, new Error(`Unexpected archived ${operation}`));
  }
  expect(await source.refresh()).toBe(initial);
  expect(source.lastRefreshTelemetry()).toMatchObject({ fullFiles: 0, appendFiles: 0 });
});

it.each(codes)("recovers from %s in path checks, scanning and rollout loading", async (code) => {
  const { home, sessions, damaged } = await fixture();
  const source = new CodexSessionSource(home, "test");
  expect((await source.refresh()).sessions).toHaveLength(2);
  for (const location of [
    `realpath:${sessions}`,
    `stat:${sessions}`,
    `readdir:${sessions}`,
    `lstat:${damaged}`,
    `realpath:${damaged}`,
    `stat:${damaged}`,
  ]) {
    faults.set(location, Object.assign(new Error("injected IO failure"), { code }));
    const partial = await source.refresh();
    expect(partial.sessions.map((entry) => entry.nativeSessionId)).toEqual(["healthy"]);
    expect(partial.diagnostics.length).toBeGreaterThan(0);
    faults.clear();
    expect((await source.refresh()).sessions).toHaveLength(2);
  }
  const decoder = new CheckpointedRolloutDecoder();
  let failed = true;
  const loading = new CodexSessionSource(home, "load", {
    async decode(descriptor, checkpoint) {
      if (failed && descriptor.canonicalPath === damaged)
        throw Object.assign(new Error("injected load failure"), { code });
      return decoder.decode(descriptor, checkpoint);
    },
  });
  const partial = await loading.refresh();
  expect(partial.sessions.map((entry) => entry.nativeSessionId)).toEqual(["healthy"]);
  expect(partial.diagnostics).toContainEqual(
    expect.objectContaining({ code: "rollout_unavailable" }),
  );
  failed = false;
  expect((await loading.refresh()).sessions).toHaveLength(2);
});

it.each(["realpath", "stat", "readdir", "lstat"])(
  "propagates unexpected %s failures",
  async (operation) => {
    const { home, sessions, damaged } = await fixture();
    const path = operation === "lstat" ? damaged : sessions;
    faults.set(`${operation}:${path}`, new Error("program invariant"));
    await expect(new CodexSessionSource(home, "test").refresh()).rejects.toThrow(
      "program invariant",
    );
  },
);

it("treats initially absent allowlisted directories as normal", async () => {
  const home = await createTempDirectory("codex-empty-io-");
  expect(await new CodexSessionSource(home, "test").refresh()).toMatchObject({
    sessions: [],
    diagnostics: [],
  });
});

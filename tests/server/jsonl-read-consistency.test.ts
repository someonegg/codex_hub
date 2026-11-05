import type * as FsPromises from "node:fs/promises";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createClaudeSessionSource } from "../../src/server/adapters/claude/claude-session-source.js";
import { CheckpointedRolloutDecoder } from "../../src/server/adapters/codex/rollout-decoder.js";
import { isExpectedIoError } from "../../src/server/adapters/shared/io-errors.js";
import { CheckpointedJsonlDecoder } from "../../src/server/adapters/shared/jsonl-decoder.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const hooks = vi.hoisted(() => ({
  afterStat: null as null | (() => Promise<void>),
  failure: null as null | { operation: string; error: Error },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>();
  return {
    ...fs,
    readdir: async (...args: Parameters<typeof fs.readdir>) => {
      if (
        hooks.failure?.operation === "readdir" ||
        (hooks.failure?.operation === "project" && String(args[0]).endsWith("/project"))
      )
        throw hooks.failure.error;
      return fs.readdir(...args);
    },
    stat: async (...args: Parameters<typeof fs.stat>) => {
      if (hooks.failure?.operation === "stat") throw hooks.failure.error;
      return fs.stat(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const originalStat = handle.stat.bind(handle);
      handle.stat = (async () => {
        const info = await originalStat();
        const hook = hooks.afterStat;
        hooks.afterStat = null;
        await hook?.();
        return info;
      }) as typeof handle.stat;
      return handle;
    },
  };
});

it.each([CheckpointedJsonlDecoder, CheckpointedRolloutDecoder])(
  "%s fixes EOF and uses the opened inode",
  async (Decoder) => {
    const home = await createTempDirectory("jsonl-eof-");
    const path = join(home, "log.jsonl");
    const first = '{"value":"first"}\n';
    const second = '{"value":"second"}\n';
    await writeFile(path, first);
    const descriptor = {
      path,
      id: "test",
      sourceRelativePath: "log.jsonl",
      archived: false,
      size: 0,
      mtimeMs: 0,
    };
    const decoder = new Decoder();
    hooks.afterStat = () => appendFile(path, second);
    const before = await decoder.decode(descriptor);
    expect(before.records.map((r) => r.value.value)).toEqual(["first"]);
    expect(before.checkpoint.observedEof).toBe(Buffer.byteLength(first));
    const after = await decoder.decode(descriptor, before.checkpoint);
    expect(after.records.map((r) => r.value.value)).toEqual(["second"]);
    hooks.afterStat = async () => {
      await rename(path, path + ".old");
      await writeFile(path, '{"value":"replacement with different length"}\n');
    };
    const replaced = await decoder.decode(descriptor);
    expect(replaced.records.map((r) => r.value.value)).toEqual(["first", "second"]);
    expect(replaced.checkpoint.observedEof).toBe(Buffer.byteLength(first + second));
    expect((await decoder.decode(descriptor)).records[0]?.value.value).toBe(
      "replacement with different length",
    );
  },
);

it.each(["ESTALE", "EISDIR", "ELOOP", "EACCES"])(
  "bounds Claude file and directory diagnostics for %s",
  async (code) => {
    const home = await createTempDirectory("claude-io-");
    await mkdir(join(home, "projects/project"), { recursive: true });
    await writeFile(
      join(home, "projects/project/11111111-2222-4333-8444-555555555555.jsonl"),
      "{}\n",
    );
    const source = await createClaudeSessionSource(home);
    const error = Object.assign(new Error(code), { code });
    expect(isExpectedIoError(error)).toBe(true);
    try {
      for (const [operation, diagnostic] of [
        ["stat", "rollout_unavailable"],
        ["project", "project_unavailable"],
        ["readdir", "source_unavailable"],
      ]) {
        hooks.failure = { operation, error };
        expect((await source.refresh()).diagnostics).toMatchObject([{ code: diagnostic }]);
      }
      const unexpected = Object.assign(new Error("unknown error"), { code: "UNKNOWN" });
      expect(isExpectedIoError(unexpected)).toBe(false);
      for (const operation of ["stat", "readdir"]) {
        hooks.failure = { operation, error: unexpected };
        await expect(source.refresh()).rejects.toThrow("unknown error");
      }
    } finally {
      hooks.failure = null;
    }
  },
);

import { appendFile, mkdir, rename, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createClaudeSessionSource } from "../../src/server/adapters/claude/claude-session-source.js";
import { createCodexSessionSource } from "../../src/server/adapters/codex/codex-session-source.js";
import { PaneBindingManager } from "../../src/server/interaction/pane-binding-manager.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const id = "11111111-2222-4333-8444-555555555555";
const line = (value: unknown) => JSON.stringify(value) + "\n";
const adapters = [
  {
    name: "Codex",
    create: createCodexSessionSource,
    file: "sessions/rollout-contract.jsonl",
    initial: line({ type: "session_meta", payload: { id, cwd: "/working", cli_version: "1.2" } }),
    title: (title: string) =>
      line({ type: "event_msg", payload: { type: "user_message", message: title } }),
  },
  {
    name: "Claude",
    create: createClaudeSessionSource,
    file: `projects/project/${id}.jsonl`,
    initial: line({ type: "system", sessionId: id, cwd: "/working", version: "1.2" }),
    title: (title: string) =>
      line({ type: "user", sessionId: id, message: { role: "user", content: title } }),
  },
];
it.each(adapters)(
  "$name reuses snapshots and ignores inode replacement with unchanged logical fingerprints",
  async (adapter) => {
    const home = await createTempDirectory("adapter-contract-");
    const path = join(home, adapter.file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, adapter.initial + adapter.title("first"));
    // Use an exactly representable timestamp for both original and replacement.
    await utimes(path, 1_700_000_000, 1_700_000_000);
    const source = await adapter.create(home, new PaneBindingManager());
    const before = await source.refresh();
    const serialized = JSON.stringify(before);
    expect(await source.refresh()).toBe(before);
    expect(source.lastRefreshTelemetry()).toMatchObject({
      fullFiles: 0,
      appendFiles: 0,
      probeBytes: 0,
      decodeBytes: 0,
    });
    const original = await stat(path);
    await rename(path, path + ".old");
    await writeFile(path, adapter.initial + adapter.title("other"));
    await utimes(path, original.atime, original.mtime);
    expect((await stat(path)).ino).not.toBe(original.ino);
    expect(await source.refresh()).toBe(before);
    expect(source.lastRefreshTelemetry()).toMatchObject({
      fullFiles: 0,
      appendFiles: 0,
      probeBytes: 0,
      decodeBytes: 0,
    });
    await utimes(path, 1_700_000_001, 1_700_000_001);
    const changed = await source.refresh();
    expect(changed).not.toBe(before);
    expect(changed.sessions[0]!.normalized.session.title).toBe("other");
    expect(source.lastRefreshTelemetry()).toMatchObject({
      fullFiles: 1,
      appendFiles: 0,
      probeBytes: 0,
    });
    const state = changed.sessions[0]!.normalized;
    // An unfinished line changes the checkpoint, but supplies no normalized evidence.
    await appendFile(path, " ");
    const tail = await source.refresh();
    expect(tail.sessions[0]!.normalized).toBe(state);
    expect(source.lastRefreshTelemetry()).toMatchObject({ fullFiles: 0, appendFiles: 1 });
    expect(JSON.stringify(before)).toBe(serialized);
  },
);

import {
  appendFile,
  cp,
  mkdir,
  rename,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CodexSessionSource,
  createCodexSessionSource,
} from "../../src/server/adapters/codex/codex-session-source.js";
import { JsonlCatalogSource } from "../../src/server/adapters/codex/jsonl-catalog-source.js";
import { DefaultSessionNormalizer } from "../../src/server/adapters/codex/session-normalizer.js";
import { CheckpointedJsonlDecoder } from "../../src/server/adapters/shared/jsonl-decoder.js";
import { SessionReadService } from "../../src/server/application/session-read-service.js";
import { rolloutDescriptor } from "../helpers/rollout-descriptor.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

describe("catalog discovery", () => {
  it("scans configured JSONL roots and filters rollout names", async () => {
    const agent = await createTempDirectory("codex-catalog-");
    await cp(resolve("tests/fixtures/codex-home"), agent, { recursive: true });
    await writeFile(join(agent, "sessions/not-a-rollout.jsonl"), "{}\n");
    await writeFile(join(agent, "rollout-outside-root.jsonl"), "{}\n");

    const discovery = await new JsonlCatalogSource(agent).discover();

    expect(discovery.entries).toHaveLength(4);
    expect(discovery.entries.filter((entry) => entry.descriptor.archived)).toHaveLength(1);
    expect(
      discovery.entries.every(
        (entry) =>
          entry.descriptor.path.includes("/sessions/") ||
          entry.descriptor.path.includes("/archived_sessions/"),
      ),
    ).toBe(true);
    expect(discovery.diagnostics).toEqual([]);
  });

  it("reads archives once while discovering additions, removals and restored sessions", async () => {
    const agent = await createTempDirectory("codex-archive-once-");
    const directory = join(agent, "archived_sessions");
    await mkdir(directory);
    await mkdir(join(agent, "sessions"));
    const file = join(directory, "rollout-first.jsonl");
    const content = (id: string) =>
      JSON.stringify({ type: "session_meta", payload: { id } }) + "\n";
    await writeFile(file, content("first"));
    const decoder = new CheckpointedJsonlDecoder();
    const decode = vi.fn(decoder.decode.bind(decoder));
    const source = new CodexSessionSource(agent, "archive-once", { decoder: { decode } });
    const first = await source.refresh();

    await writeFile(file, content("changed"));
    expect(await source.refresh()).toBe(first);
    expect(decode).toHaveBeenCalledTimes(1);

    const added = join(directory, "rollout-added.jsonl");
    await writeFile(added, content("added"));
    expect((await source.refresh()).sessions).toHaveLength(2);
    expect(decode).toHaveBeenCalledTimes(2);

    await unlink(added);
    expect((await source.refresh()).sessions).toHaveLength(1);
    expect(decode).toHaveBeenCalledTimes(2);

    await rename(file, join(agent, "sessions/rollout-first.jsonl"));
    const restored = await source.refresh();
    expect(restored.sessions).toHaveLength(1);
    expect(restored.sessions[0]!.normalized.session.archived).toBe(false);
    expect(restored.sessions[0]!.nativeSessionId).toBe("changed");
    expect(decode).toHaveBeenCalledTimes(3);
  });

  it("keys decoded rollouts by source-relative path using logical paths across root link changes", async () => {
    const base = await createTempDirectory("codex-adapter-cache-identity-");
    const agent = join(base, "agent");
    const firstRoot = join(base, "first-sessions");
    const secondRoot = join(base, "second-sessions");
    await mkdir(agent);
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const firstRollout = join(firstRoot, "rollout-stable.jsonl");
    const secondRollout = join(secondRoot, "rollout-stable.jsonl");
    await writeFile(
      firstRollout,
      '{"type":"session_meta","payload":{"id":"stable","title":"Stable"}}\n',
    );
    await cp(firstRollout, secondRollout);
    const cacheTimestamp = 1_800_000_000;
    await Promise.all([
      utimes(firstRollout, cacheTimestamp, cacheTimestamp),
      utimes(secondRollout, cacheTimestamp, cacheTimestamp),
    ]);
    const firstInfo = await stat(firstRollout);
    await writeFile(
      join(secondRoot, "rollout-new.jsonl"),
      '{"type":"session_meta","payload":{"id":"new","title":"New"}}\n',
    );
    const sessionsLink = join(agent, "sessions");
    await symlink(firstRoot, sessionsLink);

    const decoder = new CheckpointedJsonlDecoder();
    const decodedPaths: string[] = [];
    const source = new CodexSessionSource(agent, "codex-cache-identity", {
      decoder: {
        async decode(descriptor) {
          decodedPaths.push(descriptor.path);
          return decoder.decode(descriptor);
        },
      },
    });
    const first = await source.refresh();
    const firstDescriptor = await rolloutDescriptor(
      agent,
      join(sessionsLink, "rollout-stable.jsonl"),
    );

    const nextLink = join(agent, "next-sessions");
    await symlink(secondRoot, nextLink);
    await rename(nextLink, sessionsLink);
    const secondDescriptor = await rolloutDescriptor(
      agent,
      join(sessionsLink, "rollout-stable.jsonl"),
    );
    const second = await source.refresh();

    expect(firstDescriptor?.sourceRelativePath).toBe(secondDescriptor?.sourceRelativePath);
    expect(firstDescriptor?.path).toBe(join(sessionsLink, "rollout-stable.jsonl"));
    expect(secondDescriptor?.path).toBe(join(sessionsLink, "rollout-stable.jsonl"));
    expect(secondDescriptor?.path).toBe(firstDescriptor?.path);
    expect(await stat(secondRollout)).toMatchObject({
      size: firstInfo.size,
      mtimeMs: firstInfo.mtimeMs,
    });
    expect(decodedPaths.filter((path) => path.endsWith("rollout-stable.jsonl"))).toEqual([
      join(sessionsLink, "rollout-stable.jsonl"),
    ]);
    expect(decodedPaths.filter((path) => path.endsWith("rollout-new.jsonl"))).toEqual([
      join(sessionsLink, "rollout-new.jsonl"),
    ]);
    expect(first.sessions).toHaveLength(1);
    expect(second.sessions).toHaveLength(2);
  });

  it.each(["sessions", "archived_sessions"])(
    "hides unreadable %s rollouts and retries them",
    async (root) => {
      const agent = await createTempDirectory("codex-adapter-errors-");
      await mkdir(join(agent, root));
      await writeFile(
        join(agent, root, "rollout-error.jsonl"),
        '{"type":"session_meta","payload":{"id":"error"}}\n',
      );
      const decoder = new CheckpointedJsonlDecoder();
      let attempts = 0;
      const recovering = new CodexSessionSource(agent, "codex-errors", {
        decoder: {
          async decode(descriptor) {
            attempts += 1;
            if (attempts <= 2) {
              throw Object.assign(new Error("gone"), { code: "ENOENT" });
            }
            return decoder.decode(descriptor);
          },
        },
      });
      const unavailable = await recovering.refresh();
      expect(unavailable.sessions).toEqual([]);
      expect(unavailable.diagnostics).toEqual([
        expect.objectContaining({
          code: "rollout_unavailable",
          severity: "warning",
        }),
      ]);
      expect(JSON.stringify(unavailable.diagnostics)).not.toContain(agent);

      const repository = new SessionReadService([recovering]);
      await expect(repository.list()).resolves.toMatchObject({
        sessions: [],
      });

      await repository.refresh();
      await expect(repository.list()).resolves.toMatchObject({
        sessions: [expect.objectContaining({ id: expect.any(String) })],
      });
      const recovered = await recovering.refresh();
      expect(attempts).toBe(3);
      expect(recovered.sessions).toHaveLength(1);
      expect(recovered.diagnostics).toEqual([]);
      expect(recovered.signature).not.toBe(unavailable.signature);
    },
  );

  it("propagates unexpected decoder failures", async () => {
    const agent = await createTempDirectory("codex-adapter-broken-");
    await mkdir(join(agent, "sessions"));
    await writeFile(
      join(agent, "sessions/rollout-error.jsonl"),
      '{"type":"session_meta","payload":{"id":"error"}}\n',
    );
    const broken = new CodexSessionSource(agent, "codex-broken", {
      decoder: {
        async decode() {
          throw new Error("decoder invariant");
        },
      },
    });
    await expect(broken.refresh()).rejects.toThrow("decoder invariant");
  });

  it("keeps the prior source checkpoint after an incremental derivation failure", async () => {
    const agent = await createTempDirectory("codex-adapter-atomic-");
    await mkdir(join(agent, "sessions"));
    const path = join(agent, "sessions/rollout-atomic.jsonl");
    await writeFile(
      path,
      '{"type":"event_msg","payload":{"type":"agent_message","message":"one"}}\n',
    );
    const delegate = new DefaultSessionNormalizer();
    let failNextAppend = false;
    const normalizer: DefaultSessionNormalizer = Object.assign(
      Object.create(Object.getPrototypeOf(delegate)) as DefaultSessionNormalizer,
      delegate,
      {
        append: (...args: Parameters<DefaultSessionNormalizer["append"]>) => {
          if (failNextAppend) {
            failNextAppend = false;
            throw new Error("derived state failed");
          }
          return delegate.append(...args);
        },
      },
    );
    const source = new CodexSessionSource(agent, "codex-atomic", { normalizer });
    const first = await source.refresh();
    failNextAppend = true;
    await appendFile(
      path,
      '{"type":"event_msg","payload":{"type":"agent_message","message":"two"}}\n',
    );

    await expect(source.refresh()).rejects.toThrow("derived state failed");
    expect(first.sessions[0]!.normalized.timeline).toHaveLength(1);

    const recovered = await source.refresh();
    expect(recovered.sessions[0]!.normalized.timeline).toHaveLength(2);
    expect(source.lastRefreshTelemetry()).toMatchObject({ appendFiles: 1 });
  });

  it("ignores duplicate native IDs and exposes declared runtime versions", async () => {
    const agent = await createTempDirectory("codex-adapter-identities-");
    await mkdir(join(agent, "sessions"), { recursive: true });
    const metadata = (title: string) =>
      JSON.stringify({
        type: "session_meta",
        payload: { id: "duplicate", title, cli_version: "2.4.0" },
      }) + "\n";
    await writeFile(join(agent, "sessions/rollout-first.jsonl"), metadata("First"));
    await writeFile(join(agent, "sessions/rollout-second.jsonl"), metadata("Second"));
    await writeFile(
      join(agent, "sessions/rollout-no-id.jsonl"),
      '{"type":"session_meta","payload":{"title":"No ID"}}\n',
    );

    const snapshot = await new CodexSessionSource(agent, "codex-identities").refresh();
    expect(snapshot.sessions).toHaveLength(2);
    expect(new Set(snapshot.sessions.map((entry) => entry.localId)).size).toBe(2);
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "duplicate_native_session_id",
      }),
    );
    expect(
      snapshot.sessions.find((entry) => entry.nativeSessionId === "duplicate")?.origin,
    ).toMatchObject({ runtimeName: "Codex", runtimeVersion: "2.4.0" });
    expect(snapshot.sessions.find((entry) => entry.nativeSessionId === null)?.localId).toBe(
      "resource:sessions/rollout-no-id.jsonl",
    );
    expect(
      snapshot.sessions
        .filter((entry) => entry.nativeSessionId === "duplicate")
        .map((entry) => entry.localId)
        .sort(),
    ).toEqual(["thread:duplicate"]);
    expect(
      snapshot.sessions.find((entry) => entry.nativeSessionId === "duplicate")?.normalized.session
        .title,
    ).toBe("First");
  });

  it("keeps source identity stable when a symlinked Codex agent is created later", async () => {
    const base = await createTempDirectory("codex-adapter-identity-");
    const target = join(base, "target");
    const alias = join(base, "alias");
    const configuredAgent = join(alias, ".codex");
    await mkdir(target);
    await symlink(target, alias);

    const before = await createCodexSessionSource(configuredAgent);
    await mkdir(join(target, ".codex"));
    const after = await createCodexSessionSource(configuredAgent);

    expect(after.descriptor.instanceKey).toBe(before.descriptor.instanceKey);
    expect(after.descriptor.agent).toBe(before.descriptor.agent);
  });
});

it("returns an empty management snapshot after a known root disappears", async () => {
  const agent = await createTempDirectory("codex-management-roots-");
  await mkdir(join(agent, "sessions"));
  const source = await createCodexSessionSource(agent);
  const reader = new SessionReadService([source]);
  expect((await reader.managementSnapshot()).sessions).toEqual([]);
  await rename(join(agent, "sessions"), join(agent, "sessions-moved"));
  expect((await reader.managementSnapshot()).sessions).toEqual([]);
});
it("retains a rollout without a valid native identity for management validation", async () => {
  const agent = await createTempDirectory("codex-management-identity-");
  await mkdir(join(agent, "sessions"));
  await writeFile(join(agent, "sessions", "rollout-invalid.jsonl"), "invalid JSON\n");
  const source = await createCodexSessionSource(agent);
  expect(
    (await new SessionReadService([source]).managementSnapshot()).sessions[0]?.sourceId,
  ).toBeNull();
});

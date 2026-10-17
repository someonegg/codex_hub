import {
  appendFile,
  cp,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CodexSessionSource,
  createCodexSessionSource,
} from "../../src/server/adapters/codex/codex-session-source.js";
import { JsonlCatalogSource } from "../../src/server/adapters/codex/jsonl-catalog-source.js";
import { PathPolicy } from "../../src/server/adapters/codex/path-policy.js";
import { CheckpointedRolloutDecoder } from "../../src/server/adapters/codex/rollout-decoder.js";
import { DefaultSessionNormalizer } from "../../src/server/adapters/codex/session-normalizer.js";
import { SessionReadService } from "../../src/server/application/session-read-service.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

describe("catalog discovery", () => {
  it("scans only allowlisted JSONL roots", async () => {
    const home = await createTempDirectory("codex-catalog-");
    await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
    await writeFile(join(home, "sessions/not-a-rollout.jsonl"), "{}\n");
    await writeFile(join(home, "rollout-outside-root.jsonl"), "{}\n");
    const policy = await PathPolicy.create(home);

    const discovery = await new JsonlCatalogSource(policy).discover();

    expect(discovery.entries).toHaveLength(4);
    expect(discovery.entries.filter((entry) => entry.descriptor.archived)).toHaveLength(1);
    expect(
      discovery.entries.every(
        (entry) =>
          entry.descriptor.canonicalPath.includes("/sessions/") ||
          entry.descriptor.canonicalPath.includes("/archived_sessions/"),
      ),
    ).toBe(true);
    expect(discovery.diagnostics).toEqual([]);
  });

  it("degrades safely when allowlisted roots are absent or become unreadable", async () => {
    const emptyHome = await createTempDirectory("codex-catalog-empty-");
    const empty = await new JsonlCatalogSource(await PathPolicy.create(emptyHome)).discover();
    expect(empty).toEqual({ entries: [], diagnostics: [] });

    const changedHome = await createTempDirectory("codex-catalog-changed-");
    const sessions = join(changedHome, "sessions");
    await mkdir(sessions);
    const policy = await PathPolicy.create(changedHome);
    await rename(sessions, join(changedHome, "sessions-moved"));

    const changed = await new JsonlCatalogSource(policy).discover();
    expect(changed.entries).toEqual([]);
    expect(changed.diagnostics).toEqual([
      expect.objectContaining({
        code: "session_root_unreadable",
        severity: "warning",
      }),
    ]);
    expect(JSON.stringify(changed.diagnostics)).not.toContain(changedHome);
  });

  it("keys decoded rollouts by source-relative path rather than canonical path", async () => {
    const base = await createTempDirectory("codex-adapter-cache-identity-");
    const home = join(base, "home");
    const firstRoot = join(base, "first-sessions");
    const secondRoot = join(base, "second-sessions");
    await mkdir(home);
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
    const sessionsLink = join(home, "sessions");
    await symlink(firstRoot, sessionsLink);

    const decoder = new CheckpointedRolloutDecoder();
    const decodedPaths: string[] = [];
    const source = new CodexSessionSource(home, "codex-cache-identity", {
      async decode(descriptor) {
        decodedPaths.push(descriptor.canonicalPath);
        return decoder.decode(descriptor);
      },
    });
    const first = await source.refresh();
    const firstDescriptor = await (
      await PathPolicy.create(home)
    ).register(join(sessionsLink, "rollout-stable.jsonl"));

    const nextLink = join(home, "next-sessions");
    await symlink(secondRoot, nextLink);
    await rename(nextLink, sessionsLink);
    const secondDescriptor = await (
      await PathPolicy.create(home)
    ).register(join(sessionsLink, "rollout-stable.jsonl"));
    const second = await source.refresh();

    expect(firstDescriptor?.sourceRelativePath).toBe(secondDescriptor?.sourceRelativePath);
    expect(firstDescriptor?.canonicalPath).toBe(await realpath(firstRollout));
    expect(secondDescriptor?.canonicalPath).toBe(await realpath(secondRollout));
    expect(secondDescriptor?.canonicalPath).not.toBe(firstDescriptor?.canonicalPath);
    expect(await stat(secondRollout)).toMatchObject({
      size: firstInfo.size,
      mtimeMs: firstInfo.mtimeMs,
    });
    expect(decodedPaths.filter((path) => path.endsWith("rollout-stable.jsonl"))).toEqual([
      await realpath(firstRollout),
    ]);
    expect(decodedPaths.filter((path) => path.endsWith("rollout-new.jsonl"))).toEqual([
      await realpath(join(secondRoot, "rollout-new.jsonl")),
    ]);
    expect(first.sessions).toHaveLength(1);
    expect(second.sessions).toHaveLength(2);
  });

  it("hides unreadable rollouts and retries them", async () => {
    const home = await createTempDirectory("codex-adapter-errors-");
    await mkdir(join(home, "sessions"));
    await writeFile(
      join(home, "sessions/rollout-error.jsonl"),
      '{"type":"session_meta","payload":{"id":"error"}}\n',
    );
    const decoder = new CheckpointedRolloutDecoder();
    let attempts = 0;
    const recovering = new CodexSessionSource(home, "codex-errors", {
      async decode(descriptor) {
        attempts += 1;
        if (attempts <= 2) {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        }
        return decoder.decode(descriptor);
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
    expect(JSON.stringify(unavailable.diagnostics)).not.toContain(home);

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
  });

  it("propagates unexpected decoder failures", async () => {
    const home = await createTempDirectory("codex-adapter-broken-");
    await mkdir(join(home, "sessions"));
    await writeFile(
      join(home, "sessions/rollout-error.jsonl"),
      '{"type":"session_meta","payload":{"id":"error"}}\n',
    );
    const broken = new CodexSessionSource(home, "codex-broken", {
      async decode() {
        throw new Error("decoder invariant");
      },
    });
    await expect(broken.refresh()).rejects.toThrow("decoder invariant");
  });

  it("incrementally publishes appended records while preserving old normalized values", async () => {
    const home = await createTempDirectory("codex-adapter-append-");
    await mkdir(join(home, "sessions"));
    const path = join(home, "sessions/rollout-incremental.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "incremental", title: "Incremental" },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "inspect",
            call_id: "cross-refresh",
            arguments: "input",
          },
        }),
        "",
      ].join("\n"),
    );
    const source = new CodexSessionSource(home, "codex-append");

    const first = await source.refresh();
    const oldNormalized = first.sessions[0]!.normalized;
    const oldItem = oldNormalized.timeline[0]!;
    const oldDetail = oldNormalized.toolDetails.get(oldItem.id);
    await appendFile(
      path,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "cross-refresh",
          output: "result",
        },
      })}\n`,
    );

    const second = await source.refresh();
    const nextNormalized = second.sessions[0]!.normalized;
    expect(source.lastRefreshTelemetry()).toMatchObject({
      fullFiles: 0,
      appendFiles: 1,
    });
    expect(source.lastRefreshTelemetry().decodeBytes).toBeLessThan(
      Buffer.byteLength(await readFile(path)),
    );
    expect(nextNormalized.timeline).toHaveLength(2);
    expect(nextNormalized.timeline[0]).toBe(oldItem);
    expect(nextNormalized.toolDetails.get(oldItem.id)).toBe(oldDetail);
    expect(nextNormalized.timeline[1]).toMatchObject({
      kind: "tool",
      stage: "output",
      callId: "cross-refresh",
      toolName: "inspect",
    });
    expect(oldNormalized.timeline).toEqual([oldItem]);
    expect(oldNormalized.toolDetails.size).toBe(1);
  });

  it("keeps the prior source checkpoint after an incremental derivation failure", async () => {
    const home = await createTempDirectory("codex-adapter-atomic-");
    await mkdir(join(home, "sessions"));
    const path = join(home, "sessions/rollout-atomic.jsonl");
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
    const source = new CodexSessionSource(home, "codex-atomic", undefined, undefined, normalizer);
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

  it("disambiguates duplicate native IDs and exposes declared agent versions", async () => {
    const home = await createTempDirectory("codex-adapter-identities-");
    await mkdir(join(home, "sessions"), { recursive: true });
    const metadata = (title: string) =>
      JSON.stringify({
        type: "session_meta",
        payload: { id: "duplicate", title, cli_version: "2.4.0" },
      }) + "\n";
    await writeFile(join(home, "sessions/rollout-first.jsonl"), metadata("First"));
    await writeFile(join(home, "sessions/rollout-second.jsonl"), metadata("Second"));
    await writeFile(
      join(home, "sessions/rollout-no-id.jsonl"),
      '{"type":"session_meta","payload":{"title":"No ID"}}\n',
    );

    const snapshot = await new CodexSessionSource(home, "codex-identities").refresh();
    expect(snapshot.sessions).toHaveLength(3);
    expect(new Set(snapshot.sessions.map((entry) => entry.localId)).size).toBe(3);
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "duplicate_native_session_id",
      }),
    );
    expect(
      snapshot.sessions.find((entry) => entry.nativeSessionId === "duplicate")?.origin,
    ).toMatchObject({ agentName: "Codex", agentVersion: "2.4.0" });
    expect(snapshot.sessions.find((entry) => entry.nativeSessionId === null)?.localId).toBe(
      "resource:sessions/rollout-no-id.jsonl",
    );
    expect(
      snapshot.sessions
        .filter((entry) => entry.nativeSessionId === "duplicate")
        .map((entry) => entry.localId)
        .sort(),
    ).toEqual([
      "thread:duplicate\0resource:sessions/rollout-first.jsonl",
      "thread:duplicate\0resource:sessions/rollout-second.jsonl",
    ]);
  });

  it("keeps source identity stable when a symlinked Codex home is created later", async () => {
    const base = await createTempDirectory("codex-adapter-identity-");
    const target = join(base, "target");
    const alias = join(base, "alias");
    const configuredHome = join(alias, ".codex");
    await mkdir(target);
    await symlink(target, alias);

    const before = await createCodexSessionSource(configuredHome);
    await mkdir(join(target, ".codex"));
    const after = await createCodexSessionSource(configuredHome);

    expect(after.descriptor.instanceKey).toBe(before.descriptor.instanceKey);
    expect(after.descriptor.sourceInstanceId).toBe(before.descriptor.sourceInstanceId);
  });
});

it("returns an empty management snapshot after a known root disappears", async () => {
  const home = await createTempDirectory("codex-management-roots-");
  await mkdir(join(home, "sessions"));
  const source = await createCodexSessionSource(home);
  const reader = new SessionReadService([source]);
  expect((await reader.managementSnapshot()).sessions).toEqual([]);
  await rename(join(home, "sessions"), join(home, "sessions-moved"));
  expect((await reader.managementSnapshot()).sessions).toEqual([]);
});
it("retains a rollout without a valid native identity for management validation", async () => {
  const home = await createTempDirectory("codex-management-identity-");
  await mkdir(join(home, "sessions"));
  await writeFile(join(home, "sessions", "rollout-invalid.jsonl"), "invalid JSON\n");
  const source = await createCodexSessionSource(home);
  expect(
    (await new SessionReadService([source]).managementSnapshot()).sessions[0]?.sourceId,
  ).toBeNull();
});

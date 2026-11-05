import { cp, mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { codexInteraction } from "../../src/server/adapters/codex/interaction-parser.js";
import { CatalogInteractionSessionReader } from "../../src/server/application/interaction-session-reader.js";
import { SessionReadService } from "../../src/server/application/session-read-service.js";
import { SessionCatalogService } from "../../src/server/catalog/session-catalog-service.js";
import type {
  DomainTimelineRecord,
  NormalizedSession,
} from "../../src/server/domain/session-domain.js";
import { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import { PaneBindingManager } from "../../src/server/interaction/pane-binding-manager.js";
import { SessionRuntime } from "../../src/server/interaction/session-runtime.js";
import type { InteractionTransport } from "../../src/server/interaction/transport.js";
import { SessionManagerRegistry } from "../../src/server/management/session-manager.js";
import { CatalogSnapshotStore } from "../../src/server/repository/catalog-snapshot-store.js";
import type { SessionSource, SourceSessionEntry } from "../../src/server/source/session-source.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import { closeAfterEach } from "../helpers/cleanup.js";
import { createTempDirectory } from "../helpers/temp-directories.js";
import { createTestPreviewListener } from "../helpers/terminal-listener.js";
import { createCodexSessionReadService } from "./codex-read-helper.js";

async function fixtureRepository() {
  const home = await createTempDirectory("codex-repository-");
  await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
  return { home, repository: await createCodexSessionReadService(home) };
}

describe("SessionReadService", () => {
  it("preserves state revisions across reader instances without replaying history", async () => {
    const { home, repository } = await fixtureRepository();
    const session = (await repository.list()).sessions[0]!;
    const baseline = (await repository.messages(session.id, { after: 0, limit: 300 }))!;
    const restarted = await createCodexSessionReadService(home);
    const page = (await restarted.messages(session.id, { after: baseline.nextAfter }))!;
    expect(page.stateRevision).toBe(baseline.stateRevision);
    expect(page.items).toEqual([]);
    const updates = closeAfterEach(
      new SessionUpdatesService(restarted, { waitTimeoutMs: 30, probeIntervalMs: 5 }),
    );
    await expect(
      updates.wait(session.id, {
        after: baseline.nextAfter,
        stateRevision: baseline.stateRevision,
        wait: true,
      }),
    ).resolves.toBeNull();
  });

  it("coalesces concurrent refreshes, reuses a fresh snapshot, and permits a forced refresh", async () => {
    let discoveries = 0;
    let now = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const source: SessionSource = {
      descriptor: {
        sourceType: "test",
        instanceKey: "test",
        home: "test",
        displayName: "Test",
      },
      async refresh() {
        discoveries += 1;
        await gate;
        return { signature: "empty", sessions: [], diagnostics: [] };
      },
    };
    const repository = new SessionReadService([source], { now: () => now });

    const firstList = repository.list();
    const secondList = repository.list();
    release();
    expect((await firstList).revision).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await secondList).sessions).toEqual([]);
    expect(discoveries).toBe(1);
    await repository.list();
    expect(discoveries).toBe(1);
    now = 1_499;
    await repository.list();
    expect(discoveries).toBe(1);
    now = 1_500;
    await repository.list();
    expect(discoveries).toBe(2);
    await expect(repository.refresh()).resolves.toBeUndefined();
    expect(discoveries).toBe(3);
  });

  it("updates structural titles from session-index without invalidating timeline cursors", async () => {
    const { home, repository } = await fixtureRepository();
    const baseline = await repository.list();
    const basic = (await repository.list()).sessions.find(
      ({ title }) => title === "Synthetic trace",
    )!;
    const firstItems = await repository.messages(basic.id, { limit: 1 });

    await writeFile(
      join(home, "session_index.jsonl"),
      [
        JSON.stringify({ id: "basic-session", thread_name: "Old nickname" }),
        JSON.stringify({ id: "basic-session", thread_name: "Current nickname" }),
        JSON.stringify({ id: "basic-session", thread_name: "  " }),
        "{incomplete",
      ].join("\n"),
    );
    await repository.refresh();

    expect((await repository.list()).revision).not.toBe(baseline.revision);
    const renamed = (await repository.list()).sessions.find(({ id }) => id === basic.id);
    expect(renamed).toMatchObject({ title: "Current nickname" });

    const inspected = await repository.messages(basic.id, { limit: 1 });
    expect(inspected?.session.title).toBe("Current nickname");
    expect(inspected?.session).not.toHaveProperty("nickname");
    const detail = await repository.getSession(basic.id);
    expect(detail?.session).toMatchObject({
      title: "Current nickname",
    });
    expect(detail?.session).not.toHaveProperty("nickname");
    const continuedItems = await repository.messages(basic.id, {
      after: firstItems!.nextAfter,
      limit: 1,
    });
    expect(continuedItems?.session).toMatchObject({
      title: "Current nickname",
    });
    expect(continuedItems?.session).not.toHaveProperty("nickname");
    const updates = await repository.messages(basic.id, { after: firstItems!.nextAfter });
    expect(updates?.session).toMatchObject({
      title: "Current nickname",
    });
    expect(updates?.session).not.toHaveProperty("nickname");
  });

  it("discovers an archived root created after repository startup", async () => {
    const home = await createTempDirectory("codex-late-archive-");
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(
      join(home, "sessions/rollout-active.jsonl"),
      '{"timestamp":"2026-07-28T10:00:00.000Z","type":"session_meta","payload":{"id":"active-session","title":"Active trace"}}\n',
    );
    const repository = await createCodexSessionReadService(home);
    expect((await repository.list()).sessions).toHaveLength(1);

    await mkdir(join(home, "archived_sessions"), { recursive: true });
    await writeFile(
      join(home, "archived_sessions/rollout-archived.jsonl"),
      '{"timestamp":"2026-07-20T10:00:00.000Z","type":"session_meta","payload":{"id":"archived-session","title":"Late archive"}}\n',
    );
    await repository.refresh();

    const sessions = await repository.list();
    expect(sessions.sessions).toHaveLength(2);
    expect(sessions.sessions.find(({ status }) => status === "archived")?.title).toBe(
      "Late archive",
    );
  });

  it("keeps a native Codex session identity stable when its rollout moves", async () => {
    const { home, repository } = await fixtureRepository();
    const before = await repository.list();
    const session = before.sessions.find((session) => session.title === "Synthetic trace")!;
    const original = join(
      home,
      "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl",
    );
    const archiveDirectory = join(home, "archived_sessions/reorganized");
    await mkdir(archiveDirectory, { recursive: true });
    await rename(original, join(archiveDirectory, "rollout-moved-basic-session.jsonl"));

    await repository.refresh();
    const after = await repository.list();
    const moved = after.sessions.find((session) => session.title === "Synthetic trace")!;
    expect(moved.id).toBe(session.id);
    expect(moved.status).toBe("archived");
  });

  it("returns every catalog record without truncation", async () => {
    const entries = Array.from({ length: 305 }, (_, index) =>
      sourceEntry(
        `thread-${index}`,
        normalizedSession(
          `thread-${index}`,
          `Session ${String(index).padStart(3, "0")}`,
          "/synthetic/large-catalog",
          [],
          new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        ),
      ),
    );
    const repository = new SessionReadService([staticSource("large", entries)]);

    const first = await repository.list();
    expect(first.sessions).toHaveLength(305);
    expect(new Set(first.sessions.map((session) => session.id)).size).toBe(305);
    expect(Object.keys(first).sort()).toEqual(["homes", "projects", "revision", "sessions"]);
  });

  it("maps public identity and passes cursors across consecutive reads", async () => {
    const timeline: DomainTimelineRecord[] = [1, 2, 3].map((ordinal) => ({
      kind: "message",
      id: `message-${ordinal}`,
      ordinal,
      timestamp: null,
      role: "assistant",
      phase: "update",
      itemType: null,
      markdown: `Message ${ordinal}`,
    }));
    const repository = new SessionReadService([
      staticSource("small", [
        sourceEntry("native", normalizedSession("native", "Small session", null, timeline)),
      ]),
    ]);
    const session = (await repository.list()).sessions[0]!;
    expect(session.id).not.toBe("native");
    const first = (await repository.messages(session.id, { after: 0, limit: 2 }))!;
    expect(first.session.id).toBe(session.id);
    expect(first.items).toEqual(timeline.slice(0, 2));
    expect(first.hasMore).toBe(true);
    const tail = (await repository.messages(session.id, { after: first.nextAfter }))!;
    expect(tail.session.id).toBe(session.id);
    expect(tail.items).toEqual([timeline[2]]);
    expect(tail.hasMore).toBe(false);
  });
});

const TEST_ORIGIN = {
  sourceType: "test",
  home: "test-source",
  agentName: "Test",
  agentVersion: null,
  formatVersion: null,
} as const;

function normalizedSession(
  id: string,
  title: string,
  cwd: string | null,
  timeline: readonly DomainTimelineRecord[],
  timestamp = "2026-01-01T00:00:00Z",
): NormalizedSession {
  return {
    session: {
      id,
      sourceId: id,
      origin: TEST_ORIGIN,
      title,
      workingDirectory: cwd,
      projectDirectory: cwd,
      createdAt: timestamp,
      updatedAt: timestamp,
      archived: false,
      parentId: null,
      childIds: [],
      agent: null,
      warningCount: 0,
      diagnostics: [],
    },
    timeline,
  };
}

function sourceEntry(
  localId: string,
  normalized: NormalizedSession,
  parentNativeSessionId: string | null = null,
): SourceSessionEntry {
  return {
    localId,
    nativeSessionId: localId,
    parentNativeSessionId,
    origin: TEST_ORIGIN,
    normalized,
  };
}

function staticSource(key: string, sessions: readonly SourceSessionEntry[]): SessionSource {
  return {
    descriptor: {
      sourceType: "test",
      instanceKey: key,
      home: key,
      displayName: "Test",
    },
    async refresh() {
      return { signature: key, sessions, diagnostics: [] };
    },
  };
}

describe("catalog structure and updatedAt isolation", () => {
  it("isolates updatedAt, body and diagnostics from structure, preserving canonical order", async () => {
    let entries = [
      sourceEntry("one", normalizedSession("one", "One", "/project", [])),
      sourceEntry("two", normalizedSession("two", "Two", "/project", [])),
    ];
    let generation = 0;
    const repository = new SessionReadService([
      {
        ...staticSource("isolation", []),
        async refresh() {
          return { signature: String(generation), sessions: entries, diagnostics: [] };
        },
      },
    ]);
    const first = await repository.list();
    const baseline = (await repository.messages(first.sessions[0]!.id, { after: 0 }))!;
    entries = entries.reverse().map((entry) => ({
      ...entry,
      normalized: {
        ...entry.normalized,
        session: {
          ...entry.normalized.session,
          updatedAt: "2030-01-01T00:00:00Z",
          diagnostics: [
            { code: "warning", severity: "warning", message: "warning", ordinal: null },
          ],
        },
      },
    }));
    generation++;
    await repository.refresh();
    const updated = await repository.list();
    expect(updated.revision).toBe(first.revision);
    expect(updated.sessions.map(({ updatedAt, ...session }) => session)).toEqual(
      first.sessions.map(({ updatedAt, ...session }) => session),
    );
    expect(updated.sessions.every((session) => session.updatedAt === "2030-01-01T00:00:00Z")).toBe(
      true,
    );
    const page = (await repository.messages(baseline.session.id, { after: 0 }))!;
    expect(page.session.updatedAt).toBe("2030-01-01T00:00:00Z");
    expect(page.stateRevision).toBe(baseline.stateRevision);
    const updates = closeAfterEach(
      new SessionUpdatesService(repository, { waitTimeoutMs: 30, probeIntervalMs: 5 }),
    );
    await expect(
      updates.wait(baseline.session.id, {
        after: baseline.nextAfter,
        stateRevision: baseline.stateRevision,
        wait: true,
      }),
    ).resolves.toBeNull();
    entries = entries.map((entry) => ({
      ...entry,
      normalized: { ...entry.normalized, session: { ...entry.normalized.session, archived: true } },
    }));
    generation++;
    await repository.refresh();
    expect((await repository.list()).revision).not.toBe(first.revision);
    expect((await repository.getSession(baseline.session.id))!.stateRevision).not.toBe(
      baseline.stateRevision,
    );
  });
});

it("pushes runtime status and resume changes without a source revision or JSONL change", async () => {
  const nativeId = "00000000-0000-4000-8000-000000000001";
  const source = staticSource("runtime-source", [
    sourceEntry(nativeId, {
      ...normalizedSession(nativeId, "Runtime", "/project", []),
      interaction: codexInteraction(),
    }),
  ]);
  const bootstrapReader = new SessionReadService([source]);
  const initial = (await bootstrapReader.list()).sessions[0]!;
  const domain = (await bootstrapReader.managementSnapshot()).sessions[0]!;
  const bindings = new PaneBindingManager();
  const pane = { socketPath: "/tmp/runtime.sock", paneId: "%1", sessionName: "runtime" };
  bindings.submit({
    sessionId: initial.id,
    time: 1,
    ordinal: 1,
    position: 0,
    attempt: { valid: true, ordinal: 1, ...pane },
  });
  const resolveTarget = vi.fn<InteractionTransport["resolveTarget"]>().mockResolvedValue(pane);
  const transport = { resolveTarget } as unknown as InteractionTransport;
  const resolveDirectory = vi.fn(async () => ({ directory: "/project" }));
  const registry = new SessionManagerRegistry(domain.origin.home).register(domain.origin.home, {
    isValidNativeId: vi.fn((_nativeId: string) => true),
    resolveDirectory,
    launch: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
    exitSteps: () => [],
  });
  const runtime = new SessionRuntime(transport, registry, bindings);
  const store = new CatalogSnapshotStore([source]);
  const interaction = closeAfterEach(
    new SessionInteractionService(new CatalogInteractionSessionReader(store), transport, {
      enabled: true,
      bindings,
      listener: createTestPreviewListener(),
      runtime,
    }),
  );

  const reader = new SessionReadService([source], { store, runtime, interaction });
  const catalog = new SessionCatalogService(reader);

  const updates = new SessionUpdatesService(reader, { probeIntervalMs: 2 });
  try {
    const live = await reader.list();
    const page = (await reader.messages(initial.id, {}))!;
    expect(live.sessions[0]!.status).toBe("live");
    expect(page.session.status).toBe("live");
    const baseline = (await updates.wait(initial.id, {
      after: page.nextAfter,
      stateRevision: "different" as never,
    }))!;
    const changedCatalog = catalog.wait(live.revision);
    const changedDetail = updates.wait(initial.id, {
      after: page.nextAfter,
      wait: true,
      stateRevision: baseline.stateRevision,
    });
    resolveTarget.mockResolvedValue(null);
    const normal = (await changedDetail)!;
    expect(normal.session).toMatchObject({
      status: "normal",
      resume: { allowed: true, reason: null },
    });
    expect((await changedCatalog)!.sessions[0]!.status).toBe("normal");
    expect((await reader.getSession(initial.id))!.session.status).toBe("normal");
    resolveTarget.mockRejectedValue(new Error("timeout"));
    const failed = (await updates.wait(initial.id, {
      after: page.nextAfter,
      wait: true,
      stateRevision: normal.stateRevision,
    }))!;
    expect(failed.interaction).toMatchObject({ state: "unknown" });
    expect(failed.session).toMatchObject({ status: "normal", resume: { allowed: false } });
    resolveTarget.mockResolvedValue(null);
    resolveDirectory.mockRejectedValue(new Error("directory disappeared"));
    expect((await reader.getSession(initial.id))!.session.resume.allowed).toBe(false);
  } finally {
    updates.close();
    catalog.close();
  }
});

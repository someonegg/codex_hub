import { appendFile, cp, mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { codexInteraction } from "../../src/server/adapters/codex/interaction-parser.js";
import { SessionReadService } from "../../src/server/application/session-read-service.js";
import { SessionCatalogService } from "../../src/server/catalog/session-catalog-service.js";
import { createCodexSessionReadService } from "../../src/server/create-hub.js";
import type {
  DomainTimelineRecord,
  NormalizedSession,
} from "../../src/server/domain/session-domain.js";
import { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import { PaneBindingManager } from "../../src/server/interaction/pane-binding-manager.js";
import { SessionRuntime } from "../../src/server/interaction/session-runtime.js";
import type { InteractionTransport } from "../../src/server/interaction/transport.js";
import { SessionManagerRegistry } from "../../src/server/management/session-manager.js";
import { MAX_ITEM_PAGE_BYTES } from "../../src/server/repository/session-queries.js";
import type { SessionSource, SourceSessionEntry } from "../../src/server/source/session-source.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import type { TimelineCursor } from "../../src/shared/api-contract.js";
import { closeAfterEach } from "../helpers/cleanup.js";
import { createTempDirectory } from "../helpers/temp-directories.js";
import { createTestPreviewListener } from "../helpers/terminal-listener.js";

async function fixtureRepository() {
  const home = await createTempDirectory("codex-repository-");
  await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
  return { home, repository: await createCodexSessionReadService(home) };
}

async function basicFixtureSession() {
  const { home, repository } = await fixtureRepository();
  const catalogSessions = (await repository.list()).sessions;
  const session = catalogSessions.find(({ title }) => title === "Synthetic trace");
  if (session === undefined) throw new Error("Expected the basic fixture session");
  const rollout = join(home, "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl");
  return { catalogSessions, home, repository, rollout, session };
}

describe("SessionReadService", () => {
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
        sourceInstanceId: "test",
        displayName: "Test",
      },
      async refresh() {
        discoveries += 1;
        await gate;
        return { signature: "empty", sessions: [], diagnostics: [] };
      },
    };
    const repository = new SessionReadService([source], undefined, () => now);

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
    const firstItems = await repository.getItems(basic.id, { limit: 1 });

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

    const detail = await repository.getSession(basic.id);
    expect(detail?.session).toMatchObject({
      title: "Synthetic trace",
      nickname: "Current nickname",
    });
    const continuedItems = await repository.getItems(basic.id, {
      cursor: firstItems!.cursor,
      limit: 1,
    });
    expect(continuedItems?.session).toMatchObject({
      title: "Synthetic trace",
      nickname: "Current nickname",
    });
    const updates = await repository.getSessionUpdates(basic.id, firstItems!.cursor);
    expect(updates?.session).toMatchObject({
      title: "Synthetic trace",
      nickname: "Current nickname",
    });
  });

  it("publishes linked summaries and pages timeline details", async () => {
    const { catalogSessions, repository, session: parent } = await basicFixtureSession();
    const child = catalogSessions.find((session) => session.parentId === parent.id)!;
    expect(child.parentId).toBe(parent.id);
    expect(child.isChild).toBe(true);
    expect((await repository.getSession(parent.id))?.session.childIds).toContain(child.id);

    const page = await repository.getItems(parent.id, {
      limit: 2,
    });
    expect(page?.hasMore).toBe(true);
    await expect(
      repository.getItems(parent.id, {
        cursor: page!.cursor,
        limit: 2,
      }),
    ).resolves.not.toBeNull();
    const allItems = await repository.getItems(parent.id, {
      limit: 200,
    });
    const directive = allItems!.items.find((item) => item.id === "directive-4")!;
    expect(JSON.stringify(allItems)).not.toContain("DIRECTIVE_DETAIL_CANARY");
    expect(
      await repository.getDirectiveDetail(parent.id, directive.id, {
        cursor: allItems!.cursor,
      }),
    ).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("DIRECTIVE_DETAIL_CANARY"),
        truncated: false,
      }),
    );
    const internal = allItems!.items.find((item) => item.id === "internal-6")!;
    expect(allItems).not.toHaveProperty("internalDetails");
    expect(JSON.stringify(allItems)).not.toContain("REASONING_CANARY_NEVER_RENDER");
    expect(
      await repository.getInternalDetail(parent.id, internal.id, {
        cursor: allItems!.cursor,
      }),
    ).toEqual(
      expect.objectContaining({
        json: expect.stringContaining("REASONING_CANARY_NEVER_RENDER"),
        truncated: false,
      }),
    );
    await expect(
      repository.getInternalDetail(parent.id, internal.id, {
        cursor: page!.cursor,
      }),
    ).rejects.toMatchObject({ code: "invalid_query" });
    await expect(
      repository.getInternalDetail(parent.id, directive.id, {
        cursor: allItems!.cursor,
      }),
    ).resolves.toBeNull();
  });

  it("does not revise a session until an appended JSONL tail is terminated", async () => {
    const home = await createTempDirectory("codex-silent-tail-");
    const directory = join(home, "sessions");
    await mkdir(directory, { recursive: true });
    const rollout = join(directory, "rollout-silent-tail.jsonl");
    await writeFile(
      rollout,
      '{"timestamp":"2026-07-28T10:00:00Z","type":"session_meta","payload":{"id":"silent-tail","title":"Silent tail"}}\n',
    );
    const repository = await createCodexSessionReadService(home);
    const sessionId = (await repository.list()).sessions[0]!.id;
    const before = await repository.getSession(sessionId);
    const beforePage = await repository.getItems(sessionId, {});

    await appendFile(
      rollout,
      '{"timestamp":"2026-07-28T10:00:01Z","type":"response_item","payload":{"type":"function_call","name":"pending","arguments":"input","call_id":"tail-call"}}',
    );
    await repository.refresh();
    const pending = await repository.getSession(sessionId);
    expect(pending!.session).toEqual(before!.session);
    await expect(repository.getItems(sessionId, { cursor: beforePage!.cursor })).resolves.toEqual(
      expect.objectContaining({ items: [] }),
    );

    await appendFile(rollout, "\n");
    await repository.refresh();
    const committed = await repository.getSession(sessionId);
    expect(committed!.session).toMatchObject({ toolCount: 1, itemCount: 1 });
    await expect(repository.getItems(sessionId, { cursor: beforePage!.cursor })).resolves.toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ kind: "tool" })],
      }),
    );
  });

  it("keeps session A reader requests valid while only session B changes", async () => {
    const sessionA = normalizedSession("session-a", "Session A", null, [
      {
        kind: "message",
        id: "message-1",
        ordinal: 1,
        timestamp: null,
        role: "user",
        phase: null,
        itemType: null,
        markdown: "first",
      },
      {
        kind: "directive",
        id: "directive-2",
        ordinal: 2,
        timestamp: null,
        summary: "detail",
        charCount: 6,
        hasDetail: true,
      },
      {
        kind: "message",
        id: "message-3",
        ordinal: 3,
        timestamp: null,
        role: "assistant",
        phase: "final",
        itemType: null,
        markdown: "later",
      },
    ]);
    let sessionAWithDetail: NormalizedSession = {
      ...sessionA,
      directiveDetails: new Map([["directive-2", { text: "secret", truncated: false }]]),
    };
    let sourceSignature = "initial";
    let sessionB = normalizedSession("session-b", "Session B", null, []);
    const source: SessionSource = {
      ...staticSource("mutable", []),
      async refresh() {
        return {
          signature: sourceSignature,
          sessions: [
            sourceEntry("session-a", sessionAWithDetail),
            sourceEntry("session-b", sessionB),
          ],
          diagnostics: [],
        };
      },
    };
    const repository = new SessionReadService([source]);
    const list = await repository.list();
    const sessionAId = list.sessions.find((session) => session.title === "Session A")!.id;
    const first = await repository.getItems(sessionAId, {
      limit: 2,
    });
    const directive = first!.items.find((item) => item.kind === "directive")!;

    for (const change of ["changed-once", "changed-twice"]) {
      sourceSignature = `session-b-${change}`;
      sessionB = normalizedSession("session-b", `Session B ${change}`, null, []);
      await repository.refresh();
      expect((await repository.getSession(sessionAId))?.session.title).toBe("Session A");
    }

    await expect(
      repository.getItems(sessionAId, {
        cursor: first!.cursor,
        limit: 2,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ id: "message-3" })],
      }),
    );
    await expect(
      repository.getDirectiveDetail(sessionAId, directive.id, {
        cursor: first!.cursor,
      }),
    ).resolves.toEqual(expect.objectContaining({ text: "secret" }));

    const currentList = await repository.list();
    const sessionBId = currentList.sessions.find(
      (session) => session.title === "Session B changed-twice",
    )!.id;
    const sessionBPage = await repository.getItems(sessionBId, {});
    sessionAWithDetail = {
      ...sessionAWithDetail,
      session: { ...sessionAWithDetail.session, title: "Session A changed" },
    };
    sourceSignature = "session-a-changed";
    await repository.refresh();

    await expect(
      repository.getItems(sessionAId, {
        cursor: first!.cursor,
        limit: 2,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        session: expect.objectContaining({ title: "Session A changed" }),
      }),
    );
    await expect(
      repository.getItems(sessionBId, {
        cursor: sessionBPage!.cursor,
        limit: 2,
      }),
    ).resolves.toEqual(expect.objectContaining({ items: [] }));
  });

  it("defaults to 100 items, supports 300, and rejects limits above 300", async () => {
    const timeline: DomainTimelineRecord[] = Array.from({ length: 301 }, (_, index) => ({
      kind: "message",
      id: `message-${index + 1}`,
      ordinal: index + 1,
      timestamp: "2026-07-28T00:00:00Z",
      role: "assistant",
      phase: "commentary",
      itemType: null,
      markdown: `Message ${index + 1}`,
    }));
    const repository = new SessionReadService([
      staticSource("timeline-default", [
        sourceEntry(
          "timeline-default",
          normalizedSession("timeline-default", "Timeline default", null, timeline),
        ),
      ]),
    ]);
    const session = (await repository.list()).sessions[0]!;
    const page = await repository.getItems(session.id, {});

    expect(page?.items).toHaveLength(100);
    expect(page?.hasMore).toBe(true);
    const maximum = (await repository.getItems(session.id, { limit: 300 }))!;
    expect(maximum.items).toHaveLength(300);
    expect(maximum.hasMore).toBe(true);
    const tail = (await repository.getItems(session.id, { cursor: maximum.cursor }))!;
    expect(tail.items).toEqual([timeline[300]]);
    expect(tail.hasMore).toBe(false);
    await expect(repository.getItems(session.id, { limit: 301 })).rejects.toMatchObject({
      code: "invalid_query",
    });
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

  it("fills byte-bounded pages and reads every long message exactly once", async () => {
    const longText = "x".repeat(1_000_000);
    const timeline: DomainTimelineRecord[] = Array.from({ length: 10 }, (_, index) => ({
      kind: "message",
      id: `message-${index + 1}`,
      ordinal: index + 1,
      timestamp: "2026-07-28T00:00:00Z",
      role: "assistant",
      phase: "commentary",
      itemType: null,
      markdown: longText,
    }));
    const repository = new SessionReadService([
      staticSource("long", [
        sourceEntry(
          "long-session",
          normalizedSession("long-session", "Long session", null, timeline),
        ),
      ]),
    ]);

    const list = await repository.list();
    const sessionId = list.sessions[0]!.id;
    const ids: string[] = [];
    let cursor: TimelineCursor | undefined;
    // Four million-character messages fit under 4 MiB; a fifth does not.
    for (const [index, count] of [4, 4, 2].entries()) {
      const page = await repository.getItems(sessionId, { limit: 200, cursor });
      expect(page).not.toBeNull();
      expect(page!.items).toHaveLength(count);
      expect(page!.hasMore).toBe(index < 2);
      expect(page!.cursor).toEqual(expect.any(String));
      expect(page!.cursor).not.toBe(cursor);
      expect(Buffer.byteLength(JSON.stringify(page!.items), "utf8")).toBeLessThanOrEqual(
        MAX_ITEM_PAGE_BYTES + 2,
      );
      ids.push(...page!.items.map((item) => item.id));
      cursor = page!.cursor;
    }
    expect(ids).toEqual(timeline.map((item) => item.id));
  });
});

const TEST_ORIGIN = {
  sourceType: "test",
  sourceInstanceId: "test-source",
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
      messageCount: timeline.filter((item) => item.kind === "message").length,
      toolCount: timeline.filter((item) => item.kind === "tool" && item.stage === "call").length,
      warningCount: 0,
      diagnostics: [],
      itemCount: timeline.length,
    },
    timeline,
    toolDetails: new Map(),
    directiveDetails: new Map(),
    internalDetails: new Map(),
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
      sourceInstanceId: key,
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
    entries = entries.reverse().map((entry) => ({
      ...entry,
      normalized: {
        ...entry.normalized,
        session: {
          ...entry.normalized.session,
          updatedAt: "2030-01-01T00:00:00Z",
          messageCount: 42,
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
    entries = entries.map((entry) => ({
      ...entry,
      normalized: { ...entry.normalized, session: { ...entry.normalized.session, archived: true } },
    }));
    generation++;
    await repository.refresh();
    expect((await repository.list()).revision).not.toBe(first.revision);
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
  const reader = new SessionReadService([source]);
  const initial = (await reader.list()).sessions[0]!;
  const domain = (await reader.managementSnapshot()).sessions[0]!;
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
  const registry = new SessionManagerRegistry(domain.origin.sourceInstanceId).register(
    domain.origin.sourceInstanceId,
    {
      isValidNativeId: vi.fn((_nativeId: string) => true),
      resolveDirectory,
      launch: vi.fn(),
      archive: vi.fn(),
      delete: vi.fn(),
      exitSteps: () => [],
    },
  );
  const runtime = new SessionRuntime(transport, registry, bindings);
  reader.runtime = runtime;
  const interaction = closeAfterEach(
    new SessionInteractionService(reader, true, transport, bindings, createTestPreviewListener()),
  );
  interaction.runtime = runtime;
  const catalog = new SessionCatalogService(reader);
  const updates = new SessionUpdatesService(reader, { interaction, probeIntervalMs: 2 });
  try {
    const live = await reader.list();
    const page = (await reader.getItems(initial.id, {}))!;
    expect(live.sessions[0]!.status).toBe("live");
    expect(page.session.status).toBe("live");
    const baseline = (await updates.wait(initial.id, {
      cursor: page.cursor,
      after: "different" as never,
    }))!;
    const changedCatalog = catalog.wait(live.revision);
    const changedDetail = updates.wait(initial.id, {
      cursor: page.cursor,
      after: baseline.updateRevision,
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
      cursor: page.cursor,
      after: normal.updateRevision,
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

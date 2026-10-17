import { describe, expect, it, vi } from "vitest";

import { CODEX_INTERACTION_KEY_BINDINGS } from "../../src/server/adapters/codex/interaction-parser.js";
import type {
  LiveSessionSnapshot,
  SessionReader,
} from "../../src/server/application/session-reader.js";
import {
  createProcessLiveRevisionFactory,
  withLiveRevision,
} from "../../src/server/live/live-revision.js";
import { SessionLiveService } from "../../src/server/live/session-live-service.js";
import type { LiveRevision, TimelineCursor } from "../../src/shared/api-contract.js";
import type { SessionDetail } from "../../src/shared/domain.js";

const CURSOR = "opaque.timeline.cursor" as TimelineCursor;
const REVISION = "a".repeat(43) as LiveRevision;
const OTHER_REVISION = "b".repeat(43) as LiveRevision;

describe("SessionLiveService", () => {
  it("creates stable revisions that cover public session and effective interaction state", () => {
    const createRevision = createProcessLiveRevisionFactory(Buffer.alloc(32, 7));
    const revision = (
      session: SessionDetail,
      interaction: Parameters<typeof withLiveRevision>[0]["interaction"],
    ) => withLiveRevision({ session, interaction }, createRevision).liveRevision;
    const first = revision(SESSION, { supported: false, attachCommand: null });
    expect(revision({ ...SESSION }, { supported: false, attachCommand: null })).toBe(first);
    expect(
      revision(
        { ...SESSION, nickname: "Presentation only" },
        { supported: false, attachCommand: null },
      ),
    ).toBe(first);
    expect(
      revision({ ...SESSION, title: "Changed" }, { supported: false, attachCommand: null }),
    ).not.toBe(first);
    expect(
      revision(SESSION, {
        supported: true,
        attachCommand: null,
        state: "connected",
      }),
    ).not.toBe(first);
  });

  it("returns immediately for a changed revision or timeline backlog", async () => {
    const getLiveSession = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getLiveSession);
    await expect(
      service.wait("session", { cursor: CURSOR, after: OTHER_REVISION }),
    ).resolves.toMatchObject({ cursor: CURSOR, liveRevision: REVISION });

    getLiveSession.mockResolvedValue(snapshot(true));
    await expect(
      service.wait("session", { cursor: CURSOR, after: REVISION }),
    ).resolves.toMatchObject({ hasMore: true });
  });

  it("repeats empty probes and returns null at the bounded timeout", async () => {
    const getLiveSession = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getLiveSession, { probeIntervalMs: 3, waitTimeoutMs: 12 });
    await expect(service.wait("session", { cursor: CURSOR, after: REVISION })).resolves.toBeNull();
    expect(getLiveSession.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("enforces the process-wide waiter limit across sessions", async () => {
    const getLiveSession = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getLiveSession, {
      probeIntervalMs: 1_000,
      waitTimeoutMs: 5_000,
      maxWaiters: 1,
      maxWaitersPerSession: 2,
    });
    const abort = new AbortController();
    const first = service.wait("session-one", { cursor: CURSOR, after: REVISION }, abort.signal);
    await vi.waitFor(() => expect(getLiveSession).toHaveBeenCalledTimes(1));
    await expect(
      service.wait("session-two", { cursor: CURSOR, after: REVISION }),
    ).rejects.toMatchObject({ code: "live_capacity_exceeded" });
    abort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
  });

  it("enforces the per-session waiter limit below process capacity", async () => {
    const getLiveSession = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getLiveSession, {
      probeIntervalMs: 1_000,
      waitTimeoutMs: 5_000,
      maxWaiters: 2,
      maxWaitersPerSession: 1,
    });
    const abort = new AbortController();
    const first = service.wait("session", { cursor: CURSOR, after: REVISION }, abort.signal);
    await vi.waitFor(() => expect(getLiveSession).toHaveBeenCalledTimes(1));
    await expect(
      service.wait("session", { cursor: CURSOR, after: REVISION }),
    ).rejects.toMatchObject({ code: "live_capacity_exceeded" });
    abort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
  });

  it("releases waiters on external cancellation and service close", async () => {
    const getLiveSession = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getLiveSession, { probeIntervalMs: 1_000, waitTimeoutMs: 5_000 });
    const firstAbort = new AbortController();
    const first = service.wait("one", { cursor: CURSOR, after: REVISION }, firstAbort.signal);
    await vi.waitFor(() => expect(getLiveSession).toHaveBeenCalledTimes(1));
    firstAbort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const second = service.wait("two", { cursor: CURSOR, after: REVISION });
    await vi.waitFor(() => expect(getLiveSession).toHaveBeenCalledTimes(2));
    service.close();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
  });

  it("delegates every observation to the binding cache without retaining stale state", async () => {
    const getLiveSession = vi.fn().mockResolvedValue(snapshot(false, true));
    const resolvers: Array<(value: { supported: false; attachCommand: null }) => void> = [];
    const describeSnapshot = vi.fn(
      () =>
        new Promise<{ supported: false; attachCommand: null }>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const service = createService(getLiveSession, {
      interaction: { describeSnapshot },
      probeIntervalMs: 1_000,
      waitTimeoutMs: 5_000,
    });
    const leftAbort = new AbortController();
    const rightAbort = new AbortController();
    const left = service.wait("session", { cursor: CURSOR, after: REVISION }, leftAbort.signal);
    const right = service.wait("session", { cursor: CURSOR, after: REVISION }, rightAbort.signal);
    await vi.waitFor(() => expect(getLiveSession).toHaveBeenCalledTimes(2));
    expect(describeSnapshot).toHaveBeenCalledTimes(2);
    resolvers.forEach((resolve) => resolve({ supported: false, attachCommand: null }));
    await Promise.resolve();
    leftAbort.abort();
    rightAbort.abort();
    await expect(left).rejects.toMatchObject({ name: "AbortError" });
    await expect(right).rejects.toMatchObject({ name: "AbortError" });
  });
});

function createService(
  getLiveSession: ReturnType<typeof vi.fn>,
  options: ConstructorParameters<typeof SessionLiveService>[1] = {},
) {
  const repository = {
    getLiveSession,
    getInteractionSession: vi.fn().mockResolvedValue(null),
  } as unknown as SessionReader;
  return new SessionLiveService(repository, {
    createRevision: () => REVISION,
    ...options,
  });
}

function snapshot(hasMore: boolean, interaction = false): LiveSessionSnapshot {
  return {
    session: SESSION,
    cursor: CURSOR,
    hasMore,
    interactionSession: {
      archived: false,
      interaction: interaction
        ? {
            transport: "tmux",
            rebindCommand: "! bind",
            bindingAttempt: null,
            keyBindings: CODEX_INTERACTION_KEY_BINDINGS,
          }
        : null,
    },
  };
}

describe("nickname revision isolation", () => {
  it("does not return a Live update for a nickname-only change", async () => {
    const canonical = { ...SESSION, title: "Canonical title", archived: true };
    const display = { ...canonical, nickname: "Nickname" };
    const getLiveSession = vi.fn().mockResolvedValue({
      session: display,
      cursor: CURSOR,
      hasMore: false,
      interactionSession: { archived: true, interaction: null },
    } satisfies LiveSessionSnapshot);
    const service = createService(getLiveSession, {
      createRevision: (session) =>
        session.title === "Canonical title" ? REVISION : OTHER_REVISION,
    });

    await expect(
      service.wait("session", {
        cursor: CURSOR,
        after: REVISION,
      }),
    ).resolves.toBeNull();
  });
});

const SESSION: SessionDetail = {
  id: "session",
  origin: {
    sourceType: "test",
    sourceInstanceId: "test",
    agentName: "Test",
    agentVersion: null,
    formatVersion: null,
  },
  title: "Session",
  nickname: null,
  workingDirectory: null,
  projectDirectory: null,
  createdAt: null,
  updatedAt: null,
  archived: false,
  parentId: null,
  childIds: [],
  agent: null,
  messageCount: 0,
  toolCount: 0,
  sourceId: "session",
  itemCount: 0,
};

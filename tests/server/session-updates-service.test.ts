import { describe, expect, it, vi } from "vitest";

import {
  CODEX_INTERACTION_KEY_BINDINGS,
  codexInterruptSteps,
} from "../../src/server/adapters/codex/interaction-parser.js";
import type {
  SessionReader,
  SessionUpdatesSnapshot,
} from "../../src/server/application/session-reader.js";
import { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import { PaneBindingManager } from "../../src/server/interaction/pane-binding-manager.js";
import { reconcileSessionState } from "../../src/server/interaction/reconcile-session-state.js";
import type { InteractionTransport } from "../../src/server/interaction/transport.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import {
  createProcessUpdateRevisionFactory,
  withUpdateRevision,
} from "../../src/server/updates/update-revision.js";
import type { TimelineCursor, UpdateRevision } from "../../src/shared/api-contract.js";
import type { SessionDetail } from "../../src/shared/domain.js";

const CURSOR = "opaque.timeline.cursor" as TimelineCursor;
const REVISION = "a".repeat(43) as UpdateRevision;
const OTHER_REVISION = "b".repeat(43) as UpdateRevision;

describe("SessionUpdatesService", () => {
  it("creates stable revisions that cover public session and effective interaction state", () => {
    const createRevision = createProcessUpdateRevisionFactory(Buffer.alloc(32, 7));
    const revision = (
      session: SessionDetail,
      interaction: Parameters<typeof withUpdateRevision>[0]["interaction"],
    ) => withUpdateRevision({ session, interaction }, createRevision).updateRevision;
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
        activity: "unknown",
        supersededBySessionId: null,
        attachCommand: null,
        state: "connected",
      }),
    ).not.toBe(first);
  });

  it("returns immediately for a changed revision or timeline backlog", async () => {
    const getSessionUpdates = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getSessionUpdates);
    await expect(
      service.wait("session", { cursor: CURSOR, after: OTHER_REVISION }),
    ).resolves.toMatchObject({ cursor: CURSOR, updateRevision: REVISION });

    getSessionUpdates.mockResolvedValue(snapshot(true));
    await expect(
      service.wait("session", { cursor: CURSOR, after: REVISION }),
    ).resolves.toMatchObject({ hasMore: true });
  });

  it("repeats empty probes and returns null at the bounded timeout", async () => {
    const getSessionUpdates = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getSessionUpdates, { probeIntervalMs: 3, waitTimeoutMs: 12 });
    await expect(service.wait("session", { cursor: CURSOR, after: REVISION })).resolves.toBeNull();
    expect(getSessionUpdates.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("enforces the process-wide waiter limit across sessions", async () => {
    const getSessionUpdates = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getSessionUpdates, {
      probeIntervalMs: 1_000,
      waitTimeoutMs: 5_000,
      maxWaiters: 1,
      maxWaitersPerSession: 2,
    });
    const abort = new AbortController();
    const first = service.wait("session-one", { cursor: CURSOR, after: REVISION }, abort.signal);
    await vi.waitFor(() => expect(getSessionUpdates).toHaveBeenCalledTimes(1));
    await expect(
      service.wait("session-two", { cursor: CURSOR, after: REVISION }),
    ).rejects.toMatchObject({ code: "updates_capacity_exceeded" });
    abort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
  });

  it("enforces the per-session waiter limit below process capacity", async () => {
    const getSessionUpdates = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getSessionUpdates, {
      probeIntervalMs: 1_000,
      waitTimeoutMs: 5_000,
      maxWaiters: 2,
      maxWaitersPerSession: 1,
    });
    const abort = new AbortController();
    const first = service.wait("session", { cursor: CURSOR, after: REVISION }, abort.signal);
    await vi.waitFor(() => expect(getSessionUpdates).toHaveBeenCalledTimes(1));
    await expect(
      service.wait("session", { cursor: CURSOR, after: REVISION }),
    ).rejects.toMatchObject({ code: "updates_capacity_exceeded" });
    abort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
  });

  it("releases waiters on external cancellation and service close", async () => {
    const getSessionUpdates = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getSessionUpdates, {
      probeIntervalMs: 1_000,
      waitTimeoutMs: 5_000,
    });
    const firstAbort = new AbortController();
    const first = service.wait("one", { cursor: CURSOR, after: REVISION }, firstAbort.signal);
    await vi.waitFor(() => expect(getSessionUpdates).toHaveBeenCalledTimes(1));
    firstAbort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const second = service.wait("two", { cursor: CURSOR, after: REVISION });
    await vi.waitFor(() => expect(getSessionUpdates).toHaveBeenCalledTimes(2));
    service.close();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
  });

  it("delegates every observation to the interaction service without retaining stale state", async () => {
    const getSessionUpdates = vi.fn().mockResolvedValue(snapshot(false, true));
    const resolvers: Array<(value: { supported: false; attachCommand: null }) => void> = [];
    const describeSnapshot = vi.fn(
      () =>
        new Promise<{ supported: false; attachCommand: null }>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const service = createService(getSessionUpdates, {
      interaction: { describeSnapshot },
      probeIntervalMs: 1_000,
      waitTimeoutMs: 5_000,
    });
    const leftAbort = new AbortController();
    const rightAbort = new AbortController();
    const left = service.wait("session", { cursor: CURSOR, after: REVISION }, leftAbort.signal);
    const right = service.wait("session", { cursor: CURSOR, after: REVISION }, rightAbort.signal);
    await vi.waitFor(() => expect(getSessionUpdates).toHaveBeenCalledTimes(2));
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
  getSessionUpdates: ReturnType<typeof vi.fn>,
  options: ConstructorParameters<typeof SessionUpdatesService>[1] = {},
) {
  const repository = {
    getSessionUpdates,
    getInteractionSession: vi.fn().mockResolvedValue(null),
  } as unknown as SessionReader;
  return new SessionUpdatesService(repository, {
    createRevision: () => REVISION,
    ...options,
  });
}

function snapshot(hasMore: boolean, interaction = false): SessionUpdatesSnapshot {
  return {
    session: SESSION,
    cursor: CURSOR,
    hasMore,
    interactionSession: {
      archived: false,
      interaction: interaction
        ? {
            transport: "tmux",
            bindingCommand: "! bind",
            keyBindings: CODEX_INTERACTION_KEY_BINDINGS,
            interruptSteps: codexInterruptSteps,
          }
        : null,
    },
  };
}

describe("nickname revision isolation", () => {
  it("does not return an automatic update for a nickname-only change", async () => {
    const canonical = { ...SESSION, title: "Canonical title", status: "archived" as const };
    const display = { ...canonical, nickname: "Nickname" };
    const getSessionUpdates = vi.fn().mockResolvedValue({
      session: display,
      cursor: CURSOR,
      hasMore: false,
      interactionSession: { archived: true, interaction: null },
    } satisfies SessionUpdatesSnapshot);
    const service = createService(getSessionUpdates, {
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
  status: "normal",
  resume: { allowed: false, reason: "Unavailable" },
  parentId: null,
  childIds: [],
  agent: null,
  messageCount: 0,
  toolCount: 0,
  sourceId: "session",
  itemCount: 0,
};

it("updates update revisions on takeover and replacement deletion without changing the old session", async () => {
  const bindings = new PaneBindingManager();
  const pane = { socketPath: "/tmp/updates.sock", paneId: "%1" };
  bindings.submit({
    sessionId: "session",
    time: 1,
    ordinal: 1,
    position: 0,
    attempt: { valid: true, ordinal: 1, ...pane },
  });
  const current = snapshot(false, true);
  let replacementExists = true;
  const interaction = new SessionInteractionService(
    {
      getInteractionSession: vi.fn(async (id) =>
        id === "replacement" && !replacementExists ? null : current.interactionSession,
      ),
    },
    true,
    { connect: vi.fn(async () => pane) } as unknown as InteractionTransport,
    bindings,
  );
  const updates = new SessionUpdatesService(
    { getSessionUpdates: vi.fn(async () => current) },
    { interaction },
  );
  try {
    const connected = (await updates.wait("session", { cursor: CURSOR, after: OTHER_REVISION }))!;
    expect(connected.interaction).toMatchObject({ state: "connected" });
    bindings.submit({
      sessionId: "replacement",
      time: 2,
      ordinal: 1,
      position: 0,
      attempt: { valid: true, ordinal: 1, ...pane },
    });
    const superseded = (await updates.wait("session", {
      cursor: CURSOR,
      after: connected.updateRevision,
    }))!;
    expect(connected.session.status).toBe("live");
    expect(superseded.session.status).toBe("normal");
    expect(superseded.updateRevision).not.toBe(connected.updateRevision);
    expect(superseded.interaction).toMatchObject({
      state: "superseded",
      supersededBySessionId: "replacement",
    });
    replacementExists = false;
    const missing = (await updates.wait("session", {
      cursor: CURSOR,
      after: superseded.updateRevision,
    }))!;
    expect(missing.updateRevision).not.toBe(superseded.updateRevision);
    expect(missing.interaction).toMatchObject({ state: "superseded", supersededBySessionId: null });
  } finally {
    updates.close();
  }
});

it.each(["connected", "unknown", "disconnected", "superseded"] as const)(
  "reconciles a later %s observation before calculating revision without mutating input",
  (state) => {
    const session = {
      ...SESSION,
      status: "live" as const,
      resume: { allowed: true as const, reason: null },
    };
    const value = {
      session,
      interaction: {
        supported: true as const,
        activity: "unknown" as const,
        state,
        supersededBySessionId: null,
        attachCommand: null,
      },
    };
    const before = structuredClone(value);
    const coordinated = reconcileSessionState(value);
    expect(coordinated.session.status).toBe(state === "connected" ? "live" : "normal");
    expect(coordinated.session.resume.allowed).toBe(!["connected", "unknown"].includes(state));
    const createRevision = vi.fn(() => REVISION);
    const response = withUpdateRevision(coordinated, createRevision);
    const { nickname: _nickname, ...expected } = coordinated.session;
    expect(createRevision).toHaveBeenCalledWith(expected, value.interaction);
    expect(response.session).toBe(coordinated.session);
    expect(value).toEqual(before);
    // Revision attachment alone must not coordinate state.
    expect(withUpdateRevision(value, createRevision).session).toBe(session);
  },
);

it("preserves archived and unsupported results during coordination", () => {
  const archived = {
    session: { ...SESSION, status: "archived" as const },
    interaction: {
      supported: true as const,
      activity: "unknown" as const,
      state: "connected" as const,
      supersededBySessionId: null,
      attachCommand: null,
    },
  };
  expect(reconcileSessionState(archived)).toBe(archived);
  const unsupported = {
    session: { ...SESSION, status: "live" as const },
    interaction: { supported: false as const, attachCommand: null },
  };
  expect(reconcileSessionState(unsupported)).toBe(unsupported);
});

it("returns a long-poll update when only activity changes", async () => {
  const connected = {
    supported: true as const,
    state: "connected" as const,
    activity: "working" as const,
    supersededBySessionId: null,
    attachCommand: null,
  };
  const describeSnapshot = vi
    .fn()
    .mockResolvedValueOnce(connected)
    .mockResolvedValue({ ...connected, activity: "idle" });
  const createRevision = createProcessUpdateRevisionFactory(Buffer.alloc(32, 3));
  const after = withUpdateRevision(
    reconcileSessionState({ session: SESSION, interaction: connected }),
    createRevision,
  ).updateRevision;
  const service = createService(vi.fn().mockResolvedValue(snapshot(false, true)), {
    createRevision,
    interaction: { describeSnapshot },
    probeIntervalMs: 1,
    waitTimeoutMs: 100,
  });
  const result = await service.wait("session", { cursor: CURSOR, after });
  expect(result?.interaction).toMatchObject({ activity: "idle" });
  expect(result?.updateRevision).not.toBe(after);
});

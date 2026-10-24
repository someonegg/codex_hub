import { expect, it, vi } from "vitest";

import { SessionReadService } from "../../src/server/application/session-read-service.js";
import type { DomainDiagnostic } from "../../src/server/domain/session-domain.js";
import { CatalogSnapshotStore } from "../../src/server/repository/catalog-snapshot-store.js";
import { RefreshDiagnosticLogger } from "../../src/server/repository/diagnostic-logger.js";
import { opaqueIdForParts } from "../../src/server/security/opaque-id.js";
import type {
  SessionSourceSnapshot,
  SourceSessionEntry,
} from "../../src/server/source/session-source.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import { normalizeRecords } from "./session-normalizer.fixtures.js";

const warning: DomainDiagnostic = {
  code: "partial",
  severity: "warning",
  message: "Partial",
  ordinal: 7,
};
const descriptor = {
  sourceType: "test",
  instanceKey: "key",
  sourceInstanceId: "source",
  displayName: "Test",
};
const id = opaqueIdForParts(descriptor.instanceKey, "one");
function entry(diagnostics: readonly DomainDiagnostic[] = []): SourceSessionEntry {
  const normalized = normalizeRecords("one", [], { threadId: "native" });
  return {
    localId: "one",
    nativeSessionId: "native",
    parentNativeSessionId: null,
    origin: normalized.session.origin,
    normalized: { ...normalized, session: { ...normalized.session, diagnostics } },
  };
}

it("logs during detail-only refreshes, deduplicates content and logs cleared diagnostics again", async () => {
  const log = vi.fn();
  let snapshot: SessionSourceSnapshot = {
    signature: "1",
    sessions: [entry([warning])],
    diagnostics: [warning],
  };
  const source = { descriptor, refresh: vi.fn(async () => snapshot) };
  const reader = new SessionReadService([source], undefined, undefined, {
    diagnosticLogger: { log },
  });
  const detail = await reader.getSession(id);
  expect(detail?.session).not.toHaveProperty("diagnostics");
  expect(detail?.session).not.toHaveProperty("warningCount");
  expect(log.mock.calls.map(([record]) => record)).toEqual([
    { ...warning, sourceInstanceId: "source", sessionId: null, scope: "source" },
    { ...warning, sourceInstanceId: "source", sessionId: id, scope: "session" },
  ]);
  await reader.getSession(id);
  expect(source.refresh).toHaveBeenCalledOnce();
  await reader.refresh();
  snapshot = { signature: "2", sessions: [entry([{ ...warning }])], diagnostics: [{ ...warning }] };
  await reader.refresh();
  expect(log).toHaveBeenCalledTimes(2);
  snapshot = {
    signature: "3",
    sessions: [entry([{ ...warning, message: "Changed" }])],
    diagnostics: [],
  };
  await reader.refresh();
  expect(log).toHaveBeenCalledTimes(3);
  snapshot = { signature: "4", sessions: [entry()], diagnostics: [] };
  await reader.refresh();
  snapshot = { signature: "5", sessions: [entry([warning])], diagnostics: [warning] };
  await reader.refresh();
  expect(log).toHaveBeenCalledTimes(5);
  snapshot = { signature: "6", sessions: [], diagnostics: [] };
  await reader.refresh();
  snapshot = { signature: "7", sessions: [entry([warning])], diagnostics: [] };
  await reader.refresh();
  expect(log).toHaveBeenCalledTimes(6);
});

it("does not inspect diagnostic content on cached reads or unchanged diagnostic references", async () => {
  let reads = 0;
  const diagnostic = new Proxy(warning, {
    get(target, key, receiver) {
      reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const normalized = entry([diagnostic]);
  let generation = 0;
  const source = {
    descriptor,
    async refresh() {
      return { signature: String(generation++), sessions: [normalized], diagnostics: [] };
    },
  };
  const reader = new SessionReadService([source], undefined, undefined, {
    diagnosticLogger: { log() {} },
  });
  await reader.getSession(id);
  reads = 0;
  await reader.getSession(id);
  await reader.list();
  await reader.refresh();
  expect(reads).toBe(0);
});

it("logs each source independently, including aggregate diagnostics, and forgets removed sources", () => {
  const log = vi.fn();
  const logger = new RefreshDiagnosticLogger({ log });
  const one = entry();
  const sources = [
    {
      descriptor,
      snapshot: {
        signature: "1",
        sessions: [],
        diagnostics: Array.from({ length: 60 }, (_, i) => ({ ...warning, code: `warning-${i}` })),
      },
    },
    {
      descriptor: { ...descriptor, instanceKey: "other", sourceInstanceId: "other" },
      snapshot: {
        signature: "2",
        sessions: [one, one],
        diagnostics: [warning],
      },
    },
  ];
  const aggregates = new Map([
    [
      "other",
      [
        {
          sessionId: "global-id",
          diagnostic: {
            ...warning,
            code: "duplicate_source_session_id",
            severity: "error" as const,
          },
        },
      ],
    ],
  ]);
  logger.update(sources, aggregates);
  expect(log).toHaveBeenCalledTimes(52);
  expect(log.mock.calls.at(-1)?.[0]).toMatchObject({
    sourceInstanceId: "other",
    scope: "aggregate",
    code: "duplicate_source_session_id",
  });
  logger.update(sources, aggregates);
  expect(log).toHaveBeenCalledTimes(52);
  logger.update([]);
  logger.update(sources, aggregates);
  expect(log).toHaveBeenCalledTimes(104);
});

it("isolates logger failures from reading and management snapshots", async () => {
  const source = {
    descriptor,
    async refresh() {
      return { signature: "1", sessions: [entry([warning])], diagnostics: [warning] };
    },
  };
  const reader = new SessionReadService([source], undefined, undefined, {
    diagnosticLogger: {
      log() {
        throw new Error("stderr unavailable");
      },
    },
  });
  expect((await reader.getSession(id))?.session.id).toBe(id);
  expect((await reader.managementSnapshot()).sessions).toHaveLength(1);
});

it("does not wake automatic updates when session or source diagnostics change", async () => {
  let snapshot: SessionSourceSnapshot = { signature: "1", sessions: [entry()], diagnostics: [] };
  const reader = new SessionReadService(
    [
      {
        descriptor,
        async refresh() {
          return snapshot;
        },
      },
    ],
    undefined,
    undefined,
    { diagnosticLogger: { log() {} } },
  );
  const updates = new SessionUpdatesService(reader, { probeIntervalMs: 1, waitTimeoutMs: 8 });
  try {
    const page = await reader.getItems(id, {});
    const initial = await updates.wait(id, {
      cursor: page!.cursor,
      after: "a".repeat(43) as never,
    });
    snapshot = { signature: "2", sessions: [entry([warning])], diagnostics: [warning] };
    await reader.refresh();
    expect(
      await updates.wait(id, { cursor: page!.cursor, after: initial!.updateRevision }),
    ).toBeNull();
  } finally {
    updates.close();
  }
});

it.each(["instanceKey", "sourceInstanceId"] as const)(
  "rejects empty and duplicate %s at registration",
  (field) => {
    const source = {
      descriptor,
      async refresh() {
        return { signature: "", sessions: [], diagnostics: [] };
      },
    };
    expect(
      () => new CatalogSnapshotStore([{ ...source, descriptor: { ...descriptor, [field]: " " } }]),
    ).toThrow(/Empty/);
    const other = {
      ...source,
      descriptor: {
        ...descriptor,
        instanceKey: "other",
        sourceInstanceId: "other",
        [field]: descriptor[field],
      },
    };
    expect(() => new CatalogSnapshotStore([source, other])).toThrow(/Duplicate/);
  },
);

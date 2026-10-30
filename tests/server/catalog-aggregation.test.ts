import { describe, expect, it, vi } from "vitest";

import { SessionApiMapper } from "../../src/server/api/session-api-mapper.js";
import {
  CatalogSnapshotStore,
  MAX_CATALOG_DIAGNOSTICS,
} from "../../src/server/repository/catalog-snapshot-store.js";
import type { SessionSource, SourceSessionEntry } from "../../src/server/source/session-source.js";
import { normalizedSession } from "../helpers/session-fixtures.js";

const normalized = normalizedSession();

describe("catalog source aggregation", () => {
  it("limits catalog diagnostics while preserving their order", async () => {
    const diagnostics = Array.from({ length: MAX_CATALOG_DIAGNOSTICS + 1 }, (_, index) => ({
      code: `catalog_warning_${index + 1}`,
      severity: "warning" as const,
      message: `Catalog warning ${index + 1}`,
      ordinal: null,
    }));
    const source = {
      ...testSource("catalog-diagnostics", []),
      async refresh() {
        return {
          signature: "catalog-diagnostics",
          sessions: [],
          diagnostics,
        };
      },
    };

    const snapshot = await new CatalogSnapshotStore([source]).current();

    expect(snapshot.diagnostics).toEqual(diagnostics.slice(0, MAX_CATALOG_DIAGNOSTICS));
  });

  it("retains readable sessions despite truncated diagnostics and duplicate local identities", async () => {
    const first = testSource("first", []);
    const healthy = testSource("healthy", [sourceEntry("one", null, "Healthy")]);
    const duplicate = sourceEntry("same", null, "Duplicate");
    const broken = testSource("broken", [duplicate, duplicate]);
    const noisy: SessionSource = {
      ...first,
      async refresh() {
        return {
          signature: "noisy",
          sessions: [],
          diagnostics: Array.from({ length: MAX_CATALOG_DIAGNOSTICS + 1 }, () => ({
            code: "unavailable",
            severity: "error" as const,
            message: "Unavailable",
            ordinal: null,
          })),
        };
      },
    };
    const log = vi.fn();
    const snapshot = await new CatalogSnapshotStore(
      [noisy, healthy, broken],
      undefined,
      undefined,
      { diagnosticLogger: { log } },
    ).current();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        home: broken.descriptor.home,
        scope: "aggregate",
        code: "duplicate_source_session_id",
      }),
    );
    expect(snapshot.diagnostics).toHaveLength(MAX_CATALOG_DIAGNOSTICS);
    expect(snapshot.sessions.size).toBe(2);
  });

  it("rejects duplicate source instances and propagates source invariant failures", async () => {
    const source = {
      descriptor: {
        sourceType: "test",
        instanceKey: "test-source",
        home: "test-source",
        displayName: "Test",
      },
      refresh: vi.fn(async () => {
        throw new Error("source invariant");
      }),
    };
    expect(() => new CatalogSnapshotStore([source, source])).toThrow(
      "Duplicate session source instance key",
    );
    await expect(new CatalogSnapshotStore([source]).current()).rejects.toThrow("source invariant");
  });

  it("namespaces source identities, links parents locally, and ignores source order", async () => {
    const sourceA = testSource("source-a", [
      sourceEntry("parent", null, "Source A parent"),
      sourceEntry("child-z", "parent", "Source A child Z"),
      sourceEntry("child-a", "parent", "Source A child A"),
    ]);
    const sourceAWithReorderedEntries = testSource("source-a", [
      sourceEntry("parent", null, "Source A parent"),
      sourceEntry("child-a", "parent", "Source A child A"),
      sourceEntry("child-z", "parent", "Source A child Z"),
    ]);
    const sourceB = testSource("source-b", [
      sourceEntry("parent", null, "Source B parent"),
      sourceEntry("child", "missing-in-source-b", "Source B child"),
    ]);
    const first = await new CatalogSnapshotStore([sourceA, sourceB]).current();
    const reordered = await new CatalogSnapshotStore([sourceB, sourceA]).current();
    const reorderedEntries = await new CatalogSnapshotStore([
      sourceAWithReorderedEntries,
      sourceB,
    ]).current();

    expect(first.signature).toBe(reordered.signature);
    expect(first.signature).toBe(reorderedEntries.signature);
    const mapper = new SessionApiMapper();
    expect(
      mapper.list([...first.sessions.values()].map((value) => value.normalized.session)),
    ).toEqual(
      mapper.list([...reordered.sessions.values()].map((value) => value.normalized.session)),
    );
    expect([...first.sessions.keys()].sort()).toEqual([...reordered.sessions.keys()].sort());
    const byTitle = new Map(
      [...first.sessions.values()].map(({ normalized: value }) => [
        value.session.title,
        value.session,
      ]),
    );
    expect(byTitle.get("Source A parent")?.id).not.toBe(byTitle.get("Source B parent")?.id);
    expect(byTitle.get("Source A child A")?.parentId).toBe(byTitle.get("Source A parent")?.id);
    expect(byTitle.get("Source A child Z")?.parentId).toBe(byTitle.get("Source A parent")?.id);
    expect(byTitle.get("Source B child")?.parentId).toBeNull();
    const parent = byTitle.get("Source A parent")!;
    expect(parent.childIds).toEqual([...parent.childIds].sort());
    expect(parent.childIds).toEqual(
      [...reorderedEntries.sessions.values()].find(
        ({ normalized: value }) => value.session.title === "Source A parent",
      )!.normalized.session.childIds,
    );
  });
});

function sourceEntry(
  nativeSessionId: string,
  parentNativeSessionId: string | null,
  title: string,
): SourceSessionEntry {
  const origin = {
    sourceType: "test",
    home: "replaced-by-source",
    agentName: "Test",
    agentVersion: null,
    formatVersion: null,
  };
  return {
    localId: nativeSessionId,
    nativeSessionId,
    parentNativeSessionId,
    origin,
    normalized: {
      ...normalized,
      session: {
        ...normalized.session,
        id: nativeSessionId,
        sourceId: nativeSessionId,
        origin,
        title,
        parentId: parentNativeSessionId,
        childIds: [],
      },
    },
  };
}

function testSource(instanceKey: string, sessions: readonly SourceSessionEntry[]): SessionSource {
  return {
    descriptor: {
      sourceType: "test",
      instanceKey,
      home: instanceKey,
      displayName: "Test",
    },
    async refresh() {
      return { signature: "stable", sessions, diagnostics: [] };
    },
  };
}

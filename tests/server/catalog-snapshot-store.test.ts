import { describe, expect, it } from "vitest";

import type { DomainSessionId, NormalizedSession } from "../../src/server/domain/session-domain.js";
import {
  type CatalogSnapshot,
  CatalogSnapshotStore,
} from "../../src/server/repository/catalog-snapshot-store.js";
import type { SessionSource, SourceSessionEntry } from "../../src/server/source/session-source.js";

describe("CatalogSnapshotStore incremental derivation", () => {
  it("updates only the affected relationship closure when a child is reparented or deleted", async () => {
    const parentOne = normalizedSession("p1", "Parent one");
    const parentTwo = normalizedSession("p2", "Parent two");
    const child = normalizedSession("child", "Child");
    let signature = "initial";
    let entries = [
      sourceEntry("p1", parentOne, "native-p1"),
      sourceEntry("p2", parentTwo, "native-p2"),
      sourceEntry("child", child, "native-child", "native-p1"),
    ];
    const store = new CatalogSnapshotStore(
      [mutableSource(() => ({ signature, entries }))],
      0,
      () => 0,
    );
    let snapshot = await store.current();
    const p1Id = idByTitle(snapshot, "Parent one");
    const p2Id = idByTitle(snapshot, "Parent two");
    const childId = idByTitle(snapshot, "Child");
    expect(snapshot.sessions.get(childId)!.session.parentId).toBe(p1Id);
    expect(snapshot.sessions.get(p1Id)!.session.childIds).toEqual([childId]);

    const beforeReparent = new Map(snapshot.sessions);
    entries = [
      sourceEntry("p1", parentOne, "native-p1"),
      sourceEntry("p2", parentTwo, "native-p2"),
      sourceEntry("child", child, "native-child", "native-p2"),
    ];
    signature = "reparent";
    snapshot = await store.refresh();
    expect(snapshot.sessions.get(childId)!.session.parentId).toBe(p2Id);
    expect(snapshot.sessions.get(p1Id)!.session.childIds).toEqual([]);
    expect(snapshot.sessions.get(p2Id)!.session.childIds).toEqual([childId]);
    expectChanged(snapshot, beforeReparent, [p1Id, p2Id, childId]);

    const beforeDelete = new Map(snapshot.sessions);
    entries = entries.filter((entry) => entry.localId !== "child");
    signature = "delete-child";
    snapshot = await store.refresh();
    expect(snapshot.sessions.get(p2Id)!.session.childIds).toEqual([]);
    expectChanged(snapshot, beforeDelete, [p2Id]);
    expect(snapshot.sessions.get(p1Id)).toBe(beforeDelete.get(p1Id));
  });

  it("relinks a child when its missing parent appears, disappears, and reappears", async () => {
    const child = normalizedSession("child", "Child");
    const parent = normalizedSession("parent", "Parent");
    let signature = "child-before-parent";
    let entries = [sourceEntry("child", child, "native-child", "native-parent")];
    const store = new CatalogSnapshotStore(
      [mutableSource(() => ({ signature, entries }))],
      0,
      () => 0,
    );
    let snapshot = await store.current();
    const childId = idByTitle(snapshot, "Child");
    expect(snapshot.sessions.get(childId)!.session.parentId).toBeNull();

    entries = [...entries, sourceEntry("parent", parent, "native-parent")];
    signature = "parent-appears";
    snapshot = await store.refresh();
    const parentId = idByTitle(snapshot, "Parent");
    const firstParent = snapshot.sessions.get(parentId)!;
    expect(snapshot.sessions.get(childId)!.session.parentId).toBe(parentId);
    expect(snapshot.sessions.get(parentId)!.session.childIds).toEqual([childId]);

    entries = entries.filter((entry) => entry.localId !== "parent");
    signature = "parent-deleted";
    snapshot = await store.refresh();
    expect(snapshot.sessions.get(childId)!.session.parentId).toBeNull();

    entries = [...entries, sourceEntry("parent", parent, "native-parent")];
    signature = "parent-reappears";
    snapshot = await store.refresh();
    expect(snapshot.sessions.get(parentId)).not.toBe(firstParent);
    expect(snapshot.sessions.get(childId)!.session.parentId).toBe(parentId);
  });

  it("unlinks and recovers a child when its native parent identity becomes ambiguous", async () => {
    const child = normalizedSession("child", "Child");
    const parent = normalizedSession("parent", "Parent");
    const duplicateParent = normalizedSession("duplicate", "Duplicate parent");
    let signature = "native-unique";
    let entries = [
      sourceEntry("child", child, "native-child", "native-parent"),
      sourceEntry("parent", parent, "native-parent"),
    ];
    const store = new CatalogSnapshotStore(
      [mutableSource(() => ({ signature, entries }))],
      0,
      () => 0,
    );
    let snapshot = await store.current();
    const childId = idByTitle(snapshot, "Child");
    const parentId = idByTitle(snapshot, "Parent");
    expect(snapshot.sessions.get(childId)!.session.parentId).toBe(parentId);

    entries = [...entries, sourceEntry("duplicate", duplicateParent, "native-parent")];
    signature = "native-duplicate";
    snapshot = await store.refresh();
    const duplicateId = idByTitle(snapshot, "Duplicate parent");
    expect(snapshot.sessions.get(childId)!.session.parentId).toBeNull();
    expect(snapshot.sessions.get(parentId)!.session.childIds).toEqual([]);

    const beforeRecovery = new Map(snapshot.sessions);
    entries = entries.filter((entry) => entry.localId !== "duplicate");
    signature = "native-unique-again";
    snapshot = await store.refresh();
    expect(snapshot.sessions.get(duplicateId)).toBeUndefined();
    expect(snapshot.sessions.get(childId)!.session.parentId).toBe(parentId);
    expect(snapshot.sessions.get(parentId)!.session.childIds).toEqual([childId]);
    expectChanged(snapshot, beforeRecovery, [childId, parentId]);
  });
});

const TEST_ORIGIN = {
  sourceType: "test",
  home: "test",
  agentName: "Test",
  agentVersion: null,
} as const;

function mutableSource(
  state: () => {
    signature: string;
    entries: readonly SourceSessionEntry[];
  },
): SessionSource {
  return {
    descriptor: {
      sourceType: "test",
      instanceKey: "test",
      home: "test",
      displayName: "Test",
    },
    async refresh() {
      const current = state();
      return {
        signature: current.signature,
        sessions: current.entries.map((entry) => ({ ...entry })),
        diagnostics: [],
      };
    },
  };
}

function sourceEntry(
  localId: string,
  normalized: NormalizedSession,
  nativeSessionId = localId,
  parentNativeSessionId: string | null = null,
): SourceSessionEntry {
  return {
    localId,
    nativeSessionId,
    parentNativeSessionId,
    origin: TEST_ORIGIN,
    normalized,
  };
}

function normalizedSession(id: string, title: string): NormalizedSession {
  return {
    session: {
      id,
      sourceId: id,
      origin: TEST_ORIGIN,
      title,
      workingDirectory: null,
      projectDirectory: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      archived: false,
      parentId: null,
      childIds: [],
      agent: null,
      warningCount: 0,
      diagnostics: [],
    },
    timeline: [],
  };
}

function idByTitle(snapshot: CatalogSnapshot, title: string): DomainSessionId {
  const matches = [...snapshot.sessions].filter(([, value]) => value.session.title === title);
  if (matches.length !== 1) {
    throw new Error(`Expected one session titled ${title}, found ${matches.length}`);
  }
  return matches[0]![0];
}

function expectChanged(
  snapshot: CatalogSnapshot,
  before: ReadonlyMap<string, NormalizedSession>,
  ids: readonly string[],
): void {
  for (const id of ids) {
    expect(snapshot.sessions.get(id)).not.toBe(before.get(id));
  }
}

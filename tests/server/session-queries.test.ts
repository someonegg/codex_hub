import { expect, it } from "vitest";

import type {
  DomainSession,
  DomainTimelineRecord,
  NormalizedSession,
} from "../../src/server/domain/session-domain.js";
import type { CatalogSnapshot } from "../../src/server/repository/catalog-snapshot-store.js";
import {
  MAX_ITEM_PAGE_BYTES,
  SessionQueries,
} from "../../src/server/repository/session-queries.js";
import { deriveTimelinePrefixIndex } from "../../src/server/repository/timeline-prefix-index.js";

const session: DomainSession = {
  id: "session",
  sourceId: "native",
  title: "Test",
  archived: false,
  origin: {
    sourceType: "test",
    sourceInstanceId: "test",
    agentName: "Test",
    agentVersion: null,
    formatVersion: null,
  },
  projectDirectory: null,
  workingDirectory: null,
  createdAt: null,
  updatedAt: null,
  parentId: null,
  childIds: [],
  agent: null,
  messageCount: 0,
  toolCount: 0,
  warningCount: 0,
  itemCount: 0,
  diagnostics: [],
};
const key = new Uint8Array(32);
function message(index: number): DomainTimelineRecord {
  return {
    id: `item-${index}`,
    ordinal: index * 3 + 1,
    kind: "message",
    timestamp: null,
    role: "user",
    phase: null,
    itemType: null,
    markdown: "text",
  };
}
function normalized(timeline: readonly DomainTimelineRecord[]): NormalizedSession {
  return {
    session,
    timeline,
    toolDetails: new Map(),
    directiveDetails: new Map(),
    internalDetails: new Map(),
  };
}
function snapshot(value: NormalizedSession): CatalogSnapshot {
  return {
    signature: "test",
    diagnostics: [],
    sessions: new Map([
      [
        session.id,
        { normalized: value, timelinePrefixIndex: deriveTimelinePrefixIndex(value, key) },
      ],
    ]),
  };
}

it("reads empty timelines and noncontiguous ordinals across first, middle, last and empty pages", () => {
  const queries = new SessionQueries();
  expect(queries.items(snapshot(normalized([])), session.id, {})?.context.hasMore).toBe(false);
  const state = snapshot(normalized(Array.from({ length: 5 }, (_, index) => message(index))));
  const first = queries.items(state, session.id, { limit: 2 })!;
  const middle = queries.items(state, session.id, { limit: 2, cursor: first.context.cursor })!;
  const last = queries.items(state, session.id, { limit: 2, cursor: middle.context.cursor })!;
  expect(first.items.map((item) => item.ordinal)).toEqual([1, 4]);
  expect(middle.items.map((item) => item.ordinal)).toEqual([7, 10]);
  expect(last.items.map((item) => item.ordinal)).toEqual([13]);
  expect(last.context.hasMore).toBe(false);
  expect(queries.items(state, session.id, { cursor: last.context.cursor })).toEqual({
    context: last.context,
    items: [],
  });
});

it("bounds deep-page array reads to binary searches plus this page", () => {
  const queries = new SessionQueries();
  let reads = 0;
  const timeline = new Proxy(
    Array.from({ length: 10_000 }, (_, index) => message(index)),
    {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const state = snapshot(normalized(timeline));
  let cursor: string | undefined;
  for (let index = 0; index < 30; index++) {
    cursor = queries.items(state, session.id, { limit: 300, cursor })!.context.cursor;
  }
  reads = 0;
  const page = queries.items(state, session.id, { limit: 10, cursor })!;
  expect(page.items[0]?.id).toBe("item-9000");
  expect(page.items).toHaveLength(10);
  expect(reads).toBeLessThan(100);
});

it("honors the byte budget while returning a single oversized item", () => {
  const queries = new SessionQueries();
  const large = {
    ...message(0),
    markdown: "x".repeat(MAX_ITEM_PAGE_BYTES),
  } as DomainTimelineRecord;
  const state = snapshot(normalized([large, message(1)]));
  const first = queries.items(state, session.id, { limit: 2 })!;
  expect(first.items).toEqual([large]);
  expect(first.context.hasMore).toBe(true);
  expect(queries.items(state, session.id, { cursor: first.context.cursor })?.items).toEqual([
    message(1),
  ]);
});

it("builds the detail index lazily once per immutable normalized session", () => {
  const queries = new SessionQueries();
  let reads = 0;
  const items: DomainTimelineRecord[] = Array.from({ length: 1_000 }, (_, index) => message(index));
  items.push({
    kind: "directive",
    id: "detail",
    ordinal: 3_001,
    timestamp: null,
    hasDetail: true,
    summary: "Detail",
    charCount: 4,
  });
  const timeline = new Proxy(items, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    },
  });
  const value = {
    ...normalized(timeline),
    directiveDetails: new Map([["detail", { text: "full", truncated: false }]]),
  };
  const state = snapshot(value);
  let cursor: string | undefined;
  for (let index = 0; index < 4; index++)
    cursor = queries.items(state, session.id, { limit: 300, cursor })!.context.cursor;
  reads = 0;
  expect(queries.directiveDetail(state, session.id, "detail", { cursor: cursor! })?.detail).toEqual(
    { text: "full", truncated: false },
  );
  expect(reads).toBeGreaterThanOrEqual(items.length);
  reads = 0;
  queries.directiveDetail(state, session.id, "detail", { cursor: cursor! });
  expect(reads).toBeLessThan(50);
  const early = queries.items(state, session.id, { limit: 1 })!;
  expect(() =>
    queries.directiveDetail(state, session.id, "detail", { cursor: early.context.cursor }),
  ).toThrow(/does not confirm/);
  expect(queries.toolDetail(state, session.id, "detail", { cursor: cursor! })).toBeNull();
  const changedKind = snapshot({
    ...value,
    timeline: [...items.slice(0, -1), { ...message(1_000), id: "detail" }],
  });
  const replacementCursor = queries.items(changedKind, session.id, { limit: 1 })!.context.cursor;
  expect(
    queries.directiveDetail(changedKind, session.id, "detail", { cursor: replacementCursor }),
  ).toBeNull();
  // A replacement snapshot receives its own index; an append preserves cursor continuity.
  const appended = snapshot({ ...value, timeline: [...items, message(1_001)] });
  expect(queries.items(appended, session.id, { cursor })?.items).toHaveLength(1);
  const replaced = snapshot({
    ...value,
    timeline: [{ ...message(0), id: "replacement" }, ...items.slice(1)],
  });
  expect(() => queries.items(replaced, session.id, { cursor })).toThrow(/prefix/);
});

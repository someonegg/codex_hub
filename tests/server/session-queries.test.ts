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
    home: "test",
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
function message(index: number): Extract<DomainTimelineRecord, { kind: "message" }> {
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

it("inspects visible messages and structured user input with raw ordinal boundaries", () => {
  const queries = new SessionQueries();
  const timeline: DomainTimelineRecord[] = [
    { ...message(0), role: "assistant", phase: "update", itemType: "plan" },
    { id: "hidden", ordinal: 2, timestamp: null, kind: "internal", eventType: "event" },
    {
      id: "question",
      ordinal: 4,
      timestamp: null,
      kind: "user_input",
      stage: "request",
      callId: "call",
      questions: [
        {
          id: "q",
          header: "Choice",
          question: "Which?",
          options: [{ label: "A", description: "First" }],
        },
      ],
    },
    {
      id: "answer",
      ordinal: 7,
      timestamp: null,
      kind: "user_input",
      stage: "response",
      callId: "call",
      outcome: "answered",
      answers: [{ questionId: "q", answers: ["A"] }],
    },
    { id: "hidden-end", ordinal: 10, timestamp: null, kind: "internal", eventType: "event" },
  ];
  const state = snapshot(normalized(timeline));
  expect(queries.inspect(state, session.id, { limit: 2 })).toMatchObject({
    items: timeline.slice(2, 4),
    nextAfter: 10,
    hasMore: false,
  });
  const first = queries.inspect(state, session.id, { after: 0, limit: 1 })!;
  expect(first).toMatchObject({ items: [timeline[0]], nextAfter: 2, hasMore: true });
  const second = queries.inspect(state, session.id, { after: first.nextAfter, limit: 1 })!;
  expect(second).toMatchObject({ items: [timeline[2]], nextAfter: 4, hasMore: true });
  expect(queries.inspect(state, session.id, { after: 7 })).toMatchObject({
    items: [],
    nextAfter: 10,
    hasMore: false,
  });
  expect(() => queries.inspect(state, session.id, { after: 11 })).toThrow("range");
  expect(() => queries.inspect(state, session.id, { after: -1 })).toThrow();
  expect(() => queries.inspect(state, session.id, { limit: 301 })).toThrow();
  expect(queries.inspect(state, "missing", {})).toBeNull();
  expect(queries.inspect(snapshot(normalized([])), session.id, {})).toMatchObject({
    items: [],
    nextAfter: 0,
    hasMore: false,
  });
});

it("inspect honors the byte budget without truncating visible bodies or skipping records", () => {
  const queries = new SessionQueries();
  const large = { ...message(0), markdown: "x".repeat(MAX_ITEM_PAGE_BYTES - 500) };
  const next = { ...message(1), markdown: "y".repeat(1000) };
  const state = snapshot(normalized([large, next]));
  const first = queries.inspect(state, session.id, { after: 0, limit: 10 })!;
  expect(first.items).toEqual([large]);
  expect(first.hasMore).toBe(true);
  expect(queries.inspect(state, session.id, { after: first.nextAfter })!.items).toEqual([next]);
});

it("inspect skips unrelated history for latest and after reads", () => {
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
  const queries = new SessionQueries();
  reads = 0;
  const latest = queries.inspect(state, session.id, {})!;
  expect(latest.items.map((item) => item.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => `item-${9990 + index}`),
  );
  expect(reads).toBeLessThan(30);
  reads = 0;
  const page = queries.inspect(state, session.id, { after: message(9000).ordinal, limit: 2 })!;
  expect(page.items).toEqual([message(9001), message(9002)]);
  expect(page.hasMore).toBe(true);
  expect(reads).toBeLessThan(30);
});

it("inspect handles hidden timelines, sparse boundaries and exact end reads", () => {
  const hidden: DomainTimelineRecord = {
    id: "hidden",
    ordinal: 100,
    timestamp: null,
    kind: "internal",
    eventType: "event",
  };
  const queries = new SessionQueries();
  const state = snapshot(normalized([hidden]));
  for (const query of [{}, { after: 0 }, { after: 50 }, { after: 100 }]) {
    expect(queries.inspect(state, session.id, query)).toMatchObject({
      items: [],
      nextAfter: 100,
      hasMore: false,
    });
  }
  const visible = snapshot(normalized([message(0), message(1), hidden]));
  expect(queries.inspect(visible, session.id, { after: 2, limit: 1 })).toMatchObject({
    items: [message(1)],
    nextAfter: 100,
    hasMore: false,
  });
  expect(queries.inspect(visible, session.id, { after: 100 })!.items).toEqual([]);
  for (const after of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => queries.inspect(visible, session.id, { after })).toThrow();
});

it("inspect latest byte pagination follows through hidden gaps and oversized records", () => {
  const timeline: DomainTimelineRecord[] = [
    message(0),
    { ...message(1), markdown: "x".repeat(MAX_ITEM_PAGE_BYTES) },
    { id: "gap", ordinal: 5, timestamp: null, kind: "internal", eventType: "event" },
    message(2),
    message(3),
    { id: "tail", ordinal: 20, timestamp: null, kind: "internal", eventType: "event" },
  ];
  const queries = new SessionQueries();
  const state = snapshot(normalized(timeline));
  let page = queries.inspect(state, session.id, { limit: 3 })!;
  expect(page.items).toEqual([timeline[1]]);
  expect(page.nextAfter).toBe(5);
  const collected = [...page.items];
  while (page.hasMore) {
    page = queries.inspect(state, session.id, { after: page.nextAfter, limit: 1 })!;
    collected.push(...page.items);
  }
  expect(collected).toEqual([timeline[1], timeline[3], timeline[4]]);
  expect(page.nextAfter).toBe(20);
});

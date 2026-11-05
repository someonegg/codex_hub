import { expect, it, vi } from "vitest";

import {
  appendClaudeRecords,
  createClaudeState,
} from "../../src/server/adapters/claude/session-normalizer.js";
import type {
  DomainSession,
  DomainTimelineRecord,
} from "../../src/server/domain/session-domain.js";
import type { CatalogSnapshot } from "../../src/server/repository/catalog-snapshot-store.js";
import {
  MAX_ITEM_PAGE_BYTES,
  RepositoryQueryError,
  SessionQueries,
} from "../../src/server/repository/session-queries.js";

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
  },
  projectDirectory: null,
  workingDirectory: null,
  createdAt: null,
  updatedAt: null,
  parentId: null,
  childIds: [],
  agent: null,
  warningCount: 0,
  diagnostics: [],
};

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
function snapshot(timeline: readonly DomainTimelineRecord[]): CatalogSnapshot {
  return {
    signature: "test",
    diagnostics: [],
    sessions: new Map([[session.id, { session, timeline }]]),
  };
}

function countedTimeline(length: number, onRead: () => void): DomainTimelineRecord[] {
  return new Proxy(
    Array.from({ length }, (_, index) => message(index)),
    {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) onRead();
        return Reflect.get(target, property, receiver);
      },
    },
  );
}

it("reads empty timelines and noncontiguous ordinals across first, middle, last and empty pages", () => {
  const queries = new SessionQueries();
  expect(queries.messages(snapshot([]), session.id, {})?.hasMore).toBe(false);
  const state = snapshot(Array.from({ length: 5 }, (_, index) => message(index)));
  const first = queries.messages(state, session.id, { after: 0, limit: 2 })!;
  const middle = queries.messages(state, session.id, { limit: 2, after: first.nextAfter })!;
  const last = queries.messages(state, session.id, { limit: 2, after: middle.nextAfter })!;
  expect(first.items.map((item) => item.ordinal)).toEqual([1, 4]);
  expect(middle.items.map((item) => item.ordinal)).toEqual([7, 10]);
  expect(last.items.map((item) => item.ordinal)).toEqual([13]);
  expect(last.hasMore).toBe(false);
  expect(queries.messages(state, session.id, { after: last.nextAfter })).toEqual({
    session: last.session,
    nextAfter: last.nextAfter,
    hasMore: false,
    items: [],
  });
});

it("bounds deep-page array reads to binary searches plus this page", () => {
  const queries = new SessionQueries();
  let reads = 0;
  const timeline = countedTimeline(10_000, () => reads++);
  const state = snapshot(timeline);
  let after = 0;
  for (let index = 0; index < 30; index++) {
    after = queries.messages(state, session.id, { limit: 300, after })!.nextAfter;
  }
  reads = 0;
  const page = queries.messages(state, session.id, { limit: 10, after })!;
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
  const state = snapshot([large, message(1)]);
  const first = queries.messages(state, session.id, { after: 0, limit: 2 })!;
  expect(first.items).toEqual([large]);
  expect(first.hasMore).toBe(true);
  expect(queries.messages(state, session.id, { after: first.nextAfter })?.items).toEqual([
    message(1),
  ]);
});

it("messages honors the byte budget without truncating visible bodies or skipping records", () => {
  const queries = new SessionQueries();
  const large = { ...message(0), markdown: "x".repeat(MAX_ITEM_PAGE_BYTES - 500) };
  const next = { ...message(1), markdown: "y".repeat(1000) };
  const state = snapshot([large, next]);
  const first = queries.messages(state, session.id, { after: 0, limit: 10 })!;
  expect(first.items).toEqual([large]);
  expect(first.hasMore).toBe(true);
  expect(queries.messages(state, session.id, { after: first.nextAfter })!.items).toEqual([next]);
});

it("messages skips unrelated history for latest and after reads", () => {
  let reads = 0;
  const timeline = countedTimeline(10_000, () => reads++);
  const state = snapshot(timeline);
  const queries = new SessionQueries();
  reads = 0;
  const latest = queries.messages(state, session.id, {})!;
  expect(latest.items.map((item) => item.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => `item-${9990 + index}`),
  );
  expect(reads).toBeLessThan(30);
  reads = 0;
  const page = queries.messages(state, session.id, { after: message(9000).ordinal, limit: 2 })!;
  expect(page.items).toEqual([message(9001), message(9002)]);
  expect(page.hasMore).toBe(true);
  expect(reads).toBeLessThan(30);
});

it("defaults to 10 messages and accepts the maximum page length", () => {
  const queries = new SessionQueries();
  const state = snapshot(Array.from({ length: 301 }, (_, index) => message(index)));
  expect(queries.messages(state, session.id, {})!.items).toHaveLength(10);
  const maximum = queries.messages(state, session.id, { after: 0, limit: 300 })!;
  expect(maximum.items).toHaveLength(300);
  expect(maximum.hasMore).toBe(true);
  expect(queries.messages(state, session.id, { after: maximum.nextAfter })!.items).toEqual([
    message(300),
  ]);
});

it.each([0, 301, 1.5, NaN])("rejects invalid item limit %s", (limit) => {
  const queries = new SessionQueries();
  expect(() => queries.messages(snapshot([]), session.id, { limit })).toThrow(RepositoryQueryError);
  expect(() => queries.messages(snapshot([]), session.id, { limit })).toThrow(
    expect.objectContaining({ code: "invalid_query" }),
  );
});

it("fills byte-bounded pages and reads every long UTF-8 message exactly once", () => {
  const queries = new SessionQueries();
  const timeline = Array.from({ length: 10 }, (_, index) => ({
    ...message(index),
    markdown: "界".repeat(333_333),
  }));
  const state = snapshot(timeline);
  const first = queries.messages(state, session.id, { after: 0, limit: 200 })!;
  const second = queries.messages(state, session.id, { limit: 200, after: first.nextAfter })!;
  const last = queries.messages(state, session.id, { limit: 200, after: second.nextAfter })!;
  expect(first.items).toHaveLength(4);
  expect(second.items).toHaveLength(4);
  expect(last.items).toHaveLength(2);
  expect(first.hasMore).toBe(true);
  expect(second.hasMore).toBe(true);
  expect(last.hasMore).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(first.items))).toBeLessThanOrEqual(
    MAX_ITEM_PAGE_BYTES + 2,
  );
  expect([...first.items, ...second.items, ...last.items]).toEqual(timeline);
});

it("reuses exact byte sizes across immutable snapshots without retaining stale item sizes", () => {
  const queries = new SessionQueries();
  const first = message(0);
  const next = message(1);
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    queries.messages(snapshot([first]), session.id, { after: 0 });
    queries.messages(snapshot([first, next]), session.id, { after: 0 });
    expect(stringify.mock.calls.filter(([value]) => value === first)).toHaveLength(1);
    const rewritten = { ...first, markdown: "界".repeat(MAX_ITEM_PAGE_BYTES) };
    const page = queries.messages(snapshot([rewritten, next]), session.id, {
      after: 0,
    })!;
    expect(page.items).toEqual([rewritten]);
    expect(page.hasMore).toBe(true);
  } finally {
    stringify.mockRestore();
  }
});

it("returns the first Claude message after polling an empty session", () => {
  const queries = new SessionQueries();
  const empty = queries.messages(snapshot([]), session.id, { after: 0 })!;
  expect(empty).toMatchObject({ items: [], nextAfter: 0, hasMore: false });
  const state = appendClaudeRecords(createClaudeState("claude"), [
    {
      ordinal: 47,
      value: { type: "user", message: { role: "user", content: "First message" } },
    },
  ]);
  const populated = snapshot(state.timeline);
  const first = queries.messages(populated, session.id, { after: empty.nextAfter })!;
  expect(first.items).toHaveLength(1);
  expect(first.items[0]).toMatchObject({ ordinal: 1, markdown: "First message" });
  expect(
    queries.messages(populated, session.id, {
      after: first.nextAfter,
    }),
  ).toMatchObject({ items: [], nextAfter: 1, hasMore: false });
});

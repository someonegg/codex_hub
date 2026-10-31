import type {
  DomainDirectiveDetail,
  DomainInternalDetail,
  DomainSession,
  DomainTimelineRecord,
  DomainToolDetail,
  NormalizedSession,
} from "../domain/session-domain.js";
import type { CatalogSnapshot } from "./catalog-snapshot-store.js";
import { OpaqueCursorCodec } from "./opaque-cursor.js";
import type {
  DirectiveDetailCriteria,
  InternalDetailCriteria,
  ItemPageCriteria,
  ToolDetailCriteria,
} from "./session-query-criteria.js";
import type { IndexedSession } from "./timeline-prefix-registry.js";

const DEFAULT_ITEM_LIMIT = 100;
const MAX_ITEM_LIMIT = 300;
export const MAX_ITEM_PAGE_BYTES = 4 * 1024 * 1024;

export class RepositoryQueryError extends Error {
  constructor(
    readonly code: "invalid_query" | "timeline_changed",
    message: string,
  ) {
    super(message);
  }
}

export interface TimelinePageContext {
  readonly session: DomainSession;
  readonly cursor: string;
  readonly hasMore: boolean;
}

export interface ItemPageResult {
  readonly context: TimelinePageContext;
  readonly items: readonly DomainTimelineRecord[];
}

export interface ToolDetailResult {
  readonly detail: DomainToolDetail;
}

export interface DirectiveDetailResult {
  readonly detail: DomainDirectiveDetail;
}

export interface InternalDetailResult {
  readonly detail: DomainInternalDetail;
}

export class SessionQueries {
  constructor(private readonly cursors = new OpaqueCursorCodec()) {}

  session(snapshot: CatalogSnapshot, id: string): DomainSession | null {
    const versioned = snapshot.sessions.get(id);
    return versioned?.normalized.session ?? null;
  }

  messages(snapshot: CatalogSnapshot, id: string, query: { limit?: number; after?: number }) {
    validateItemQuery(query);
    if (query.after !== undefined && (!Number.isSafeInteger(query.after) || query.after < 0))
      throw new RepositoryQueryError("invalid_query", "after must be a nonnegative safe integer");
    const versioned = snapshot.sessions.get(id);
    if (!versioned) return null;
    const timeline = versioned.normalized.timeline;
    const end = timeline.at(-1)?.ordinal ?? 0;
    if ((query.after ?? 0) > end)
      throw new RepositoryQueryError("invalid_query", "after exceeds the current timeline range");
    const limit = query.limit ?? 10;
    let start = 0;
    if (query.after === undefined) {
      let remaining = limit;
      start = timeline.length;
      while (start > 0 && remaining > 0) {
        start--;
        if (isMessageVisible(timeline[start]!)) remaining--;
      }
    } else {
      let upper = timeline.length;
      while (start < upper) {
        const middle = start + Math.floor((upper - start) / 2);
        if (timeline[middle]!.ordinal <= query.after) start = middle + 1;
        else upper = middle;
      }
    }
    const items: DomainTimelineRecord[] = [];
    let bytes = 0;
    let index = start;
    for (; index < timeline.length; index++) {
      const item = timeline[index]!;
      if (!isMessageVisible(item)) continue;
      if (items.length >= limit) break;
      const size = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length ? 1 : 0);
      if (items.length > 0 && bytes + size > MAX_ITEM_PAGE_BYTES) break;
      items.push(item);
      bytes += size;
    }
    return {
      session: versioned.normalized.session,
      items,
      nextAfter: index < timeline.length ? (timeline[index - 1]?.ordinal ?? 0) : end,
      hasMore: index < timeline.length,
    };
  }

  items(snapshot: CatalogSnapshot, id: string, query: ItemPageCriteria): ItemPageResult | null {
    validateItemQuery(query);
    const versioned = snapshot.sessions.get(id);
    if (versioned === undefined) return null;
    const requestedBoundary = this.#resolveReadBoundary(id, versioned, query.cursor);
    const { normalized } = versioned;
    const after = requestedBoundary.throughOrdinal;
    let start = 0;
    let end = normalized.timeline.length;
    while (start < end) {
      const middle = start + Math.floor((end - start) / 2);
      if (normalized.timeline[middle]!.ordinal <= after) start = middle + 1;
      else end = middle;
    }
    const limit = query.limit ?? DEFAULT_ITEM_LIMIT;
    const items: DomainTimelineRecord[] = [];
    let itemBytes = 0;
    for (let index = start; index < normalized.timeline.length && items.length < limit; index++) {
      const item = normalized.timeline[index]!;
      const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length > 0 ? 1 : 0);
      if (items.length > 0 && itemBytes + bytes > MAX_ITEM_PAGE_BYTES) break;
      items.push(item);
      itemBytes += bytes;
    }
    const boundary =
      items.length === 0
        ? requestedBoundary
        : versioned.timelinePrefixIndex.boundaryAt(normalized.timeline, items.at(-1)!.ordinal)!;
    return {
      context: this.#readContext(id, versioned, boundary),
      items,
    };
  }

  updates(snapshot: CatalogSnapshot, id: string, cursor: string): TimelinePageContext | null {
    const versioned = snapshot.sessions.get(id);
    if (versioned === undefined) return null;
    const boundary = this.#resolveReadBoundary(id, versioned, cursor);
    return this.#readContext(id, versioned, boundary);
  }

  toolDetail(
    snapshot: CatalogSnapshot,
    id: string,
    itemId: string,
    query: ToolDetailCriteria,
  ): ToolDetailResult | null {
    const versioned = snapshot.sessions.get(id);
    if (versioned === undefined) return null;
    const boundary = this.#resolveReadBoundary(id, versioned, query.cursor);
    const detail = itemDetail(
      versioned.normalized,
      itemId,
      "tool",
      versioned.normalized.toolDetails,
      boundary.throughOrdinal,
    );
    if (detail === null) return null;
    return { detail };
  }

  directiveDetail(
    snapshot: CatalogSnapshot,
    id: string,
    itemId: string,
    query: DirectiveDetailCriteria,
  ): DirectiveDetailResult | null {
    const versioned = snapshot.sessions.get(id);
    if (versioned === undefined) return null;
    const boundary = this.#resolveReadBoundary(id, versioned, query.cursor);
    const detail = itemDetail(
      versioned.normalized,
      itemId,
      "directive",
      versioned.normalized.directiveDetails,
      boundary.throughOrdinal,
    );
    if (detail === null) return null;
    return { detail };
  }

  internalDetail(
    snapshot: CatalogSnapshot,
    id: string,
    itemId: string,
    query: InternalDetailCriteria,
  ): InternalDetailResult | null {
    const versioned = snapshot.sessions.get(id);
    if (versioned === undefined) return null;
    const boundary = this.#resolveReadBoundary(id, versioned, query.cursor);
    const detail = itemDetail(
      versioned.normalized,
      itemId,
      "internal",
      versioned.normalized.internalDetails,
      boundary.throughOrdinal,
    );
    if (detail === null) return null;
    return { detail };
  }

  #resolveReadBoundary(id: string, versioned: IndexedSession, cursor: string | undefined) {
    const { normalized, timelinePrefixIndex } = versioned;
    if (cursor === undefined) return timelinePrefixIndex.boundaryAt(normalized.timeline, 0)!;
    const cursorResult = this.cursors.decodeTimeline(cursor);
    if (cursorResult.kind === "malformed") {
      throw new RepositoryQueryError("invalid_query", "cursor is malformed");
    }
    if (cursorResult.kind === "untrusted") {
      throw new RepositoryQueryError(
        "timeline_changed",
        "The timeline cursor is no longer valid; reload this session",
      );
    }
    const decoded = cursorResult.value;
    if (decoded.s !== id)
      throw new RepositoryQueryError("invalid_query", "cursor belongs to another session");
    const boundary = timelinePrefixIndex.boundaryAt(normalized.timeline, decoded.o);
    if (
      boundary === null ||
      boundary.throughOrdinal !== decoded.o ||
      !timelinePrefixIndex.matches(normalized.timeline, boundary, decoded.p)
    ) {
      throw new RepositoryQueryError(
        "timeline_changed",
        "The loaded timeline is no longer a prefix of this session",
      );
    }
    return boundary;
  }

  #readContext(
    id: string,
    versioned: IndexedSession,
    boundary: { throughOrdinal: number; timelinePrefixRevision: string },
  ): TimelinePageContext {
    return {
      session: versioned.normalized.session,
      cursor: this.cursors.encodeTimeline(
        id,
        boundary.throughOrdinal,
        boundary.timelinePrefixRevision,
      ),
      hasMore: boundary.throughOrdinal < (versioned.normalized.timeline.at(-1)?.ordinal ?? 0),
    };
  }
}

const itemIndexes = new WeakMap<NormalizedSession, ReadonlyMap<string, DomainTimelineRecord>>();

function indexedItem(normalized: NormalizedSession, itemId: string) {
  let index = itemIndexes.get(normalized);
  if (!index) {
    index = new Map(normalized.timeline.map((item) => [item.id, item]));
    itemIndexes.set(normalized, index);
  }
  return index.get(itemId);
}

function itemDetail<T>(
  normalized: NormalizedSession,
  itemId: string,
  kind: DomainTimelineRecord["kind"],
  details: ReadonlyMap<string, T>,
  throughOrdinal: number,
): T | null {
  const item = indexedItem(normalized, itemId);
  if (item?.kind !== kind) return null;
  const detail = details.get(itemId);
  if (detail === undefined) return null;
  if (item.ordinal > throughOrdinal) {
    throw new RepositoryQueryError("invalid_query", "cursor does not confirm the requested item");
  }
  return detail;
}

function validateItemQuery(query: ItemPageCriteria): void {
  if (
    query.limit !== undefined &&
    (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_ITEM_LIMIT)
  ) {
    throw new RepositoryQueryError(
      "invalid_query",
      `limit must be between 1 and ${MAX_ITEM_LIMIT}`,
    );
  }
}

function isMessageVisible(item: DomainTimelineRecord): boolean {
  return item.kind === "message" || item.kind === "user_input";
}

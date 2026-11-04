import type { DomainTimelineRecord } from "../domain/session-domain.js";
import type { CatalogSnapshot } from "./catalog-snapshot-store.js";
export const MAX_ITEM_PAGE_BYTES = 4 * 1024 * 1024;
export class RepositoryQueryError extends Error {
  constructor(
    readonly code: "invalid_query" | "after_out_of_range",
    message: string,
  ) {
    super(message);
  }
}
export class SessionQueries {
  // Published timeline records are immutable; release cached sizes with their records.
  readonly #itemBytes = new WeakMap<DomainTimelineRecord, number>();
  session(snapshot: CatalogSnapshot, id: string) {
    return snapshot.sessions.get(id)?.normalized.session ?? null;
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
      throw new RepositoryQueryError(
        "after_out_of_range",
        "after exceeds the current timeline range",
      );
    const limit = query.limit ?? 10;
    let start = 0;
    if (query.after === undefined) {
      start = Math.max(0, timeline.length - limit);
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
      if (items.length >= limit) break;
      let itemBytes = this.#itemBytes.get(item);
      if (itemBytes === undefined) {
        itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
        this.#itemBytes.set(item, itemBytes);
      }
      const size = itemBytes + (items.length ? 1 : 0);
      if (items.length > 0 && bytes + size > MAX_ITEM_PAGE_BYTES) break;
      items.push(item);
      bytes += size;
    }
    return {
      session: versioned.normalized.session,
      items,
      nextAfter: items.at(-1)?.ordinal ?? end,
      hasMore: index < timeline.length,
    };
  }
}
function validateItemQuery(query: { limit?: number }) {
  if (
    query.limit !== undefined &&
    (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 300)
  )
    throw new RepositoryQueryError("invalid_query", "limit must be between 1 and 300");
}

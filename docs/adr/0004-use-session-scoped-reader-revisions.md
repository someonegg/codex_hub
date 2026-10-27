---
status: superseded by ADR-0009
date: 2026-07-30
---

# Use session-scoped revisions for reader consistency

Superseded by [ADR-0009](0009-use-opaque-single-writer-timeline-cursors.md).

## Context and Problem Statement

The immutable catalog snapshot used one global generation for both session-list offsets and single-session reader requests. An active rollout therefore invalidated timeline pagination and lazy detail for every other session, even when their published views had not changed. The reader needs a narrower consistency boundary without giving up whole-file decoding, ordinal pagination, or safe invalidation after a session is replaced or truncated.

## Decision Drivers

- Let an unchanged session continue paging while unrelated sessions update.
- Reject old ordinals and item IDs when the requested session itself changes.
- Keep catalog-list offsets consistent with global sorting, facets, and membership.
- Preserve the source-adapter boundary and avoid making adapters authoritative for aggregate session versions.
- Avoid exposing source fingerprints, content equality, or process-local counters through the API.

## Considered Options

- Keep one catalog-wide generation and restart every reader after any catalog change.
- Let each source adapter provide a session content revision derived from its storage metadata.
- Derive a session revision from the final aggregate session view and expose a separate opaque token.

## Decision Outcome

Chosen option: "Derive a session revision from the final aggregate session view and expose a separate opaque token", because the aggregate view is the first boundary that contains every reader-visible field, including linked parent and child relationships.

Session detail, item pages, tool detail, and directive detail use a string `sessionRevision`. After relationship linking, the repository canonicalizes the published `childIds` array by opaque ID in code-unit ascending order, then computes an internal digest from that exact final normalized session order. An unchanged digest reuses the current revision; a changed, deleted-and-reappeared, or otherwise new incarnation receives a 192-bit opaque token derived from a random per-process key and a monotonic sequence. The digest remains server-private, and revision state is published atomically with the immutable catalog snapshot.

This decision refines the timeline consistency boundary established by ADR-0001 while retaining its whole-file snapshots, serialized refresh, bounded responses, and ordinal pagination.

### Positive Consequences

- Unrelated live sessions no longer interrupt timeline pages or lazy detail.
- Replacement, truncation, metadata, relationship, timeline, and lazy-detail changes still invalidate old requests safely.
- Source adapters remain responsible for normalization and storage caching, not aggregate API version semantics.
- Cryptographically derived opaque tokens avoid exposing fingerprints or counters and do not require retaining every historical revision to prevent process-local reuse.
- Catalog pagination retains the global consistency semantics it needs.

### Negative Consequences

- The snapshot store must maintain per-session digest and token state.
- Canonical hashing scans reader-visible session data and adds CPU and memory pressure to changed catalog publication.
- Every newly exposed session field must be added to the canonical digest contract.
- Any semantically unordered API collection must be canonicalized before publication; the digest must not silently normalize a different view than the API returns.
- The API and client must carry two explicitly different consistency tokens and stale error codes.
- Revisions remain process-local; a future multi-process deployment would require sticky routing or a shared/content-addressed token strategy.

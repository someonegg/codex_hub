---
status: superseded by ADR-0009
date: 2026-07-31
---

# Use conditional read cursors for session resources

Superseded by [ADR-0009](0009-use-opaque-single-writer-timeline-cursors.md),
which hides the cursor fields and gives only the items endpoint cursor ownership.
The structured cursor and shared response envelope below are historical.

## Context and Problem Statement

Exact session-revision locking rejected harmless appends. A separate continuity
endpoint let clients migrate a confirmed timeline prefix, but introduced revision
polling, migration races, and retries. Lazy details could remain loading after a
revision conflict without knowing whether their loaded prefix was still valid.

All session-scoped reads needed the same prefix precondition: preserve loaded
content when only the suffix changes, and fail closed when confirmed content is
modified, removed, reordered, or truncated.

## Considered Options

- Exact revision locking with a full reset: simple, but appends discard reading state.
- Exact locking plus continuity migration: preserves a proven prefix, but adds an
  endpoint, intermediate states, and revision races.
- One conditional cursor for every session-scoped read (chosen): removes migration
  requests, at the cost of shared cursor coordination and repeated response context.

## Decision Outcome

Use a structured cursor containing `sessionRevision`, `throughOrdinal`, and
`timelinePrefixRevision` as flat query parameters. Zero denotes the empty prefix;
an initial metadata request may omit the cursor. Subsequent metadata, item-page,
tool, and directive reads send all three fields.

Validate the boundary and keyed prefix token against the newest immutable
snapshot. A matching prefix permits an older session revision and returns the
latest revision. A missing boundary or mismatched token returns
`stale_timeline_prefix`; there is no revision-migration retry.

Every successful response includes a `context` envelope with the latest session,
updated cursor, and `hasMore`. Only item pages advance the boundary; other reads
preserve it. Clients adopt context only if the request cursor still matches their
current cursor. Prefix conflicts stop pending work, preserve the old view, mark
details unavailable, and require explicit reload from the empty prefix.

Keep the existing process-private, domain-separated HMAC prefix chain and compact
24-byte state per boundary. Canonical item encoding feeds both the session-view
digest and prefix chain. This originally refined ADR-0004's published-view revision
rather than replacing it; ADR-0009 subsequently superseded both records.

## Consequences

- Appends preserve accumulated pages and mounted state without migration requests.
- Metadata and lazy details share deterministic prefix-conflict recovery.
- Prefix validation requires one boundary lookup and fixed-size comparison;
  timeline items carry no consistency metadata.
- Every response repeats session context, and clients coordinate concurrent
  responses using compare-and-set cursor adoption.
- Prefix storage costs approximately 24 bytes per item plus the empty slot and
  object overhead; ordinals must remain strictly increasing.
- Process restart invalidates tokens. Client and server ship together without a
  rolling-upgrade compatibility path.

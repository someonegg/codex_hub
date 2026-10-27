---
status: superseded by ADR-0010
date: 2026-07-30
---

# Use query-scoped revisions for session-list pagination

Superseded by [ADR-0010](0010-use-opaque-session-list-cursors.md).

## Context and Problem Statement

Session-list offset pagination used one catalog-wide generation. Any published source change invalidated every in-progress list, even when diagnostics, unrelated content, or another query changed without affecting the current query's ordered session IDs. Pagination needs to reject changes that could silently duplicate or omit matching sessions without promising a globally immutable catalog view.

## Decision Drivers

- Prevent silent duplicates and omissions when offset pagination spans changes to the ordered matching session IDs.
- Avoid invalidating a query for source diagnostics or content that cannot affect that query's membership or order.
- Keep query details and result fingerprints opaque to clients.
- Preserve deterministic aggregation across source registration order and equal sort values.
- Retain offset pagination and the existing structured filtering and sorting behavior.

## Considered Options

- Use a source/global snapshot generation.
- Use a generation derived from the global complete-list projection.
- Use a query-scoped revision derived from the canonical query and ordered matching IDs.
- Use keyset pagination without a revision.

## Decision Outcome

Chosen option: "Use a query-scoped revision derived from the canonical query and ordered matching IDs", because it places invalidation at the exact consistency boundary required for safe offsets.

After structured filtering and deterministic sorting, the server computes a 32-character base64url `listRevision` from the canonical filters and the complete ordered matching session ID sequence. The canonical filters contain exact `project`, normalized timestamps, and the default-expanded `archiveScope`; they exclude `offset` and `limit`. Summaries, diagnostics, and complete session content are not inputs.

The revision is a truncated HMAC using a random per-process key and length-framed fields. It therefore does not reveal a reusable query or result fingerprint, and tokens from an earlier process naturally become stale. Session ID is the final sort tie-breaker. A later page must provide the first page's revision, and any supplied non-matching revision is rejected.

Source snapshot signatures remain internal refresh signals. A changed signature still publishes a new immutable snapshot and status atomically, but the snapshot has no public or internal global catalog generation.

This decision further refines the list consistency boundary described by ADR-0001 and ADR-0004. It does not supersede either decision.

### Positive Consequences

- Diagnostics, unavailable-source recovery, summaries, and unrelated content changes do not restart pagination when ordered membership is unchanged.
- Membership additions, removals, and reordering invalidate unsafe offsets.
- Revisions are scoped to the exact canonical filters and cannot be reused accidentally across different filter sets.
- Clients cannot correlate a stable public content digest across process restarts.
- Source registration order and equal time/title values cannot introduce nondeterministic ordering.

### Negative Consequences

- Different pages may contain summaries produced from different snapshot moments.
- The guarantee is limited to preventing silent duplicates or omissions caused by a changed ordered ID sequence; it is not a complete cross-page content snapshot.
- Every list query must traverse the complete matching result and HMAC every ordered ID before slicing the requested page.
- Process restarts invalidate all outstanding pagination revisions.
- Offset pagination still requires a restart rather than resuming from a stable key when membership or order changes.

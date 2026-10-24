---
status: superseded by ADR-0021
date: 2026-08-01
---

# Use opaque cursors for session-list pagination

Superseded by [ADR-0021](0021-split-catalog-structure-and-activity.md).

## Context and Problem Statement

Query-scoped revisions correctly prevented duplicates and omissions, but the API separately exposed an offset and revision. Clients had to preserve and combine those fields, even though both are implementation details of one pagination continuation.

## Decision Drivers

- Preserve query-scoped protection against list membership or ordering changes.
- Hide offsets and revision tokens from client logic.
- Bind continuations to the normalized filter query.
- Let explicit catalog refresh bypass the freshness cache and restart pagination.

## Considered Options

- Keep public offset and revision parameters.
- Wrap the existing offset, normalized query, and query-scoped revision in an opaque cursor.
- Replace offset pagination with revision-free keyset pagination.

## Decision Outcome

Chosen option: "Wrap the existing offset, normalized query, and query-scoped revision in an opaque cursor", because it simplifies the public contract without weakening the established no-duplicate/no-omission guarantee.

Initial requests contain filters and a limit. Later requests add one authenticated cursor. A cursor is valid only for the same normalized query and ordered matching-ID revision; changed membership or order returns `stale_list_cursor`. `fresh=true` is initial-request-only and forces catalog discovery before returning the first page.

Archive state was later removed from the server query and cursor filter surface by [ADR-0013](0013-filter-session-archive-state-in-the-browser.md).

A structurally valid cursor with an unverifiable signature, including one retained across a process restart, is classified as `stale_list_cursor` so the client can safely restart at the first page. Structurally malformed cursor input remains `invalid_query`.

This decision supersedes [ADR-0005](0005-use-query-scoped-revisions-for-session-list-pagination.md).

### Positive Consequences

- Client code stores and transmits one continuation value without parsing it.
- Query, offset, and revision mismatches fail on the server.
- Stale recovery can replace the accumulated list with a clean first page.
- Forced refresh has explicit cache-bypass semantics.

### Negative Consequences

- Cursor payloads are process-local and invalid after restart.
- The server still computes a revision over the complete ordered match set.
- Cursor debugging requires server knowledge of the internal protocol.
- Membership changes restart pagination instead of resuming at a stable key.

## Pros and Cons of the Options

### Public offset and revision

- Good: Is easy to inspect manually.
- Bad: Exposes protocol assembly and consistency fields to clients.

### Opaque query-scoped cursor

- Good: Keeps the existing guarantee behind a smaller contract.
- Bad: Adds authenticated encoding and decoding.

### Revision-free keyset pagination

- Good: Avoids hashing the complete match set.
- Bad: Does not directly detect earlier membership changes and changes traversal semantics.

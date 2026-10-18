---
status: accepted
date: 2026-07-30
---

# Use JSONL-only session discovery

## Context and Problem Statement

The reader treated rollout JSONL as its correctness source while optionally using Codex SQLite state for discovery and identity metadata. Maintaining two discovery paths added schema detection, compatibility fallback, configuration, cache invalidation, diagnostics, and tests even though SQLite was not required to decode a session. The project must choose whether that optional enrichment justifies a second source of catalog truth.

## Decision Drivers

- Keep rollout JSONL as the single session discovery and identity source.
- Reduce coupling to Codex-internal state schemas and Node's SQLite API.
- Preserve generation, caching, pagination, polling, and normalization behavior.
- Accept reduced metadata rather than introduce a replacement index or persistent cache.

## Considered Options

- Retain JSONL and SQLite as combined catalog sources.
- Keep the SQLite adapter but disable it by default.
- Remove SQLite discovery and metadata enrichment completely.

## Decision Outcome

Chosen option: "Remove SQLite discovery and metadata enrichment completely", because a JSONL-only catalog has one explicit source of truth and removes a compatibility surface that is not needed for session correctness.

Catalog discovery now scans only the allowlisted `sessions/` and `archived_sessions/` roots. Session identity comes from rollout records and the registered file descriptor. An unreadable registered rollout produces a JSONL-only unavailable placeholder.

### Positive Consequences

- Catalog construction no longer depends on a private database schema or SQLite runtime support.
- Discovery, identity resolution, cache invalidation, status reporting, configuration, and diagnostics have fewer modes.
- A session's displayed identity is derived from the same JSONL content used for its timeline.
- The reader still creates no persistent index or application cache.

### Negative Consequences

- Rollouts discoverable only through SQLite metadata are no longer shown.
- Database-only titles, paths, parent relationships, agent fields, and precise timestamps are no longer available.
- Unreadable rollouts cannot retain SQLite-derived identity in their unavailable placeholders.
- Restoring metadata enrichment later would require a new source contract and cache policy.

## Pros and Cons of the Options

### Retain JSONL and SQLite as combined catalog sources

- Good: Preserves database-only rollout discovery and richer metadata when schemas are compatible.
- Good: Keeps current behavior for users with readable Codex state databases.
- Bad: Requires two-source merge rules, schema feature detection, fallback diagnostics, and metadata-sensitive cache invalidation.
- Bad: Couples the reader to a private database format despite JSONL remaining the correctness boundary.

### Keep the SQLite adapter but disable it by default

- Good: Makes the common path JSONL-only while retaining an opt-in compatibility escape hatch.
- Good: Reduces default exposure to incompatible or corrupt databases.
- Bad: Retains nearly all adapter code, configuration, documentation, and test burden.
- Bad: Preserves multiple externally observable catalog modes and delays removal of the ambiguous source contract.

### Remove SQLite discovery and metadata enrichment completely

- Good: Establishes one discovery and identity path with no compatibility mode.
- Good: Removes database schema and runtime dependencies without changing JSONL normalization.
- Bad: Gives up metadata and rollout entries available only from SQLite.
- Bad: Makes unavailable placeholders intentionally sparse.

## Current behavior clarification, 2026-10-18

Unreadable rollouts are now skipped with server-side diagnostics and retried on
later refreshes; the placeholder behavior above is historical.

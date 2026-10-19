---
status: superseded by ADR-0012
date: 2026-07-28
---

Superseded by [ADR-0012](0012-use-checkpointed-incremental-rollout-loading.md). Atomic snapshot publication, paged timeline APIs, and whole-file recovery remain in force; ADR-0012 replaces the changed-rollout whole-file reread decision.

# Use generation-based whole-file session snapshots

## Context and Problem Statement

Codex session rollouts are live JSONL event streams whose observed schema is not a stable public interface. The reader must remain correct while files are appended, damaged, replaced, or described by an incompatible SQLite state database. At the same time, unbounded detail responses and concurrent catalog refreshes could expose inconsistent or excessive data. The architecture must balance correctness and bounded responses against the complexity of maintaining incremental file state.

## Decision Drivers

- Preserve read-only correctness when JSONL files are active, partial, malformed, replaced, or paired with incompatible SQLite metadata.
- Keep catalog entries, opaque path mappings, and normalized sessions mutually consistent.
- Bound timeline and tool responses without introducing a persistent index.
- Isolate Codex format evolution from the API and React client.
- Avoid an incremental state machine until corpus size and append behavior demonstrate that it is necessary.

## Considered Options

- Minimal request-time parsing with an unversioned catalog and whole-session detail responses.
- Incremental tail parsing with per-file offsets, watcher-assisted refresh, and ETag-based client polling.
- Generation-based whole-file snapshots with serialized refresh, whole-session cache replacement, and paged timeline APIs.

## Decision Outcome

Chosen option: "Generation-based whole-file snapshots with serialized refresh and paged timeline APIs", because it provides a coherent source snapshot and bounded browser responses while retaining whole-file rereading as a simple correctness fallback.

The repository publishes the catalog, opaque session-ID registry, and normalized cache entries as one immutable, process-local generation. Refreshes are serialized. A changed file fingerprint causes that session to be decoded and normalized from the beginning; the MVP does not retain tail offsets or partial fragments between refreshes. Timeline items are served through a versioned, generation-scoped paged API, and stale clients restart pagination.

### Positive Consequences

- List, detail, and tool requests cannot observe independently refreshed source maps.
- File truncation, replacement, parser changes, and uncertain append behavior recover through a whole-file reread.
- Timeline and tool payloads are bounded before reaching the browser.
- Future incremental readers can replace repository internals without changing the normalized domain or API shape.
- All derived state is in memory and disappears on restart.

### Negative Consequences

- Active or large sessions may be reparsed in full after each changed fingerprint.
- Generation changes can make clients restart timeline pagination and refetch items.
- Serialized refresh and snapshot publication add more machinery than direct request-time parsing.
- Process restart discards all caches and requires rebuilding normalized state.
- The design does not provide sub-second automatic updates or optimal behavior for very large corpora.

## Pros and Cons of the Options

### Minimal request-time parsing with whole-session responses

- Good: Has the shortest correctness path, the fewest state transitions, and the smallest dependency and test surface.
- Good: Fits the observed corpus of roughly 3.3 MB, which parsed locally in about 0.1 seconds.
- Bad: Concurrent requests can duplicate catalog work without coordination.
- Bad: Whole-session responses do not bound large tool payloads or long conversations.
- Bad: Adding paging and consistency semantics later could break an unversioned API.

### Incremental tail parsing

- Good: Avoids reparsing unchanged prefixes of active sessions.
- Good: Scales naturally toward frequent automatic refresh and much larger corpora.
- Bad: Must correctly handle truncation, replacement, inode reuse, archive moves, partial tails, decoder-version changes, and atomic publication.
- Bad: A state error may silently skip or duplicate events, making the cost of being wrong high.
- Bad: The observed corpus and append behavior do not yet justify watcher, offset, ETag, and client-cache complexity.

### Generation-based whole-file snapshots with paged APIs

- Good: Atomically aligns catalog, ID mappings, and normalized data.
- Good: Uses whole-file rereading as a clear recovery path while bounding client responses.
- Good: Creates stable adapter and API seams for future scale work.
- Bad: Repeats parsing work for changed files and introduces generation-aware client behavior.
- Bad: Requires explicit performance gates so a large corpus does not degrade unnoticed.

---
status: accepted
date: 2026-10-16
---

# Long-poll session structure with best-effort timestamps

## Context and Problem Statement

Catalog pagination and periodic summary refreshes repeatedly transfer metadata and
couple ordering, relationships, and diagnostics. A separate activity API and cache
would add another request lifecycle merely to keep advisory timestamps current.

## Decision Drivers

- Timestamp and conversation changes must not retransmit catalog structure.
- Detect changes to parent relationships, archive state, projects, and display titles.
- Reuse fingerprints, incremental reads, shared snapshots, and refresh coalescing.
- Avoid dedicated timestamp requests, caches, and timers.

## Considered Options

- Periodically refresh filtered, paginated summaries.
- Long-poll minimal structure and fetch activity separately.
- Long-poll structure with best-effort timestamps in the same response.

## Decision Outcome

Return complete `{ revision, projects, sessions }` snapshots. Each session carries
nullable `updatedAt`, but the revision hashes only the structure after canonical ID
sorting. Resolve display titles with the existing nickname resolver on each probe;
the underlying snapshot signature cannot substitute for the presentation revision.
`isChild` reflects a declared parent relationship; `parentId` reflects only a
resolved link. Details retain a separate type with full metadata.

`after` is the only list query parameter. Matching revisions wait up to 25 seconds
with shared 1.5-second probes, at most 100 waiters, and no probing when idle.
Timestamp-only changes do not wake waiters. Unchanged requests return `204` without
a body. Disconnect, timeout, and shutdown release resources.

The browser replaces structure atomically and preserves the newer valid timestamp
for each retained ID. Reader metadata feeds displayed session timestamps back into
the local list, including page loads, refreshes, and automatic updates responses. Feedback is
best effort: unknown IDs and unloaded lists are ignored, duplicate or older times
are no-ops, and removed IDs are not retained. There is no timestamp request, timer,
or persistent cache. Hidden pages pause list requests and reconnect when visible.

Timestamps determine browser ordering without affecting structural revisions.
Reader automatic updates retains separate constants and semantics, including timestamps in its
revision. Catalog diagnostics are server-only and deduplicated by content.

### Positive Consequences

- Active conversations do not repeatedly transmit structure.
- Complete data keeps project counts and direct-child relationships consistent.
- Title changes wake structure subscribers; timestamps and content do not.
- One catalog request lifecycle replaces separate structure and activity channels.

### Negative Consequences

- Initial transfer and browser memory include the complete catalog.
- Unopened sessions may keep stale timestamps until another list snapshot arrives.
- Retaining newer observed times can hide a source timestamp correction backwards
  until the browser reloads.

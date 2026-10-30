---
status: accepted
date: 2026-09-04
---

# Expose session index names as presentation metadata

Current scope: the server resolves display titles for catalog, detail, inspect,
and updates responses. Title changes affect catalog and reader revisions.
The Codex adapter owns advisory index reading; API mapping applies title precedence.
See the [catalog reference](../technical-reference.md#catalog) and
[reader reference](../technical-reference.md#reader-and-automatic-updates). The decision below records
its introduction.

## Context and Problem Statement

Codex records user-facing thread names in `session_index.jsonl`, separately from rollout files. The hub should prefer these names without conflating presentation metadata with the canonical rollout title or allowing an advisory file to create sessions, reorder paginated results, invalidate cursors, or wake automatic updates polling when only a nickname changes.

## Decision Drivers

- Prefer a valid `session_index.jsonl` thread name over rollout-derived title fallbacks.
- Keep session discovery, ordering, pagination, timeline continuity, and automatic updates change detection authoritative to rollout state.
- Tolerate a missing, malformed, incomplete, or changing advisory index.
- Observe index changes during ordinary catalog refresh without adding a file watcher.
- Keep canonical and presentation title semantics explicit at the API boundary.

## Considered Options

- Merge thread names into normalized sessions inside the Codex source.
- Return thread names as a new public API field and resolve title precedence in the browser.
- Overlay thread names while mapping authoritative repository sessions to API responses.

## Decision Outcome at Introduction

Chosen option: "Return thread names as a public nickname field and resolve title precedence in the browser", because it keeps canonical rollout state explicit while isolating presentation policy from repository and update revision semantics.

The Codex adapter refreshes a bounded, best-effort snapshot of `session_index.jsonl` whenever catalog discovery reaches the source. Records are aggregated in physical order by native session ID, with the last complete valid record winning. Session API responses expose the rollout-backed `title` and a nullable `nickname`; the browser displays `nickname ?? title`. update revision calculation omits `nickname` while retaining the canonical title.

### Positive Consequences

- Canonical and presentation titles remain distinguishable throughout the API.
- Adding, removing, or editing the index cannot create sessions or invalidate list and timeline cursors.
- A nickname-only change does not wake an automatic updates long poll.
- Invalid index data degrades to the existing rollout title fallback.

### Negative Consequences

- The public session schema gains a nullable `nickname` field.
- Every client must apply the display-title precedence consistently.
- An already open reader does not receive an update solely because its nickname changed.

## Pros and Cons of the Options

### Merge names into normalized sessions

- Good: Gives the domain model one resolved title value.
- Bad: Couples advisory file changes to session snapshots, sorting, dirty tracking, and revisions.

### Add a public nickname field

- Good: Keeps canonical and presentation names explicit at the API boundary.
- Good: Lets update revision calculation exclude presentation metadata without carrying a second session view.
- Bad: Changes the public contract and requires title precedence logic in clients.

### Overlay names during API mapping

- Good: Preserves authoritative repository and cursor semantics while presenting one resolved title.
- Good: Applies consistently to list, detail, item-page, and automatic updates response shapes.
- Bad: Requires a separate canonical session value for revision calculation.

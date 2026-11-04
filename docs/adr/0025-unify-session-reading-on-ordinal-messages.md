---
status: accepted
date: 2026-11-04
---

# Unify session reading on ordinal messages

## Context and Problem Statement

Web used signed timeline cursors, separate update probes, four optional event
models, and lazy details. CLI already read conversation messages by ordinal.
Daily reading needs conversations, runtime state, questions, and interaction;
the parallel protocols and historical prefix validation added substantial cost.

## Considered Options

- Retain an advanced event inspector and both read protocols.
- Use ordinal conversation pages and bounded long polling for Web and CLI.
- Add history generations or fingerprints to ordinal pages.

## Decision Outcome

Use `/messages` as the sole message read endpoint, with `after`, `limit`, `wait`,
and optional `stateRevision`. Web explicitly starts at zero; CLI defaults to the
latest messages. Preserve original ordinal gaps and incremental file checkpoints.
Publish only `message` and `user_input`, including progress, responses, Plans,
questions, and answers. Remove directive/tool/token/internal models, preferences,
details, signed cursors, prefix indexes, and the separate updates endpoint without
compatibility support. Adapter parsing for bindings, identity, relationships, and
runtime status stays internal. Terminal preview snapshots/deltas are unchanged.

Backlog returns immediately; at the tail, messages or public state changes wake a
bounded wait. Without a revision, return a baseline; unchanged waits time out with
204. Retain probe intervals, capacity, cancellation, and retry backoff. Web
serializes paging and tail waiting. CLI drains pages per round; timeouts count
as rounds and `--interval` is removed.

An out-of-range ordinal causes one automatic reload. Accept that other historical
rewrites are not automatically detected; browser reload is available. Do not add
bidirectional paging, generations, or content fingerprints.

This replaces [ADR-0009](0009-use-opaque-single-writer-timeline-cursors.md) and
refines the scope of [ADR-0011](0011-use-repository-probed-bounded-long-polling.md).

## Consequences

- Web and CLI share one compact protocol and conversation model.
- Incremental parsing and request-scoped runtime observations remain efficient.
- Advanced event inspection and old API consumers are intentionally unsupported.
- Rewrites that keep ordinals in range can leave loaded history stale until the browser page is reloaded.

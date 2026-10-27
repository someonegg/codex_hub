---
status: accepted
date: 2026-10-16
---

# Use V3 bindings and current pane validation

Current commands emit V4 with an added project-directory field; V3 remains
supported. See the [current binding format](../technical-reference.md#tmux-interaction).

The exit sequence and no-forced-kill policy below are historical; see
[ADR-0022](0022-separate-session-exit-from-archive.md) for their replacement.
[ADR-0023](0023-separate-runtime-status-from-resume-permission.md) adds shared bounded
runtime observations and explicit resume permission. See the
[interaction reference](../technical-reference.md#tmux-interaction) for current behavior.

[ADR-0024](0024-share-request-scoped-runtime-observations.md) refines reader
responses to share one request-scoped pane observation; effects still validate
current ownership independently.

## Context and Problem Statement

Connection status, input, previews, and archive need consistent current availability.
Permanent caching prevents recovery; process identity checks reject deliberate pane reuse.

## Decision Outcome

Use one process-wide binding authority and fresh pane validation. A later claim
revokes the former owner's control; retain claims for the process lifetime so
archive, deletion, or rereads cannot restore stale authority. Explicit later
bindings can reclaim a pane. Missing replacement sessions affect navigation,
not ownership.

Share concurrent checks without caching completed results. Validate socket
ownership and pane liveness, without process-identity inference; deliberate
socket/pane reuse is allowed. Binding changes during observation fail closed,
and queued effects revalidate ownership before execution.

Adapters own native binding syntax and semantic key mappings; generic transport
owns tmux validation, serialized input, and capture. HTTP uses business services
rather than depending on tmux implementation. Current protocol and publication
rules live in the [interaction reference](../technical-reference.md#tmux-interaction).

### Historical binding and archive protocol

At introduction, commands emitted V3 bindings with socket, pane, and optional
operation UUID. Creation correlated that marker with its launch target and
project. V4 later added the project field while retaining V3 reads.

Archive originally sent `Ctrl+C`, then `Ctrl+D`, without forced pane closure.
ADR-0022 replaces only this shutdown strategy with the independent exit service;
query errors still do not prove pane death, and uncertain effects are not retried.

## Consequences

Connection state can recover, and interaction and archive share target semantics.
Polling adds tmux queries. Timeout does not prove exit; unknown outcomes are not
resent automatically.

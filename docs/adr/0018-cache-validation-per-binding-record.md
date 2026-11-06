---
status: accepted
date: 2026-10-16
---

# Use session bindings and current tmux validation

See the [binding contract](../technical-reference.md#binding-format-and-ownership)
and [runtime observations](0024-share-request-scoped-runtime-observations.md).

## Context and Problem Statement

Connection status, input, previews, and archive need consistent current availability.
Permanent caching prevents recovery; process identity checks reject deliberate session reuse.

## Decision Outcome

Use one process-wide binding authority and fresh session validation. A later claim
revokes the former owner's control; retain claims for the process lifetime so
archive, deletion, or rereads cannot restore stale authority. Explicit later
bindings can reclaim a session. Missing replacement sessions affect navigation,
not ownership.

Share concurrent checks without caching completed results. Validate socket
ownership and session liveness, without process-identity inference; deliberate
socket/session reuse is allowed. Binding changes during observation fail closed,
and queued effects revalidate ownership before execution.

Adapters own native binding syntax and semantic key mappings; generic transport
owns tmux validation, serialized input, and capture. HTTP uses business services
rather than depending on tmux implementation. Current protocol and publication
rules live in the [interaction reference](../technical-reference.md#tmux-interaction).

### Binding and archive protocol

Creation correlates the binding operation UUID with its launch target and project.

Exit uses the independent exit service described in
[ADR-0022](0022-separate-session-exit-from-archive.md). Query errors do not prove
session exit, and uncertain effects are not retried.

## Consequences

Connection state can recover, and interaction and archive share target semantics.
Polling adds tmux queries. Timeout does not prove exit; unknown outcomes are not
resent automatically.

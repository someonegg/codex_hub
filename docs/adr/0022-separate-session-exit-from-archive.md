---
status: accepted
date: 2026-10-18
---

# Separate session exit from archive

## Context and Problem Statement

CLI exit was hardcoded as `Ctrl+C`, `Ctrl+D` in the tmux transport and could only
be requested through archive. CLI-specific behavior belongs to its adapter, and
other callers need to exit a session without archiving its history. The transport
can observe pane liveness but does not identify the CLI process inside a shell.

## Decision Outcome

Expose `POST /api/v1/sessions/:id/exit` as an asynchronous management operation,
using the existing operation polling, occupancy, deduplication, and conflict rules.
An independent exit service executes steps provided by the adapter. Archive calls
that same service before its native command; exit itself never archives data.

Binding, including manual binding, transfers control of the whole pane. Codex's
strategy is three separate `Ctrl+C` inputs one second apart. The common service
waits four more seconds, sends `Ctrl+D` once, and waits nine seconds before issuing
one targeted `kill-pane`. Confirm disappearance or a dead pane before success.
An unavailable pane finishes early. Source bindings are refreshed, queued effects
revalidate ownership and operation activity, and uncertain effects are not retried.
Exit has a 30-second total deadline; cancellation prevents subsequent effects.

This replaces only the archive exit sequence and no-forced-kill policy in
[ADR-0017](0017-observe-asynchronous-management-operations.md) and
[ADR-0018](0018-cache-validation-per-binding-record.md). Their remaining decisions
continue to apply.

## Considered Options

- Keep a generic `Ctrl+C`, `Ctrl+D` sequence in the transport.
- Detect CLI process exit before separately closing the shell.
- Use adapter-provided CLI steps and bounded whole-pane shutdown (chosen).

## Consequences

Exit can be reused without archive and keeps CLI semantics out of tmux transport.
No process-tree inference is needed. Delays are a grace period, not evidence of
CLI exit. Interrupts and EOF may reach the outer shell; forceful pane shutdown
may interrupt cleanup or other work in a manually bound pane. These costs follow
from the explicit transfer of whole-pane control. Only the target pane is killed;
there is no kill-session or kill-server operation.

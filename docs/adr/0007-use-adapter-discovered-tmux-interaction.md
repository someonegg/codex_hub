---
status: superseded by ADR-0016 and ADR-0018
date: 2026-08-01
---

# Discover tmux interaction targets through adapters

## Context and Problem Statement

Adapters interpret session formats; shared transport should validate tmux targets,
serialize input, and capture previews.

## Decision Outcome

The Codex adapter discovers the latest binding from shell output in user messages
and exposes semantic key mappings. Shared tmux transport validates a Unix socket
owned by the current user and a live pane, serializes bracketed paste and control
keys, and captures bounded previews. Previews are transient and separate from
structured rollout data.

Session reads report `unbound`, `disconnected`, `connected`, or `unknown`, without
inferring process activity. Input timeouts have unknown results and are not retried.

Default management and interaction are covered by [ADR-0016](0016-enable-hub-management-by-default.md).
Bindings, pane validation, and archive shutdown are covered by
[ADR-0018](0018-cache-validation-per-binding-record.md).

## Consequences

Adapters and transport have distinct responsibilities. Bindings can be rebuilt
from rollouts after restart. A reused socket and pane ID target the current pane.

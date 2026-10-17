---
status: accepted
date: 2026-10-16
---

# Use V3 bindings and live pane validation

## Context and Problem Statement

Connection status, input, previews, and archive need consistent current availability.
Permanent caching prevents recovery; process identity checks reject deliberate pane reuse.

## Decision Outcome

Parse only the latest `CODEX_HUB_TMUX_BIND_V3` declaration in user-message
`<user_shell_command>` output. Read an absolute socket path, a `%`-prefixed numeric
pane ID, and optional operation UUID on successive lines. An invalid latest
declaration does not fall back. Created tmux sessions use `codex-hub-<operationId>`;
manual bindings have no name restriction. Creation confirms the unique operation
ID, project, and socket/pane pair.

Internal declarations use a `transport: "tmux"` discriminant whose branch owns
socket, pane, and tmux key mappings. Semantic keys and limits live in a shared
module re-exported by the API contract; domain types do not depend on the API.
Application services inject transport and share message normalization/validation
with it. HTTP does not depend on tmux implementation. Only tmux is provided.

All entry points share live checks of current-user Unix socket ownership and pane
liveness. Coalesce concurrent checks for the same target without caching completed
results. Missing sockets, confirmed stopped servers, and missing/dead panes are
unavailable; permission errors, timeouts, and malformed responses are query errors.
Input and previews revalidate inside the pane queue. Socket/pane reuse is allowed;
PID and server start time are not inspected.

Archive is exclusive per session and blocks ordinary hub input. The owning
source snapshot must confirm a unique nonempty native `sourceId`; the Codex manager
validates its UUID. Already archived sessions succeed immediately. Without a valid
available target, invoke native archive once. Initial query errors send neither
exit input nor archive: timeout yields `unknown`, other errors yield `failed`.

For a live target, send `Ctrl+C` then `Ctrl+D` once: no `/exit`, Enter, or retry.
Send errors yield `unknown`. Observe the fixed socket/pane, continuing after query
errors; failure to confirm unavailability within 30 seconds yields `unknown`.
Do not switch bindings or restrict direct terminal input.

After confirmed unavailability, run `codex archive <sourceId>` once. Command
timeout after 25 seconds yields `unknown`; explicit errors yield `failed`. On
success, allow 30 seconds to confirm the owning source's unique native identity
is archived. Confirmation timeout yields `unknown`. Operation IDs and native UUIDs
serve different purposes.

## Consequences

Connection state can recover, and interaction and archive share target semantics.
Polling adds tmux queries. Timeout does not prove exit; unknown outcomes are not
resent automatically.

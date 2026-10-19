---
status: accepted
date: 2026-10-16
---

# Use V3 bindings and current pane validation

The exit sequence and no-forced-kill policy below are historical; see
[ADR-0022](0022-separate-session-exit-from-archive.md) for their replacement.
[ADR-0023](0023-separate-runtime-status-from-resume-permission.md) adds shared bounded
runtime observations and explicit resume permission. See the
[interaction reference](../technical-reference.md#tmux-interaction) for current behavior.

## Context and Problem Statement

Connection status, input, previews, and archive need consistent current availability.
Permanent caching prevents recovery; process identity checks reject deliberate pane reuse.

## Decision Outcome

Parse every `CODEX_HUB_TMUX_BIND_V3` declaration in user-message
`<user_shell_command>` output. Read an absolute socket path, a `%`-prefixed numeric
pane ID, and optional operation UUID on successive lines. An invalid latest
declaration does not fall back. Created tmux sessions use `codex-hub-<operationId>`;
manual bindings have no name restriction. Creation confirms the unique operation
ID, project, and socket/pane pair.

The process-wide pane binding manager is the sole binding source. Adapters
submit all binding attempts from accepted decoded records, including incremental
appends; normalized interaction values contain only transport capabilities.
Order events by timestamp (invalid timestamps use zero), global session ID,
record ordinal, then position within the record. Retain the latest attempt per
session and the latest valid claim per socket/pane, across source instances.
Invalid latest attempts do not fall back; a new claim does not release older
claims on other panes. Creation queries this same manager for `operationId`.
The Hub explicitly injects the same process-wide manager into the Codex adapter,
interaction service, and operation service. Their default parameters retain this
shared instance for standalone callers; tests may inject an isolated manager.
Closing a Hub does not clear binding history. Management snapshots contain only
domain sessions; interaction capabilities are read through interaction snapshots.

When a later claim takes a pane, its former owner returns `superseded` and cannot
send input, hand off the binding, preview, or shut down that pane during archive. A supported
interaction response always includes nullable `supersededBySessionId`: it names
the replacing session only while that session is readable, including when
archived. Missing replacements leave the state `superseded` with a null ID.
Takeover facts survive archive, deletion, and full rereads for the process lifetime;
a later explicit binding can reclaim a pane. Unsupported responses omit these
state fields. `attachCommand` is null for `superseded`.

Status queries never recurse or restart validation when bindings change during
an await. Return the currently determinable state, using `unknown` for a new
binding that has not been validated, and wait for the next refresh. Operations
still validate ownership after resolution and immediately before queued effects.

Internal declarations use a `transport: "tmux"` discriminant whose branch owns
tmux key mappings and the binding command. Semantic keys and limits live in a shared
module re-exported by the API contract; domain types do not depend on the API.
Application services inject transport and share message normalization/validation
with it. HTTP does not depend on tmux implementation. Only tmux is provided.

All entry points share current pane validation of current-user Unix socket ownership and pane
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

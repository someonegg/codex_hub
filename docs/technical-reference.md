# Technical reference

The hub discovers `rollout-*.jsonl` files and advisory `session_index.jsonl`
metadata without reading Codex databases. Source adapters normalize data into
shared snapshots. See [JSONL filtering](session-jsonl-filtering.md) for decoding,
visibility, and truncation rules, and [ADRs](adr/README.md) for decision history.

Successfully loaded archives reuse cached content until restart or restoration;
in-place content and permission changes are not detected while cached. Discovery,
removal, metadata refresh, and retries of failed loads continue normally.

Public contracts are defined in `src/shared/api-contract.ts`. IDs, timeline cursors,
and revisions are opaque; clients must use returned values.

## Catalog

`GET /api/v1/sessions` returns a complete `{ revision, homes, projects, sessions }` snapshot:

- Homes: `{ sourceInstanceId, nickname }`, including empty homes; home paths are private.
- Projects: `{ id, directory }`.
- Sessions: `{ id, sourceInstanceId, title, projectId, status, parentId, isChild, updatedAt }`.
- Titles are resolved display names. Missing directories produce `projectId: null`.
  `isChild` preserves a declared parent relationship even if `parentId` cannot resolve.

The only query parameter is `after`. Missing or different revisions return `200`
immediately. Matching revisions wait up to 25 seconds: a change returns a full
`200` snapshot; timeout returns bodyless `204`. Waiters share a 1.5-second source
probe that stops when idle. Capacity is 100 waiters; excess requests receive `429`
with `Retry-After: 2`. Disconnects and server shutdown release waiters. `after`
must be 43 base64url characters; other query parameters return `400`.

Catalog revisions track home metadata, titles, projects, status, and parent
relationships, but exclude timestamps, content, statistics, and diagnostics.
Catalog diagnostics are deduplicated in server logs rather than sent to clients.

Within each home, a native session ID determines stable identity. Duplicate rollouts
produce one session: retain the accepted readable file, falling back to the first
readable candidate when necessary. Rollouts without a native ID use path-based
identity. See [ADR-0003](adr/0003-use-session-source-adapters.md) for adapter rules.

`updatedAt` is best-effort metadata: timestamp-only changes do not wake catalog
waiters. The browser sorts sessions by time and projects by their latest visible
main session, retaining newer timestamps from list snapshots and opened readers
without extra requests or persistence. Equal times use IDs; missing or invalid times
sort last. Catalog requests pause while hidden and reconnect when visible.

Session status is `normal | live | archived`. Archive takes precedence; Live requires
an observed living pane currently owned by the session. Normal has no additional
badge and does not imply that resume is safe. Runtime checks share concurrent pane
observations and bound socket concurrency. Probe errors revoke Live and resume permission.

## Reader and automatic updates

| Endpoint                                           | Purpose                                                  |
| -------------------------------------------------- | -------------------------------------------------------- |
| `GET /api/v1/sessions/:id`                         | Session metadata, interaction state, and update revision |
| `GET /api/v1/sessions/:id/items`                   | Timeline page; optional `limit` and `cursor`             |
| `GET /api/v1/sessions/:id/items/:itemId/directive` | Lazy directive text; requires `cursor`                   |
| `GET /api/v1/sessions/:id/items/:itemId/tool`      | Lazy tool input/output; requires `cursor`                |
| `GET /api/v1/sessions/:id/items/:itemId/internal`  | Lazy internal JSON; requires `cursor`                    |
| `GET /api/v1/sessions/:id/updates`                 | Long poll; requires `cursor` and `after` update revision |

Timeline pages include session metadata, items, a cursor, `hasMore`, interaction
state, and an update revision. Cursors validate timeline prefix continuity; incompatible
changes or cursors from a previous server process return `409 timeline_changed`;
malformed cursors return `400 invalid_query`. Lazy details must be within the
cursor's confirmed prefix. See [paging limits](session-jsonl-filtering.md#truncation-and-paging).

Automatic updates validate but do not advance the cursor or return timeline items;
the browser loads any reported backlog through the items endpoint. The server probes
every 1.5 seconds and waits up to 25 seconds before returning `204` unchanged.
Capacity is 100 waiters per process and 10 per session; excess waits receive `429`
with `Retry-After: 2`. Disconnects and shutdown release waiters.

Session metadata includes `status` and `resume: { allowed, reason }`. Resume is a
detail capability; `reason` is null when allowed. Status, resume capability and
interaction changes affect the detail update revision even without JSONL changes.

Only the opened, unarchived session subscribes to automatic updates. History paging
and automatic updates coexist while preserving the reading position. Reader revisions
are independent of catalog revisions and include `updatedAt`. Session diagnostics stay in server logs.

## File uploads

`POST /api/v1/uploads?filename=<URL-encoded filename>` accepts raw binary (up to
20 MiB per file) and returns `201 { "path": "/absolute/path/<uuid>.<ext>" }`.
The filename supplies only a safe extension. Oversize uploads return `413`;
storage failures return `500`, using the standard API error envelope.
Failed or interrupted uploads remove incomplete files.

Use `--upload-dir <path>` to choose storage. Missing directories are created,
relative paths resolve from the startup directory, and `~/` is supported.
Otherwise the process reuses a `codex-hub-uploads-*` directory under `os.tmpdir()`.
Uploads are retained after shutdown; the OS may clear temporary storage.
The directory must be visible to the Codex process.

The composer accepts pasted images and dropped files, including multiple files but
not folders. Uploads freeze editing, Send, and Handoff, then insert paths at the
selection without sending. A failure stops the batch and retains earlier paths;
switching sessions cancels pending uploads. Finder paste works when the browser
supplies files; text-only paths remain text.

## Tmux interaction

| Endpoint                                         | Request or response                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/v1/sessions/:id/messages`             | `{ message }`; success returns `204`                                                                                                             |
| `POST /api/v1/sessions/:id/keys`                 | `{ keys }`; success returns `204`                                                                                                                |
| `POST /api/v1/sessions/:id/handoff-pane-binding` | Empty object `{}`; returns `204` after sending the binding command to the connected pane; handoff is recognized from a subsequent binding record |
| `WS /api/v1/sessions/:id/terminal-preview`       | JSON `snapshot`, `delta`, and `error` messages (see below)                                                                                       |

Supported keys and message limits are defined in `src/shared/interaction.ts`.
Interaction states are `unbound`, `disconnected`, `connected`, `unknown`, and `superseded`.

The Codex adapter recognizes every `CODEX_HUB_TMUX_BIND_V3`
declaration in user-message `<user_shell_command>` output. Its following lines
contain a nonempty absolute socket path, a `%`-prefixed numeric pane ID, and an
optional operation UUID. An invalid latest declaration does not fall back to an older one.

Bindings are shared across homes, retaining the latest attempt per session and the
latest valid claim per socket/pane. Creation correlates its operation UUID with the
recorded binding. See [ADR-0018](adr/0018-cache-validation-per-binding-record.md)
for event ordering and ownership rules.

When a later claim takes a pane, its former owner returns `superseded` and cannot
send input, hand off the binding, preview, or shut down that pane during archive. A supported
interaction response always includes nullable `supersededBySessionId`: it names
the replacing session only while that session is readable, including when
archived. Missing replacements leave the state `superseded` with a null ID.
Takeover facts survive archive, deletion, and full rereads for the process lifetime;
a later explicit binding can reclaim a pane. Unsupported responses omit these
state fields. `attachCommand` is null for `superseded`.

Interaction validates socket ownership, pane liveness, and binding ownership before
effects. Concurrent checks are shared; completed results are not cached. Binding
changes during validation may report `unknown` until the next refresh. Socket/pane
reuse targets the current pane without comparing process identity. Uncertain input
is not automatically resent.

### Terminal preview

Preview captures the current pane screen as plain text, not scrollback or a terminal
emulator stream. Captures retain the last 256,000 UTF-8 bytes without splitting a
character and report `truncated` when the beginning was removed.

Terminal previews use `/api/v1/sessions/:id/terminal-preview` over `ws` or `wss`,
inheriting the server's TLS and optional client certificate requirements. Upgrade
requests accept no query parameters and reject cross-origin browser requests.
Ordinary HTTP requests receive `426 Upgrade Required`. Clients send no application
messages.

The server sends JSON text messages with a `type` discriminator:

- `snapshot`: `revision`, `content`, `truncated`, and `capturedAt`.
- `delta`: `baseRevision`, `revision`, `operations`, `truncated`, and `capturedAt`.
- `error`: `code`, `message`, and `retryable`, followed by connection closure
  (`1013` for retryable errors, `1008` otherwise).

Every connection starts with a full snapshot. Each delta applies to the preceding
frame: operations contain `startLine`, `deleteCount`, and `lines`, refer to the
original line indices, and run in strictly descending, nonoverlapping order.
Splitting and joining on `"\n"` preserves blank lines and trailing newlines;
truncation-only changes may use an empty operations array.

The server falls back to a snapshot if diff computation exceeds its budget or a
delta is too large or no smaller than full text. Clients validate frames before
applying them; invalid updates preserve the display and require reconnection.
Connections always restart from a full snapshot.

Viewers share tmux listeners and captures without changing terminal size or session
environment. Output events merge over 350 milliseconds; only content or truncation changes
publish a frame. The server allows 100 connections globally and 10 per session,
including initialization; excess connections receive retryable `preview_capacity_exceeded`.
Repeated valid binds for the same session, socket and pane preserve subscriptions.
Ownership loss, invalid binds, target changes and listener failures invalidate affected
subscriptions immediately; returning ownership does not revive a closed subscription.

The browser connects only while the preview is expanded, connected, and visible.
Retryable failures use backoff; terminal errors wait for expansion, visibility,
connection changes, or explicit retry. Failures retain the last frame and a
stopped-updates notice until a valid snapshot arrives. Dismissing error details
does not reconnect; explicit retry cancels pending retries and reconnects.
See [preview service](../src/server/interaction/terminal-preview-service.ts) and
[WebSocket transport](../src/server/http/terminal-preview-websocket.ts) for limits
and cleanup.

## Asynchronous management

| Endpoint                              | Body                                                                                                      | Result            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------- |
| `POST /api/v1/sessions`               | `{ sourceInstanceId?, directory, worktree, yolo?, requestId }` or `{ resumeSessionId, yolo?, requestId }` | `202` operation   |
| `POST /api/v1/sessions/:id/exit`      | `{}`                                                                                                      | `202` operation   |
| `POST /api/v1/sessions/:id/archive`   | `{}`                                                                                                      | `202` operation   |
| `DELETE /api/v1/sessions/:id`         | `{}`                                                                                                      | `202` operation   |
| `GET /api/v1/operations/:operationId` | —                                                                                                         | Current operation |

Operations contain `operationId`, `type`, `status`, nullable `sessionId`,
`createdAt`, `updatedAt`, nullable `error`, `phase`, and `attachCommand`.
Operation types are `create`, `exit`, `archive`, and `delete`. Create operations add
`mode: "new" | "resume"`; known launch targets are retained as `target: { socketPath, paneId }`.
Statuses are `pending`, `succeeded`, `failed`, and `unknown`. Exit uses
`sending_exit` and `waiting_exit`; archive phases are
`sending_exit`, `waiting_exit`, `archiving`, and `confirming_archive`.
Interaction responses also include nullable `attachCommand`.

Create request IDs contain 8–128 letters, digits, underscores, or hyphens. Identical
IDs and arguments coalesce through execution and the 30-minute terminal retention
period; changed arguments return `409`. Different IDs may create concurrently in
the same project. Exit/archive/delete coalesce identical operations on a session;
conflicting operations return `409` without queuing. Resume uses the same session
occupancy as exit/archive/delete. Resume requests with different request IDs cannot
launch concurrently for one session; identical request IDs retain create idempotency.

### Project directory

Project Directory is the latest valid project path recorded in a pane bind, falling
back to Working Directory. Paths must be absolute and contain no NUL, CR or LF;
values are preserved without filesystem checks or Git discovery. Invalid or empty
project fields do not invalidate the pane bind or erase an earlier project path.
New binds emit V4 with five lines: marker, socket, pane, operation ID, project path.
The last two fields may be empty. V3 remains readable.

### Execution and confirmation

- **Create:** validate an existing directory and use its real path for both launch
  and the bind project field, including when Codex creates a worktree.
  Launch Codex as the main pane process in a dedicated
  `codex-hub-<operationId>` tmux session with `--no-daemon --no-alt-screen`, optional
  `--worktree` and `--yolo` (both off by default). Confirm the operation marker,
  launch target, project, and valid binding within 300 seconds after launch.
  Show an attach command after 30 seconds and retain it on timeout.
- **Resume:** use the owning source and opaque native ID from the original session.
  The owning adapter validates its format; only the Codex adapter requires a UUID.
  Try Working Directory first, then Project Directory. Skip empty or invalid paths;
  fall back when a candidate is missing or is not a directory. Launch with the
  selected real path while retaining the original project in the bind.
  Directory, source and worktree overrides are rejected. `yolo` defaults to false.
  Require an unarchived, unique valid identity, an available directory, and a valid
  latest binding whose pane is confirmed dead/missing or explicitly transferred.
  Missing/invalid bindings, timeouts and errors never authorize resume. Revalidate
  before launching `codex resume <UUID>` in a new pane. Confirmation requires the
  original identity, operation marker, matching project and a live owned launch target.
- **Exit:** resolve the source and latest binding; no native ID is required.
  Binding transfers control of the whole pane, including manually bound panes.
  Send interrupts and EOF with grace periods, then force-close that pane if needed.
  Success requires a missing or dead pane within 30 seconds; query errors or
  changed ownership end tracking as `unknown`.
  Uncertain effects are not retried. An unbound session succeeds without effects;
  a missing session fails. Archived sessions use the same checks. Exit preserves
  session data. See [ADR-0022](adr/0022-separate-session-exit-from-archive.md)
  for the shutdown sequence and whole-pane tradeoffs.
- **Archive:** reread the source snapshot. Already archived sessions succeed
  immediately. Validate the unique native identity, then reuse the independent
  exit service. Only successful exit proceeds to native archive, once. The native
  command allows 25 seconds; archive confirmation allows 30 seconds. While exit,
  archive, or delete occupies the session, ordinary input and handoff requests
  return `409 session_busy`. Archive retains occupancy through confirmation.
- **Delete:** require an archived session, run the native command, and confirm its
  same-source native identity is absent, within 30 seconds. A session already absent
  from a successful initial snapshot succeeds immediately.

Native commands inherit the configured `CODEX_HOME`; the hub does not move
or delete rollout files directly. Successful snapshots may skip unreadable data
and still confirm results; thrown read errors do not prove deletion.

### Tracking and recovery

Operations continue independently of browser queries. Timeout ends tracking as
`unknown` without undoing submitted commands. Terminal states are immutable and
release session occupancy; results and create deduplication records remain in
memory for 30 minutes. Restart loses these records and leaves tmux sessions running.

Unknown Create and Resume outcomes retain known target/attach information. Reuse
the same `requestId` to retrieve the original operation during retention. A new ID
may launch another session after normal checks, even if the previous launch is
still running; inspect tmux before submitting again.

The browser polls pending operations one second after each completed query.
Hidden pages pause queries and resume when visible; submitted writes continue,
and returned operation IDs retain recovery markers. Reload can resume polling.
All terminal states and `404` clear recovery markers; nonretryable query errors
require manual retry. Network retries of create reuse its request ID until a
terminal result, after which the ID is discarded.

## Home identity and routing

See [Multiple homes](usage.md#multiple-homes) for command-line usage.

Session identity follows the configured absolute home path; nicknames and ordering
do not affect IDs. Native IDs and relationships are scoped to their home; projects
merge by directory across homes. Recoverable I/O errors remain scoped to their home.

Creation requires `sourceInstanceId` with multiple homes; omission with a single home
selects that home. Unknown IDs and ambiguous omission return `400`. The source is part
of the idempotency fingerprint, so reuse of a request ID for another home returns
`409`. Launch environment, association, exit, archive, deletion, and confirmation use the
selected or owning home.

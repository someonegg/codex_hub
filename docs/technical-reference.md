# Technical reference

The hub discovers `rollout-*.jsonl` files and advisory `session_index.jsonl`
metadata without reading Codex databases. Source adapters normalize data into
shared snapshots. See [JSONL filtering](session-jsonl-filtering.md) for decoding,
visibility, and truncation rules, and [ADRs](adr/README.md) for decision history.

Public contracts are defined in `src/shared/api-contract.ts`. IDs, timeline cursors,
and revisions are opaque; clients must use returned values.

## Catalog

`GET /api/v1/sessions` returns a complete `{ revision, projects, sessions }` snapshot:

- Projects: `{ id, directory }`.
- Sessions: `{ id, title, projectId, archived, parentId, isChild, updatedAt }`.
- Titles are resolved display names. Missing directories produce `projectId: null`.
  `isChild` preserves a declared parent relationship even if `parentId` cannot resolve.

The only query parameter is `after`. Missing or different revisions return `200`
immediately. Matching revisions wait up to 25 seconds: a change returns a full
`200` snapshot; timeout returns bodyless `204`. Waiters share a 1.5-second source
probe that stops when idle. Capacity is 100 waiters; excess requests receive `429`
with `Retry-After`. Disconnects and server shutdown release waiters. Legacy
pagination, filtering, and `fresh` parameters return `400`.

Revisions hash the minimal structure sorted by ID. Title, project, archive, and
parent changes affect them; timestamps, content, statistics, and diagnostics do not.
Catalog diagnostics are deduplicated in server logs rather than sent to clients.

`updatedAt` is best-effort metadata carried by list snapshots and excluded from
revision calculation. Timestamp-only changes do not wake catalog waiters; unchanged
requests still time out with `204`.

The browser uses these timestamps to sort main sessions descending and projects by
their latest visible main session. Equal times use the corresponding ID; missing
or invalid times sort last. Displayed reader metadata (initial pages, pagination,
refreshes, and Live responses) feeds timestamps back into the local list without
extra requests. Both list replacement and reader feedback retain the newer valid
time for each existing ID; removed sessions are discarded. Feedback for unknown IDs
or before the list loads is ignored. Times are not persisted. Catalog requests pause
while hidden and reconnect when visible. Reader Live revisions retain their own
semantics, including `updatedAt`.

## Reader and Live updates

| Endpoint                                           | Purpose                                                |
| -------------------------------------------------- | ------------------------------------------------------ |
| `GET /api/v1/sessions/:id`                         | Session metadata, interaction state, and Live revision |
| `GET /api/v1/sessions/:id/items`                   | Timeline page; optional `limit` and `cursor`           |
| `GET /api/v1/sessions/:id/items/:itemId/directive` | Lazy directive text; requires `cursor`                 |
| `GET /api/v1/sessions/:id/items/:itemId/tool`      | Lazy tool input/output; requires `cursor`              |
| `GET /api/v1/sessions/:id/items/:itemId/internal`  | Lazy internal JSON; requires `cursor`                  |
| `GET /api/v1/sessions/:id/live`                    | Long poll; requires `cursor` and `after` Live revision |

Timeline pages include session metadata, items, a cursor, `hasMore`, interaction
state, and a Live revision. Cursors validate timeline prefix continuity; incompatible
changes return `409 timeline_changed`. Live timeout returns `204`.

Only the opened, unarchived session subscribes to Live. History paging and Live
updates coexist while preserving the reading position. Catalog and reader polling
use separate constants and revisions. Session diagnostics stay in server logs.

## Tmux interaction

| Endpoint                                    | Request or response                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /api/v1/sessions/:id/messages`        | `{ message }`; success returns `204`                                                           |
| `POST /api/v1/sessions/:id/keys`            | `{ keys }`; success returns `204`                                                              |
| `POST /api/v1/sessions/:id/rebind`          | Empty object `{}`; returns `204` after sending the basic binding command to the connected pane |
| `GET /api/v1/sessions/:id/terminal-preview` | `{ content, truncated, capturedAt }`                                                           |

Supported keys and message limits are defined in `src/shared/interaction.ts`.
Interaction states are `unbound`, `disconnected`, `connected`, and `unknown`.

The Codex adapter recognizes only the latest `CODEX_HUB_TMUX_BIND_V3`
declaration in user-message `<user_shell_command>` output. Its following lines
contain a nonempty absolute socket path, a `%`-prefixed numeric pane ID, and an
optional operation UUID. An invalid latest declaration does not fall back to an older one.

All interaction paths share live checks of socket ownership and pane liveness.
Only concurrent checks for the same target are coalesced; completed results are
not cached. Input and preview revalidate inside the pane queue. Socket/pane reuse
targets the current pane without comparing process identity. Uncertain input is
not automatically resent.

Expanded, connected terminal previews refresh one second after each request
completes, while the page is visible. Collapse, hiding, disconnection, and unmount
cancel requests and waits. Temporary errors back off; nonretryable errors stop the
loop until a new expand, visibility, or connection transition.

## Asynchronous management

| Endpoint                              | Body                                 | Result            |
| ------------------------------------- | ------------------------------------ | ----------------- |
| `POST /api/v1/sessions`               | `{ directory, worktree, requestId }` | `202` operation   |
| `POST /api/v1/sessions/:id/archive`   | `{}`                                 | `202` operation   |
| `DELETE /api/v1/sessions/:id`         | `{}`                                 | `202` operation   |
| `GET /api/v1/operations/:operationId` | —                                    | Current operation |

Operations contain `operationId`, `type`, `status`, nullable `sessionId`,
`createdAt`, `updatedAt`, nullable `error`, `phase`, and `attachCommand`.
Statuses are `pending`, `succeeded`, `failed`, and `unknown`. Archive phases are
`sending_exit`, `waiting_exit`, `archiving`, and `confirming_archive`.
Interaction responses also include nullable `attachCommand`.

Create request IDs contain 8–128 letters, digits, underscores, or hyphens. Identical
IDs and arguments coalesce through execution and the 30-minute terminal retention
period; changed arguments return `409`. Different IDs may create concurrently in
the same project. Archive/delete coalesce identical operations on a session;
conflicting operations return `409` without queuing.

### Execution and confirmation

- **Create:** launch Codex as the main pane process in a dedicated
  `codex-hub-<operationId>` tmux session with `--no-daemon --no-alt-screen`, optional
  `--worktree`, and `remain-on-exit off`. Supply the binding shell instruction as
  the initial CLI argument rather than pasting it. Confirm the operation marker,
  launch target, project, and valid binding. Wait up to 300 seconds after launch;
  show an attach command after 30 seconds and retain it on timeout.
- **Archive:** reread the source snapshot and latest binding. Already archived
  sessions succeed immediately. An absent or confirmed unavailable target proceeds
  to native archive. A live target receives `Ctrl+C`, then `Ctrl+D`, once, without
  Enter. Observe that fixed socket/pane until gone or dead, then archive once.
  Waiting for exit and confirming archive each allow 30 seconds; the native command
  allows 25 seconds. Query errors do not prove exit. While occupied, message, key,
  and rebind requests return `409 session_busy`; no process is forcibly killed.
- **Delete:** require an archived session, run the native command, and confirm its
  same-source native identity is absent, within 30 seconds. A session already absent
  from a successful initial snapshot succeeds immediately.

Native commands inherit the configured `CODEX_HOME`; the hub does not move
or delete rollout files directly. Successful snapshots may skip unreadable data
and still confirm results; thrown read errors do not prove deletion.

### Tracking and recovery

A shared one-second server loop observes pending operations. Timeout ends tracking
as `unknown` and cannot undo commands already submitted. Terminal states are
immutable and immediately release execution context and session occupancy;
results and create deduplication records remain in memory for 30 minutes.
Queries only read results. Restarting the server does not recover operations or
close tmux sessions.

The browser polls pending operations one second after each completed query.
Hidden pages pause queries and resume when visible; submitted writes continue,
and returned operation IDs retain recovery markers. Reload can resume polling.
All terminal states and `404` clear recovery markers; nonretryable query errors
require manual retry. Network retries of create reuse its request ID until a
terminal result, after which the ID is discarded.

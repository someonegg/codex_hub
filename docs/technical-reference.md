# Technical reference

This reference covers public APIs, source identity, and runtime guarantees.
See [JSONL filtering](session-jsonl-filtering.md) for record processing and
[ADRs](adr/README.md) for decision history.

Public contracts are defined in [api-contract.ts](../src/shared/api-contract.ts).
IDs, timeline cursors, and revisions are opaque; clients must use returned values.
For setup and everyday workflows, see [Usage](usage.md).

- [Sources and identity](#sources-and-identity): discovery, caching, homes, and routing.
- [Catalog](#catalog): list snapshots, revisions, and long polling.
- [Reader](#reader-and-automatic-updates): timeline pages, lazy details, and updates.
- [Uploads](#file-uploads): binary upload contract.
- [Hosting](#optional-hosting): shared publication and access guarantees.
- [Web pages](#web-pages): static snapshots and page routes.
- [Diffs](#temporary-diffs): temporary diff storage and routes.
- [Tmux interaction](#tmux-interaction): bindings, activity, and preview protocol.
- [Management](#asynchronous-management): launch, exit, archive, delete, and recovery.

## Sources and identity

### Discovery and caching

The Codex adapter reads `rollout-*.jsonl` and advisory `session_index.jsonl`
metadata, without reading Codex databases. Source adapters normalize data into
shared snapshots.

Successfully loaded archives reuse cached content until restart or restoration;
in-place content and permission changes are not detected while cached. Discovery,
removal, metadata refresh, and retries of failed loads continue normally.

### Session identity

Within each home, a native session ID determines stable identity. Duplicate rollouts
produce one session: retain the accepted readable file, falling back to the first
readable candidate when necessary. Rollouts without a native ID use path-based
identity. See [ADR-0003](adr/0003-use-session-source-adapters.md) for duplicate-selection
rules and [home identity and routing](#home-identity-and-routing) for source scoping.

### Home identity and routing

See [Multiple homes](usage.md#multiple-homes) for command-line usage.

Home identity follows its configured absolute path. Renaming, reordering, or adding
homes preserves existing IDs; moving a home creates a new identity. Native IDs,
relationships, and recoverable I/O errors are home-scoped. Projects merge by
directory across homes.

Creation requires `sourceInstanceId` with multiple homes; omission with a single home
selects that home. Unknown IDs and ambiguous omission return `400`. The source is part
of the idempotency fingerprint, so reuse of a request ID for another home returns
`409`. Launch environment, association, exit, archive, deletion, and confirmation use the
selected or owning home, with the same local `codex` executable.

## Catalog

### Snapshot

`GET /api/v1/sessions` returns a complete `{ revision, homes, projects, sessions }` snapshot:

- Homes: `{ sourceInstanceId, nickname }`, including empty homes; home paths are private.
- Projects: `{ id, directory }`.
- Sessions: `{ id, sourceInstanceId, title, projectId, status, parentId, isChild, updatedAt }`.
- Titles are resolved display names. Missing directories produce `projectId: null`.
  `isChild` preserves a declared parent relationship even if `parentId` cannot resolve.

### Long polling and revisions

The only query parameter is `after`: 43 base64url characters. Invalid values or
other parameters return `400`.

| Request                                        | Response                               |
| ---------------------------------------------- | -------------------------------------- |
| No `after`, or a different revision            | Immediate `200` with the full snapshot |
| Matching revision, then a change               | `200` with the full snapshot           |
| Matching revision, no change within 25 seconds | Bodyless `204`                         |
| More than 100 concurrent catalog waiters       | `429`, `Retry-After: 2`                |

Waiters share a 1.5-second source probe that stops when idle. Disconnects and
shutdown release waiters.

Catalog revisions track home metadata, titles, projects, status, and parent
relationships, but exclude timestamps, content, statistics, and diagnostics.
Catalog diagnostics are deduplicated in server logs rather than sent to clients.

### Ordering and status

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

### Paging and lazy details

Timeline pages include session metadata, items, a cursor, `hasMore`, interaction
state, and an update revision. Cursors validate timeline prefix continuity; incompatible
changes or cursors from a previous server process return `409 timeline_changed`;
malformed cursors return `400 invalid_query`. Lazy details must be within the
cursor's confirmed prefix. See [paging limits](session-jsonl-filtering.md#truncation-and-paging).

### Automatic updates

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

See [file uploads](usage.md#file-uploads) for composer behavior, storage configuration,
and cleanup.

## Tmux interaction

| Endpoint                                         | Request or response                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/v1/sessions/:id/messages`             | `{ message }`; success returns `204`                                                                                                             |
| `POST /api/v1/sessions/:id/keys`                 | `{ keys }`; success returns `204`                                                                                                                |
| `POST /api/v1/sessions/:id/handoff-pane-binding` | Empty object `{}`; returns `204` after sending the binding command to the connected pane; handoff is recognized from a subsequent binding record |
| `WS /api/v1/sessions/:id/terminal-preview`       | JSON `snapshot`, `delta`, and `error` messages (see below)                                                                                       |

Supported keys and message limits are defined in
[interaction.ts](../src/shared/interaction.ts). Supported responses include `state`,
`activity`, nullable `supersededBySessionId`, and nullable `attachCommand`.
Unsupported responses omit the state fields and retain `attachCommand`.

Interaction states are `unbound`, `disconnected`, `connected`, `unknown`, and
`superseded`. Effects require validated socket ownership, pane liveness, and
binding ownership. Concurrent checks are shared; completed results are not cached.
Binding changes during validation may report `unknown` until the next refresh.
Socket/pane reuse targets the current pane without comparing process identity.
Uncertain input is not automatically resent.

### Binding format and ownership

The Codex adapter recognizes `CODEX_HUB_TMUX_BIND_V4` declarations in user-message
`<user_shell_command>` output. Successive lines contain an absolute socket path,
a `%`-prefixed numeric pane ID, an optional operation UUID, and an optional project
directory. New bindings use this five-line V4 format. Empty optional fields retain
their lines. V3 remains supported without
the project field. An invalid latest binding does not fall back to an older one;
project-field handling is described under [Project directory](#project-directory).

Bindings are shared across homes, retaining the latest attempt per session and the
latest valid claim per socket/pane. Creation correlates its operation UUID with the
recorded binding. See [ADR-0018](adr/0018-cache-validation-per-binding-record.md)
for event ordering and ownership rules.

When a later claim takes a pane, its former owner returns `superseded` and cannot
send input, hand off the binding, preview, or shut down that pane during archive.
`supersededBySessionId` names the replacing session only while it is readable,
including when archived. Missing replacements leave the state `superseded` with
a null ID.
Takeover facts survive archive, deletion, and full rereads for the process lifetime;
a later explicit binding can reclaim a pane. `attachCommand` is null for `superseded`.

### Project directory

Project Directory is the latest valid project path recorded in a pane bind, falling
back to Working Directory. Paths must be absolute and contain no NUL, CR or LF;
values are preserved without filesystem checks or Git discovery. Invalid or empty
project fields do not invalidate the pane bind or erase an earlier project path.

### Activity observation

`activity` is `null` unless connected. Connected values are:

| Value     | Meaning                                             |
| --------- | --------------------------------------------------- |
| `working` | Pane output within the monotonic five-second window |
| `idle`    | No output within that window                        |
| `unknown` | Initial or failed observation                       |

Observation uses `%output` / `%extended-output` notifications. Failed subscriptions
retry on the next read. Detail, timeline, updates, and interaction reads renew a
60-second lease. Activity and preview share control clients; activity does not
capture frames.

Activity transitions affect `updateRevision` through the 1.5-second update checks;
repeated output while already working does not. Catalog summaries omit activity.

### Terminal Preview

Preview captures the current pane screen as plain text, not scrollback or a terminal
emulator stream. Captures retain the last 256,000 UTF-8 bytes without splitting a
character and report `truncated` when the beginning was removed.

#### Transport and frames

The preview endpoint uses `ws` or `wss`,
inheriting the server's TLS and optional client certificate requirements. Upgrade
requests accept no query parameters and reject cross-origin browser requests.
Ordinary HTTP requests receive `426 Upgrade Required`. Clients send no application
messages.

Server messages are JSON text with a `type` discriminator:

| `type`     | Fields                                                              |
| ---------- | ------------------------------------------------------------------- |
| `snapshot` | `revision`, `content`, `truncated`, `capturedAt`                    |
| `delta`    | `baseRevision`, `revision`, `operations`, `truncated`, `capturedAt` |
| `error`    | `code`, `message`, `retryable`                                      |

An error closes the connection: `1013` if retryable, otherwise `1008`.

Every connection starts with a full snapshot. Each delta applies to the preceding
frame: operations contain `startLine`, `deleteCount`, and `lines`, refer to the
original line indices, and run in strictly descending, nonoverlapping order.
Splitting and joining on `"\n"` preserves blank lines and trailing newlines;
truncation-only changes may use an empty operations array.

The server falls back to a snapshot if diff computation exceeds its budget or a
delta is too large or no smaller than full text. Clients validate frames before
applying them; invalid updates preserve the display and require reconnection.
Connections always restart from a full snapshot.

#### Subscriptions and capacity

Viewers share tmux listeners and captures without changing terminal size or session
environment. Output events merge over 350 milliseconds; only content or truncation changes
publish a frame. The server allows 100 connections globally and 10 per session,
including initialization; excess connections receive retryable `preview_capacity_exceeded`.
Repeated valid binds for the same session, socket and pane preserve subscriptions.
Ownership loss, invalid binds, target changes and listener failures invalidate affected
subscriptions immediately; returning ownership does not revive a closed subscription.

#### Browser behavior

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

### Operation model

Every operation includes `operationId`, `type`, `status`, `createdAt`, `updatedAt`,
and nullable `sessionId`, `error`, `phase`, and `attachCommand`.

| Field               | Values or condition                                               |
| ------------------- | ----------------------------------------------------------------- |
| `type`              | `create`, `exit`, `archive`, `delete`                             |
| `status`            | `pending`, `succeeded`, `failed`, `unknown`                       |
| `mode`              | Create only: `new` or `resume`                                    |
| `target`            | Known launch target: `{ socketPath, paneId }`                     |
| `phase` for exit    | `sending_exit`, `waiting_exit`                                    |
| `phase` for archive | `sending_exit`, `waiting_exit`, `archiving`, `confirming_archive` |

### Idempotency and conflicts

Create request IDs contain 8–128 letters, digits, underscores, or hyphens. Identical
IDs and arguments coalesce through execution and the 30-minute terminal retention
period; changed arguments return `409`. Different IDs may create concurrently in
the same project. Exit/archive/delete coalesce identical operations on a session;
conflicting operations return `409` without queuing. Resume uses the same session
occupancy as exit/archive/delete. Resume requests with different request IDs cannot
launch concurrently for one session; identical request IDs retain create idempotency.

### Execution and confirmation

Create and resume share one launch operation. Worktree and YOLO are launch options.
Native commands inherit the owning `CODEX_HOME`; the hub does not move or delete
rollout files directly.

#### Create

Validate an existing directory and use its real path for both launch
and the bind project field, including when Codex creates a worktree.
Launch Codex as the main pane process in a dedicated
`codex-hub-<operationId>` tmux session with `--no-daemon --no-alt-screen`, optional
`--worktree` and `--yolo` (both off by default). Confirm the operation marker,
launch target, project, and valid binding within 300 seconds after launch.
Show an attach command after 30 seconds and retain it on timeout.

#### Resume

Use the original session's owning source and opaque native ID. Format validation
belongs to that adapter; only Codex requires a UUID.

1. **Check eligibility:** require an unarchived, unique valid identity and either
   no binding record, or a valid latest binding with a confirmed dead/missing or
   explicitly transferred pane. Invalid bindings, timeouts, and errors never
   authorize resume. Unbound sessions show a reminder to exit the original process.
2. **Resolve launch directory:** try Working Directory, then Project Directory.
   Skip empty or invalid paths; fall back if missing or not a directory. Use the
   selected real path while retaining the original project in the bind. Reject
   directory, source, and worktree overrides; `yolo` defaults to false.
3. **Launch and confirm:** revalidate before launching `codex resume <UUID>` in a
   new pane. Require the original identity, operation marker, matching project,
   and a live owned launch target for confirmation.

#### Exit

Resolve the source and latest binding; no native ID is required.
Binding transfers control of the whole pane, including manually bound panes.
Send interrupts and EOF with grace periods, then force-close that pane if needed.
Success requires a missing or dead pane within 30 seconds; query errors or
changed ownership end tracking as `unknown`.
Uncertain effects are not retried. An unbound session succeeds without effects;
a missing session fails. Archived sessions use the same checks. Exit preserves
session data. See [ADR-0022](adr/0022-separate-session-exit-from-archive.md)
for the shutdown sequence and whole-pane tradeoffs.

#### Archive

Reread the source snapshot. Already archived sessions succeed
immediately. Validate the unique native identity, then reuse the independent
exit service. Only successful exit proceeds to native archive, once. The native
command allows 25 seconds; archive confirmation allows 30 seconds. While exit,
archive, or delete occupies the session, ordinary input and handoff requests
return `409 session_busy`. Archive retains occupancy through confirmation.

#### Delete

Require an archived session, run the native command, and confirm its
same-source native identity is absent, within 30 seconds. A session already absent
from a successful initial snapshot succeeds immediately.

Successful snapshots may skip unreadable data and still confirm results; thrown
read errors do not prove deletion.

### Tracking and recovery

#### Server lifecycle

Operations continue independently of browser queries. Timeout ends tracking as
`unknown` without undoing submitted commands. Terminal states are immutable and
release session occupancy; results and create deduplication records remain in
memory for 30 minutes. Restart loses these records and leaves tmux sessions running.

Unknown Create and Resume outcomes retain known target/attach information. Reuse
the same `requestId` to retrieve the original operation during retention. A new ID
may launch another session after normal checks, even if the previous launch is
still running; inspect tmux before submitting again.

#### Browser recovery

The browser polls pending operations one second after each completed query.
Hidden pages pause queries and resume when visible; submitted writes continue,
and returned operation IDs retain recovery markers. Reload can resume polling.
All terminal states and `404` clear recovery markers; nonretryable query errors
require manual retry. Network retries of create reuse its request ID until a
terminal result, after which the ID is discarded.

## Optional hosting

Hosting is independent of session adapters and is enabled only by `--hosting`.
`GET /api/v1/capabilities` reports `{ hosting: boolean }`. Disabled hosting does
not initialize storage and returns 404 for hosting pages and APIs. Resource
commands work offline and accept `--hosting-dir` and `--json`. Existing
HTTPS/mTLS or reverse-proxy authentication applies to both resource types;
hosting adds no application login.

Publish/delete share a process-aware filesystem lock. Complete owner directories
are installed by atomic rename; dead owners are reclaimed only after the OS
reports their PID absent. Permanent tombstones prevent competing reclaimers from
moving a newly acquired lock. A separate service lock permits one Hub process per
hosting root. A PID reused by another live process conservatively blocks recovery.
Manual storage changes should be performed without concurrent publication.

### Web pages

`GET /api/v1/artifacts` rescans disk and returns `projects`, each with a
`directory` and `artifacts`; `DELETE /api/v1/artifacts/:id` removes every snapshot.
Malformed metadata is skipped with a diagnostic. Projects are not filtered by
Codex home or session availability.

Project ownership uses `realpath` of the explicitly supplied project directory.
Moving a project creates a new association; existing snapshots remain accessible.
Under `<hosting>/projects`, absolute project path segments mirror the original
path, escaping `%` as `%25` and the reserved `.hub` segment as `%2Ehub`.
Artifact directories live at
`<hosting>/projects/<encoded-project-path>/.hub/artifacts/<encoded-name>/`,
containing `artifact.json` and `snapshots/<snapshot-id>/`. Names are URI encoded
into one segment, including dots. Artifact and snapshot IDs are random 32-character lowercase
hexadecimal strings. Metadata stores identity, title, project, source, current
snapshot, creation/update times and relative URL; it contains no session identity
or server address.

Publication copies regular files/directories into a temporary snapshot, rejects
nested symlinks and special files, and rejects overlap with hosting storage.
The source root itself may be a symlink alias and is canonicalized first.
Snapshot rename precedes atomic metadata replacement. A failed publication
preserves the previous metadata; interrupted temporary/unreferenced snapshots
are inert and disappear when their artifact is deleted. Previous snapshots stay
available until deletion, keeping old documents and their relative assets
consistent. No expiry or history management is provided.

`/web/:id/` redirects with 302 to `/web/:id/:snapshotId/`. GET and HEAD support
files and directory `index.html`, without directory listing, traversal, metadata
access or SPA fallback. Every request reads disk metadata, so refresh and unknown
IDs also observe offline publications/deletions. Responses use
`Cache-Control: private, no-store`. Entry and directory redirects preserve query
parameters. Local resources should use relative paths; root-relative paths are
not rewritten. External resources depend on the viewer's network and the
provider's cross-origin policies.

Hosted pages are trusted same-origin code, with the same authority as Hub. Their
responses omit the Hub UI's restrictive CSP so inline scripts/styles, modules,
fonts, JSON and external HTTPS resources can load. Hub's own CSP is unchanged.
Session Markdown permits `/web/<32 lowercase hex digits>/` as a relative hosted-page link, preserving
existing absolute protocol rules. Copy link uses the current browser origin.

### Temporary diffs

Each `diff publish <file>` creates an independent UUID v4 resource at
`<hosting>/diffs/<uuid>/`: `raw.diff` stores the original bytes and
`metadata.json` stores `id`, `title`, `createdAt`, and `url`. Publication uses
atomic directory rename under the shared hosting write lock; deletion uses the
same lock. `diff list` reads metadata only; CLI deletion is idempotent. Cleanup
is explicit and leaves the source file intact; diffs have no project or session
association.

With `--hosting`, `/diffs/<uuid>` serves the viewer,
`GET /api/v1/diffs/:uuid` returns metadata plus `raw`, and
`DELETE /api/v1/diffs/:uuid` returns 204 on deletion. Missing resources and
disabled hosting return 404; there is no HTTP list endpoint. Pages and data use
`private, no-store`, retain Hub CSP, and render content as
text. Session Markdown opens canonical `/diffs/<uuid>` links in a new tab.

The viewer supports Git unified diffs, including renames, mode changes, binary
markers, and C-quoted paths. Unsupported or incomplete input shows a warning;
the original text is available when parsing is incomplete.

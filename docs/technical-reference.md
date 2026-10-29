# Technical reference

Current API and runtime contracts. See [Usage](usage.md) for setup,
[JSONL filtering](session-jsonl-filtering.md) for record processing, and
[ADRs](adr/README.md) for decision history. Response types live in
[api-contract.ts](../src/shared/api-contract.ts); IDs, cursors, and revisions are
opaque values that clients must return unchanged.

- [Sources and identity](#sources-and-identity)
- [Catalog](#catalog)
- [Reader and automatic updates](#reader-and-automatic-updates)
- [File uploads](#file-uploads)
- [Tmux interaction](#tmux-interaction) and [Terminal Preview](#terminal-preview)
- [Asynchronous management](#asynchronous-management)
- [Optional hosting](#optional-hosting): [pages](#web-pages) and [diffs](#temporary-diffs)

## Sources and identity

### Discovery and caching

Codex discovery reads `rollout-*.jsonl` under `sessions/` and `archived_sessions/`.
`session_index.jsonl` supplies advisory names; Codex databases are not read.

Unarchived rollouts use in-memory checkpoints. A growing file reuses its decoded
prefix only when decoder/normalizer versions and SHA-256 probes match. Probes
cover the first 4 KiB and up to 4 KiB before the previous EOF. Reads use one open
handle and observed EOF, starting after the last committed newline. Truncation,
same-size changes, probe mismatches, incompatible state, and restart require a
full decode. These probes can miss a middle rewrite that preserves both regions
and then appends; see [ADR-0012](adr/0012-use-checkpointed-incremental-rollout-loading.md).

Loaded archives reuse cached content until restart or restoration. In-place edits
and permission changes are not detected while cached; discovery, removal,
advisory metadata refresh, and failed-load retries continue.

### Session identity

Native IDs identify sessions within a home. Duplicate rollouts produce one session:
retain the accepted readable file, or fully read the first readable candidate in
existing path order when initially selecting or replacing it. Ignored duplicates
publish no sessions or binding events and retain no decode cache. Rollouts without
native IDs use path-based identity.

Shared services treat native IDs as opaque strings and check presence and
source-local uniqueness. Format validation belongs to the adapter; Codex requires
UUIDs. Parent relationships never cross homes.

### Adapter publication and diagnostics

Adapters publish immutable snapshots, including nested timeline and detail values.
Reference reuse is optional and means unchanged content; equivalent fresh values
are valid. Registration requires nonempty, independently unique `instanceKey` and
`sourceInstanceId`. Adapters use server domain types.

HTTP path IDs are decoded once after segment splitting. They must be nonempty,
at most 1,024 UTF-8 bytes, and contain no controls, slashes, backslashes, or
standalone `.` / `..`. Reads also validate item kind, ownership, and cursor bounds.

Diagnostics stay in server logs, outside public responses, management policy, and
revisions. Logging defaults to stderr and deduplicates by source, session, and
content; cleared diagnostics may recur and vanished objects release logging state.
Per-source limits prevent one source from hiding another's diagnostics. Unchanged
cache hits do not traverse diagnostics; logging failures do not stop operations.

`ENOENT`, `EACCES`, `EPERM`, `ESTALE`, `EISDIR`, and `ENOTDIR` cause unreadable
portions to be skipped and diagnosed. Initially absent allowed directories are
normal. Path/symlink restrictions still apply; unexpected exceptions propagate.
Successful snapshots have no completeness gate.

### Home identity and routing

Home identity follows its configured absolute path. Renaming or reordering homes
preserves IDs; moving a home changes identity. Projects merge by directory across
homes. Home paths remain private.

Creation requires `sourceInstanceId` when multiple homes are configured; a single
home is selected implicitly. Unknown or ambiguous sources return `400`. The source
is part of request idempotency, so reusing a request ID for another home returns
`409`. Launch and lifecycle operations use the selected or owning home and its
`CODEX_HOME`, with the same local `codex` executable. See [Multiple homes](usage.md#multiple-homes).

## Catalog

`GET /api/v1/sessions` returns the complete `{ revision, homes, projects, sessions }`
snapshot. There is no pagination or server-side filtering.

| Collection | Fields                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------- |
| `homes`    | `sourceInstanceId`, `nickname`; includes empty homes                                         |
| `projects` | `id`, `directory`                                                                            |
| `sessions` | `id`, `sourceInstanceId`, `title`, `projectId`, `status`, `parentId`, `isChild`, `updatedAt` |

Titles are resolved display names. Missing directories yield `projectId: null`.
`isChild` records a declared parent even when `parentId` cannot resolve.

The only query parameter is `after`, a 43-character base64url revision. Invalid or
extra parameters return `400`.

| Condition                                   | Result                   |
| ------------------------------------------- | ------------------------ |
| No `after`, or revision differs             | Immediate `200` snapshot |
| Matching revision changes within 25 seconds | `200` snapshot           |
| Still unchanged after 25 seconds            | Bodyless `204`           |
| More than 100 waiting requests              | `429`, `Retry-After: 2`  |

Waiters share a 1.5-second source probe that stops when idle. Disconnect and
shutdown release waiters. Revisions cover home metadata, titles, projects,
status, and relationships; timestamps, content, statistics, and diagnostics do
not wake catalog requests.

The browser sorts by best-effort `updatedAt`, with projects ordered by their latest
visible main session. It retains newer timestamps from snapshots and opened
readers without extra requests or persistence. IDs break ties; invalid times sort
last. Hidden pages pause requests and reconnect when visible.

Status is `normal | live | archived`. Archive wins; Live requires an observed
living pane owned by the session. Normal does not authorize Resume. Runtime checks
share concurrent observations and bound socket concurrency; errors revoke Live
and resume permission.

## Reader and automatic updates

| GET endpoint                                   | Contract                                     |
| ---------------------------------------------- | -------------------------------------------- |
| `/api/v1/sessions/:id`                         | Session, interaction, and update revision    |
| `/api/v1/sessions/:id/items`                   | Timeline page; optional `limit` and `cursor` |
| `/api/v1/sessions/:id/items/:itemId/directive` | Directive text; requires `cursor`            |
| `/api/v1/sessions/:id/items/:itemId/tool`      | Tool input/output; requires `cursor`         |
| `/api/v1/sessions/:id/items/:itemId/internal`  | Internal JSON; requires `cursor`             |
| `/api/v1/sessions/:id/updates`                 | Long poll; requires `cursor` and `after`     |

Pages contain session metadata, items, `cursor`, `hasMore`, interaction, and
`updateRevision`. Only item reads advance the cursor. Lazy details must lie within
its confirmed prefix. Changed prefixes or cursors from a previous process return
`409 timeline_changed`; malformed cursors return `400 invalid_query`.
See [paging limits](session-jsonl-filtering.md#truncation-and-paging).

Update requests validate the cursor without advancing it or returning items;
backlog loads through the items endpoint. Probes run every 1.5 seconds for up to
25 seconds, then return `204` if unchanged. Capacity is 100 waiters per process
and 10 per session; excess requests receive `429` with `Retry-After: 2`.
Disconnect and shutdown release waiters.

Reader metadata exposes `resume: { allowed, reason }`, with null `reason` when
allowed. Status, resume, interaction, and `updatedAt` affect reader revisions,
independently of catalog revisions. Each response shares one pane observation for
runtime and interaction; effects validate ownership again at execution time.
Only the opened, unarchived session subscribes. History paging coexists with
updates while preserving reading position.

## File uploads

| Endpoint                                                          | Contract                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `POST /api/v1/uploads?sessionId=<Hub ID>&filename=<encoded name>` | Raw binary, at most 20 MiB; existing session required       |
| `GET /api/v1/sessions/:id/uploads`                                | `{ items }`, newest first, without pagination               |
| `GET /api/v1/sessions/:id/uploads/:attachmentId/content`          | Raster preview; `?download=1` forces download               |
| `DELETE /api/v1/sessions/:id/uploads/:attachmentId`               | Delete content and registration; repeated deletion succeeds |

Uploads return `201` with `path`, `id`, `sessionId`, `filename`, `size`, `type`,
and `uploadedAt` (also grouped as `attachment`). IDs and paths are unique; names
never overwrite files. Oversize returns `413`, storage errors `500`, and mutations
reject cross-origin access. Content/delete access is session-scoped. HTML, SVG,
and other non-preview types always download; all content uses `nosniff` and a
sandbox CSP.

Storage is `<home-dir>/uploads/<Hub session ID>/`.
Metadata commits use atomic rename and record absolute content paths.

Deletion first renames metadata to a tombstone, hiding the attachment, then removes
content and tombstone. Failed cleanup retries on deletion or startup. Startup also
cleans interrupted uploads, logging failures without blocking service. Cleanup
does not block other uploads. Confirmed session deletion starts background cleanup;
failed/unconfirmed deletion does not. Archive and exit retain uploads.

Drafts are in memory per session; navigation aborts unfinished uploads. Preview
object URLs are revoked on removal/unmount. Sending prefixes text with one server
path per line and a blank line, quoting paths when needed; attachment-only messages
contain paths only. Message limits apply to the complete result. Failed sends
retain drafts; successful sends clear them only if unchanged. Removing a draft
attachment leaves its file on disk. See [upload usage](usage.md#file-uploads).

## Tmux interaction

| Endpoint                                         | Request / response                                    |
| ------------------------------------------------ | ----------------------------------------------------- |
| `POST /api/v1/sessions/:id/messages`             | `{ message }` → `204`                                 |
| `POST /api/v1/sessions/:id/keys`                 | `{ keys }` → `204`                                    |
| `POST /api/v1/sessions/:id/handoff-pane-binding` | `{}` → `204`; a later binding record confirms handoff |
| `WS /api/v1/sessions/:id/terminal-preview`       | Snapshot, delta, or error frames                      |

Keys and message limits live in [interaction.ts](../src/shared/interaction.ts).
Supported interaction responses contain `state`, `activity`,
`supersededBySessionId`, and `attachCommand`; unsupported responses retain only
`supported: false` and `attachCommand`.

States are `unbound`, `disconnected`, `connected`, `unknown`, and `superseded`.
Effects require current-user socket ownership, pane liveness, and binding ownership.
Concurrent checks coalesce; completed results are not cached. Missing sockets,
stopped servers, or dead/missing panes mean unavailable; permissions, timeouts,
and malformed responses mean unknown. Binding changes during an await fail closed
without recursive validation. Queued input and previews revalidate ownership;
uncertain input is never automatically resent. Socket/pane reuse is allowed
without process-identity checks.

### Binding format and ownership

Codex reads `AHUB_TMUX_BIND_V1` in user-message `<user_shell_command>` output.
Its five lines are the marker, absolute socket path, numeric `%` pane ID, optional
operation UUID, and optional project directory. Empty optional fields keep their
lines. An invalid latest attempt never falls back to an older bind.

One process-wide manager retains the latest attempt per session and latest valid
claim per socket/pane across homes. Adapters submit accepted records, including
appends. Ordering is timestamp (invalid → zero), global session ID, record ordinal,
then position. New claims do not release older claims on other panes.

Takeover makes the former owner `superseded`, revoking input, handoff, preview,
and shutdown authority. `supersededBySessionId` identifies the replacement only
while readable, including archived sessions; otherwise it is null. Attach is null.
Claims survive archive, deletion, rereads, and Hub close for the process lifetime;
an explicit later bind can reclaim ownership. See
[pane-binding-manager.ts](../src/server/interaction/pane-binding-manager.ts).

### Project directory

The latest valid bind project path overrides Working Directory. Paths must be
absolute and exclude NUL, CR, and LF; no filesystem or Git checks are performed.
Empty/invalid fields neither invalidate the pane bind nor erase an earlier project.

### Activity observation

Activity is null unless connected. Output in the last monotonic five seconds means
`working`; otherwise `idle`. Initial or failed observation means `unknown`.
`%output` / `%extended-output` subscriptions retry on the next read after failure.
Reader and interaction reads renew a 60-second lease. Activity shares control
clients with preview without capturing frames. Transitions affect reader revisions;
repeated output while already working does not. Catalog omits activity.

### Terminal Preview

Preview is the current screen as plain text, not scrollback or terminal emulation.
It retains the last 256,000 UTF-8 bytes without splitting a character and marks
removed prefixes as `truncated`.

WebSocket upgrades inherit TLS/mTLS, accept no query parameters, and reject
cross-origin browser requests. Ordinary HTTP receives `426`. Clients send no
application messages.

| Frame `type` | Fields                                                              |
| ------------ | ------------------------------------------------------------------- |
| `snapshot`   | `revision`, `content`, `truncated`, `capturedAt`                    |
| `delta`      | `baseRevision`, `revision`, `operations`, `truncated`, `capturedAt` |
| `error`      | `code`, `message`, `retryable`                                      |

Every connection starts with a snapshot. Delta operations contain `startLine`,
`deleteCount`, and `lines`, reference the preceding frame's line indices, and run
in descending, nonoverlapping order. Split/join on `"\n"` preserves trailing and
blank lines; truncation-only changes may have no operations. Oversized deltas,
excessive diff work, or deltas no smaller than a full frame fall back to snapshots. Invalid frames
preserve the display and require reconnection. Errors close with `1013` when
retryable, otherwise `1008`.

Listeners/captures are shared without resizing terminals or changing their
environment. Output merges over 350 ms; only content/truncation changes publish.
Capacity is 100 connections globally and 10 per session, including initialization;
excess gets retryable `preview_capacity_exceeded`. Repeated identical valid binds
preserve subscriptions. Ownership loss, invalid binds, changed targets, and
listener failures close affected subscriptions; returning ownership cannot revive them.

The browser connects only while expanded, connected, and visible. Retryable errors
back off; terminal errors wait for a lifecycle change or explicit retry. Failures
retain the last frame and stopped-updates notice. Dismissing details does not
reconnect; explicit retry cancels backoff. See the
[preview service](../src/server/interaction/terminal-preview-service.ts) and
[WebSocket transport](../src/server/http/terminal-preview-websocket.ts).

## Asynchronous management

| Endpoint                              | Body / result                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/sessions`               | New: `{ sourceInstanceId?, directory, worktree, yolo?, requestId }`; resume: `{ resumeSessionId, yolo?, requestId }` → `202` operation |
| `POST /api/v1/sessions/:id/exit`      | `{}` → `202` operation                                                                                                                 |
| `POST /api/v1/sessions/:id/archive`   | `{}` → `202` operation                                                                                                                 |
| `DELETE /api/v1/sessions/:id`         | `{}` → `202` operation                                                                                                                 |
| `GET /api/v1/operations/:operationId` | Current operation                                                                                                                      |

### Service responsibilities

The coordinator owns idempotency, occupancy, deadlines, results, and retention.
Launch/lifecycle executors own validation, adapter effects, and confirmation,
reusing the exit service for shutdown. Executors check operation activity after
asynchronous work; registry and occupancy cleanup remain coordinator-owned. See
[operation service](../src/server/management/operation-service.ts),
[launch executor](../src/server/management/session-launch-executor.ts), and
[lifecycle executor](../src/server/management/session-lifecycle-executor.ts).

### Operation model

Operations contain `operationId`, `type`, `status`, `createdAt`, `updatedAt`, and
nullable `sessionId`, `error`, `phase`, `attachCommand`. Optional `target` is
`{ socketPath, paneId }`; create uses `mode: new | resume`.

- Types: `create`, `exit`, `archive`, `delete`.
- Statuses: `pending`, `succeeded`, `failed`, `unknown`.
- Exit phases: `sending_exit`, `waiting_exit`; archive additionally uses
  `archiving`, `confirming_archive`.

### Idempotency and conflicts

Request IDs are 8–128 letters, digits, underscores, or hyphens. Identical launch
IDs/arguments coalesce through execution and 30-minute terminal retention;
changed arguments return `409`. Different IDs can create concurrently in a project.
Resume, exit, archive, and delete share session occupancy: identical lifecycle
operations coalesce; conflicting work returns `409` without queuing. Different
request IDs cannot resume the same session concurrently.

### Execution and confirmation

Create and resume share one launch operation. Worktree and YOLO are launch options.
Native commands use the owning `CODEX_HOME`; the Hub never moves or deletes rollout
files directly.

| Operation | Validation and confirmation                                                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create    | Resolve an existing directory to its real path for launch and project association, including worktrees. Match operation marker, launch target, project, and valid binding within 300 seconds after launch.                                                                           |
| Resume    | Require an unarchived, unique valid native identity and no binding, confirmed pane death, or explicit transfer. Invalid bindings and uncertain checks deny resume. Revalidate before launch; confirm original identity, operation marker, project, and live owned target.            |
| Exit      | Validate latest binding; send interrupts/EOF, then force-close the whole pane if needed. Confirm dead/missing within 30 seconds. Query errors or changed ownership end as `unknown`. Unbound succeeds without effects; missing session fails; archived sessions use the same checks. |
| Archive   | Reread source; already archived succeeds. Validate unique native identity, complete exit, then run native archive once (25-second command limit) and confirm within 30 seconds.                                                                                                      |
| Delete    | Require archive, run native delete, and confirm same-source native identity absent within 30 seconds. Already absent in a successful initial snapshot succeeds.                                                                                                                      |

Codex launches its main pane in `ahub-<operationId>` with `--no-daemon
--no-alt-screen`, plus optional `--worktree` and `--yolo` (default off). The initial
CLI argument carries the binding shell instruction. Resume uses `codex resume
<UUID>`, trying Working Directory then Project Directory; skip invalid paths and
fall back only for missing/non-directory paths. Launch from the chosen real path
while keeping the original project association. Resume rejects source, directory,
and worktree overrides. Unbound sessions require the user to ensure the original
process has exited.

Attach appears after 30 seconds and survives launch timeout, using the known
target or configured socket and deterministic session name. Confirmed no-launch
tmux errors are `failed`; launch timeouts, malformed successful output, and
post-launch errors are `unknown`, with no automatic retry or teardown.

Exit transfers control of the entire pane, including manual bindings, and retains
session data. See [ADR-0022](adr/0022-separate-session-exit-from-archive.md) for
shutdown timing and costs. Lifecycle occupancy blocks ordinary input/handoff with
`409 session_busy`; archive holds occupancy through confirmation. Successful
snapshots may skip unreadable data and still confirm absence; thrown read errors
never prove deletion.

### Tracking and recovery

Server tracking continues without browser queries. Timeout yields `unknown`
without undoing commands. Terminal results are immutable, release execution state
and occupancy, and remain with launch deduplication records for 30 minutes.
Hung observations cannot block timeout cleanup; late continuations check activity.
Restart loses tracking and leaves tmux sessions running.

Unknown launches retain target/attach information. Reuse the same request ID during
retention to retrieve the result. A new ID may launch again after normal checks,
even while the previous launch still runs.

The browser polls pending operations one second after each query completes,
pausing while hidden. Reload can resume from stored operation IDs. Terminal states
and `404` clear recovery markers; nonretryable query errors require manual retry.
Network retries of launch reuse the request ID until a terminal result, then
discard it. Submitted writes continue independently of page visibility.

## Optional hosting

Hosting is adapter-independent and enabled only by `--hosting`.
`GET /api/v1/capabilities` returns `{ hosting: boolean }`. Disabled hosting creates
no storage and returns `404` for hosting pages/APIs. Offline resource commands use
`--home-dir` and `--json`. Existing HTTPS/mTLS or proxy authentication applies;
hosting adds no application login.

Publish/delete share a process-aware filesystem lock installed by atomic rename.
Dead owners are reclaimed only after the OS reports their PID absent; tombstones
prevent reclaimers from disturbing newly acquired locks. PID reuse by a live
process blocks recovery.
Avoid manual storage changes during publication.

### Web pages

`GET /api/v1/artifacts` rescans disk and returns projects with `directory` and
`artifacts`; `DELETE /api/v1/artifacts/:id` removes all snapshots. Invalid metadata
is skipped with diagnostics. Resources are independent of homes/session availability.

Pages match canonical project `realpath` plus name. Republishing retains identity,
title unless overridden, and history; moving the project creates a new association.
IDs and snapshot IDs are random 32-character lowercase hex strings. Storage is
`<hosting>/artifacts/<id>/artifact.json` plus `snapshots/<snapshot-id>/`; metadata
contains identity, title, project/source, current snapshot, timestamps, and relative
URL, without session identity or server address.

Publication accepts regular files/directories, canonicalizes the source root, and
rejects nested symlinks, special files, and hosting-storage overlap. Snapshot rename
precedes atomic metadata replacement, preserving old metadata on failure. Old
snapshots remain available until artifact deletion, which also removes inert
interrupted/unreferenced snapshots. There is no expiry or history management.

`/web/:id/` redirects (`302`) to `/web/:id/:snapshotId/`. GET/HEAD serve files and
directory `index.html`, with no listing, traversal, metadata access, or SPA fallback.
Requests read disk metadata so offline changes are visible. Responses use
`private, no-store`; entry/directory redirects preserve queries. Assets should use
relative paths; root-relative paths are not rewritten. External resources depend
on viewer connectivity and provider cross-origin policies.

Pages are trusted same-origin code with Hub authority. They omit Hub UI's
restrictive CSP so scripts, styles, modules, fonts, JSON, and external HTTPS
resources can load; Hub CSP stays unchanged. Session Markdown permits canonical
`/web/<id>/` links; copied links use the current browser origin.

### Temporary diffs

Each `diff publish <file>` creates an independent UUID v4 at
`<hosting>/diffs/<uuid>/`, with original bytes in `raw.diff` and identity, title,
creation time, and URL in `metadata.json`. Publication atomically renames the
directory under the hosting write lock; deletion shares that lock. CLI list reads
metadata only; deletion is idempotent. Cleanup is explicit, preserves the source,
and has no project/session association.

With hosting enabled, `/diffs/<uuid>` serves the viewer;
`GET /api/v1/diffs/:uuid` returns metadata and `raw`, and
`DELETE /api/v1/diffs/:uuid` returns `204`. Missing/disabled resources return `404`;
there is no HTTP list endpoint. Responses use `private, no-store`, retain Hub CSP,
and render diff content as text. Canonical Markdown links open in a new tab.

The viewer supports Git unified diffs, renames, mode changes, binary markers, and
C-quoted paths. Unsupported/incomplete input shows a warning and preserves access
to the original text.

## Browser state

Long-lived preferences use the versioned localStorage key `ahub.preferences.v1`, synchronized across same-origin tabs. Tab-local browsing state is grouped under `ahub.browser-state.v1` in sessionStorage. Operation recovery and in-memory drafts retain independent lifecycles. Storage failures retain in-memory behavior.

## Interface localization

The browser preference `ahub.preferences.v1.language` selects `en` (default) or
`zh-CN`. Missing, malformed, and unsupported stored values fall back to English;
existing launch and theme preferences retain their behavior. Language changes apply
without reloading and synchronize through same-origin storage events. Storage
failures retain the in-memory choice. Locale affects presentation, not API values,
session identity, conversation text, terminal output, paths, or commands. Dates use
the device time zone; documentation captures fix the time zone to UTC.

`src/client/i18n/` owns bundled dictionaries, language metadata, semantic keys,
interpolation types, namespace assignment, and locale formatters. The English
catalog defines keys and parameters; Chinese must provide matching entries.
Common messages remain in `common`; feature messages use `hub`, `reader`,
`interaction`, `hosting`, `errors`, and `settings`. Missing or empty translations
fall back to English. New languages require a matching catalog, registration in
`languageOptions` and the initialization resources, and catalog validation tests.
No runtime translation fetch or browser-language detection is used.

Local notifications retain keys until rendering. Native diagnostic details remain
verbatim beside localized explanations; known structured API errors use their
codes, never English-message matching. Translation does not alter HTTP or
WebSocket contracts. Preference changes must not restart pending operations,
remount draft inputs, or reload already requested detail data.

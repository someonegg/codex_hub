# Technical reference

See [Usage](usage.md), [JSONL processing](session-jsonl-filtering.md),
[ADRs](adr/README.md), and [response types](../src/shared/api-contract.ts).
Return opaque IDs, cursors, and revisions unchanged.

- [Sources and identity](#sources-and-identity)
- [Catalog](#catalog)
- [Reader and automatic updates](#reader-and-automatic-updates)
- [Session CLI and observation](#session-cli-and-observation)
- [File uploads](#file-uploads)
- [Tmux interaction](#tmux-interaction) and [Terminal Preview](#terminal-preview)
- [Asynchronous management](#asynchronous-management)
- [Optional hosting](#optional-hosting): [pages](#web-pages) and [diffs](#temporary-diffs)
- [Browser state](#browser-state) and [localization](#interface-localization)

## Sources and identity

### Discovery and caching

Codex scans `rollout-*.jsonl` in `sessions/` and `archived_sessions/`;
`session_index.jsonl` provides advisory names. Databases are not read.
Trusted homes allow symlinks outside them, through directory depth 8 (root = 0),
without cycle detection/real-path deduplication. Descriptors, ordering, fallback IDs, and source-relative
cache keys use logical paths.

Unarchived rollouts cache by size and modification time; permission-only changes
do not invalidate content. Growing files reuse decoded prefixes when
decoder/normalizer versions and SHA-256 probes match. Probes cover the first
4 KiB and up to 4 KiB before the previous EOF. One open handle reads to observed
EOF, starting after the last committed newline. Restart, truncation, same-size
changes, incompatible state, or probe mismatch require full decoding. A middle
rewrite preserving both probes followed by an append can escape detection; see
[ADR-0012](adr/0012-use-checkpointed-incremental-rollout-loading.md).

Loaded archives remain cached until restart or restoration, including in-place
edits and permission changes. Discovery, removal, advisory metadata refresh, and
failed-load retries continue. Filesystem failures surface when operations run.

### Session identity

Native IDs and parent relationships are home-scoped. Duplicates retain the accepted readable rollout, or select the first fully
readable candidate in existing path order. Ignored duplicates have no publications/bindings/decode cache. Missing native IDs use path identity.
Shared services check native identity presence; adapters validate format (Codex
requires UUIDs).

### Adapter publication and diagnostics

Snapshots are immutable, including nested values; reused references mean unchanged
content, but equivalent fresh values are valid. Registration requires
independently unique, nonempty `instanceKey` and `home`, using server domain types.

HTTP path IDs are decoded once after segment splitting: nonempty, at most 1,024
UTF-8 bytes, without controls, slashes, backslashes, or standalone `.` / `..`.
Reads also validate item kind, ownership, and cursor bounds.

Diagnostics affect logs only, never responses, policy, or revisions. Default stderr
logging deduplicates by source/session/content, with per-source limits. Cleared
diagnostics may recur; vanished objects release logging state. Cache hits skip
diagnostics traversal, and logging failures do not interrupt operations.

`ENOENT`, `EACCES`, `EPERM`, `ESTALE`, `EISDIR`, `ENOTDIR`, and `ELOOP` skip and
diagnose unreadable portions. Missing scan roots are normal; unexpected errors
propagate. Successful snapshots have no completeness gate.

### Home identity and routing

Home nicknames route publicly; configured absolute paths namespace internally. Renaming/reordering homes preserves session IDs; moving a home changes them.
Projects merge by directory across homes; home paths remain private.

Creation defaults `home` to the first configured nickname. Unknown nicknames return `400`; reusing a request ID across homes returns
`409`. Operations use the selected/owning home's `CODEX_HOME` and the same local
`codex` executable. See [Multiple homes](usage.md#multiple-homes).

## Catalog

`GET /api/v1/sessions` returns `{ revision, homes, projects, sessions }` without
pagination or server filtering:

| Collection | Fields                                                                                  |
| ---------- | --------------------------------------------------------------------------------------- |
| `homes`    | `nickname`, including empty homes                                                       |
| `projects` | `directory`                                                                             |
| `sessions` | `id`, `home`, `title`, `projectDirectory`, `status`, `parentId`, `isChild`, `updatedAt` |

Reads/updates resolve titles from valid owning-Home `thread_name`, then original title. Missing directories yield
`projectDirectory: null`; `isChild` preserves declared parentage even without `parentId`.

Only `after` (43-character base64url revision) is accepted; invalid/extra queries return `400`.

| Condition                                   | Result                   |
| ------------------------------------------- | ------------------------ |
| No `after`, or different revision           | Immediate `200` snapshot |
| Matching revision changes within 25 seconds | `200` snapshot           |
| Unchanged after 25 seconds                  | Bodyless `204`           |
| Over 100 waiters                            | `429`, `Retry-After: 2`  |

Waiters share a 1.5-second probe, stopped when idle; disconnect/shutdown releases
them. Revisions cover homes, titles, projects, effective runtime status, and
relationships, excluding timestamps, content, statistics, and diagnostics.

Browser sorting uses best-effort `updatedAt`, retaining newer snapshot/reader
timestamps in memory. Projects follow their latest visible main session; IDs
break ties, invalid times sort last, and hidden pages pause requests.

Status is `normal | live | archived`: archive wins; Live requires an observed
living, owned pane. Normal does not authorize Resume. Runtime checks coalesce
concurrent observations and bound socket concurrency; errors revoke Live and resume.

## Reader and automatic updates

| GET endpoint                                   | Contract                                  |
| ---------------------------------------------- | ----------------------------------------- |
| `/api/v1/sessions/:id`                         | Session, interaction, update revision     |
| `/api/v1/sessions/:id/items`                   | Timeline page; optional `limit`, `cursor` |
| `/api/v1/sessions/:id/items/:itemId/directive` | Directive text; required `cursor`         |
| `/api/v1/sessions/:id/items/:itemId/tool`      | Tool input/output; required `cursor`      |
| `/api/v1/sessions/:id/items/:itemId/internal`  | Internal JSON; required `cursor`          |
| `/api/v1/sessions/:id/updates`                 | Long poll; required `cursor`, `after`     |

Pages return session metadata, items, `cursor`, `hasMore`, interaction, and
`updateRevision`. Only item reads advance cursors; lazy details must be within
the confirmed prefix. Changed prefixes/process restarts return `409 timeline_changed`;
malformed cursors return `400 invalid_query`. See [paging limits](session-jsonl-filtering.md#truncation-and-paging).

Updates validate cursors without advancing them or returning items; use item reads
for backlog. Probes run every 1.5 seconds, returning `204` after 25 unchanged seconds.
Capacity (100/process, 10/session) is reserved before initial reads, even for immediate
responses; overflow returns `429`, `Retry-After: 2`. Same-session requests share
in-flight initial reads and each probe's immutable state, interaction, and revision;
cursor/backlog decisions remain request-specific. Completed runtime observations
are not cached. Bad cursors/cancellations affect only their request; disconnect,
timeout, and shutdown release capacity even during unfinished reads.

Reader metadata includes `resume: { allowed, reason }` (null reason when allowed).
Public sessions/interaction determine reader revisions independently of catalog. Each response shares one pane observation;
effects revalidate ownership. Only the opened unarchived reader subscribes;
history paging preserves reading position during updates.

## Session CLI and observation

### CLI output contract

Business commands default to human-readable stdout; diagnostics use stderr.
`--json` emits one compact result or `{ "error": { "code", "message" } }` plus
newline; help stays text. Argument/validation/dispatch errors use `invalid_arguments`;
other resource failures use `command_failed`. Session connection errors use
`query_failed`; local validation fails before requests.

### Client behavior and results

`ahub-cli session` is a stateless HTTP client: no rollout reads, direct tmux
control, server discovery/startup, or persisted recovery state. `codex-hub` starts
the server; `ahub-cli page`/`diff` access local hosting storage via `--home-dir`.

URL precedence: `--url`, `CODEX_HUB_URL`, `http://127.0.0.1:4173`. HTTP and HTTPS
origins are accepted. HTTPS uses Node.js certificate verification. For a private CA, set
`NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem` before starting the CLI.

Except in [continuous inspection](#cli-continuous-inspection), one `--timeout`
deadline covers stdin, requests, operation polling, and readiness. The default is
15 seconds; create, resume, exit, archive, and delete use 45 seconds.

Lifecycle commands await [management](#asynchronous-management); create/resume
also inspect until live, connected, and idle. Input success does not prove task
completion or answer correctness.

| Exit code | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `0`       | Success                                                       |
| `1`       | Definite failure, including queries                           |
| `2`       | Submitted write may have taken effect but remains unconfirmed |

Interruptions, disconnects, deadlines, polling failures, and unknown results never
resubmit/cancel mutations. Query list/inspect/terminal to recover.
No CLI confirmation prompt is added; [execution rules](#execution-and-confirmation) apply.

### Public session CLI results

Text/JSON whitelists are independent of HTTP types; extra fields never pass through. Readiness uses API `live` and interaction before
mapping. Operation/request IDs and attach commands are excluded. Tmux diagnostics
include socketPath, paneId, and sessionName (null when unknown).

| Command/result    | Public fields                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`            | `{ sessions }`; entries: `id`, `title`, `status`, `home`, `projectDirectory`, `updatedAt`                                                     |
| `inspect`         | `{ session, interaction, items, nextAfter, hasMore }`                                                                                         |
| Inspect `session` | `id`, `title`, `status`, `home`, `agentName`, `workingDirectory`, `projectDirectory`, `createdAt`, `updatedAt`, `resume: { allowed, reason }` |
| `interaction`     | `{ supported: false, tmux: null }` or `{ supported: true, state, activity, supersededBySessionId, tmux }`                                     |
| `terminal`        | `{ content, truncated, capturedAt }`                                                                                                          |
| Input/handoff     | `{ sessionId, status: "sent" }`                                                                                                               |
| Lifecycle         | `{ sessionId, status: "succeeded" }`; create/resume also include `tmux`                                                                       |

CLI `create --project <directory> [--cwd <directory>]` resolves both paths
to absolute paths. `--project` sets association; `--cwd` selects the launch
location and defaults to the project. Resume accepts no directory overrides.

`list` excludes all `isChild` sessions, including orphans; `--project` filters the
associated directory, not launch/worktree location. Missing associations and
nullable metadata remain null. `home` is the origin nickname; inspect needs no
catalog request. Null activity displays as unknown. Explicit IDs, including child
IDs, go directly to endpoints without catalog checks or parent redirection.

Items expose messages and user input with `id`, `ordinal`, `timestamp`, `kind`.
Messages add `role`, `phase`, `itemType`, `markdown`; only assistant messages with
`phase=response` and `itemType=Plan` also include `inputHint`, preserving full
Markdown. User input adds `stage`: requests add `questions` (header, question,
and option labels/descriptions) and `inputHint`; responses add `outcome`:
`answered` adds `answers: string[]` in original question/answer order;
`unavailable` adds `summary`; `aborted` adds no fields.

Text preserves content/Markdown, flattening tabs/newlines only in summaries and
tables. Requests show question headers, full questions, numbered options with
descriptions, and a hint; answers show one selection per line; Plans append the
hint to their full text. See [output formatting](../src/server/cli/session-output.ts)
for labels and [ahub-control](../skills/ahub-control/SKILL.md#operation-state-machine)
for the input workflow.

### Inspect and numbered pagination

`GET /api/v1/sessions/:id/inspect?limit=N&after=number` returns
`session`, `live`, `interaction`, `items`, `nextAfter`, `hasMore`. Log/runtime
observations are not atomic; missing sessions return `404`, not empty history.

Visible item kinds match the CLI and browser defaults, including Plan markers.
Roles, normalized phases, item types, IDs, ordinals, and call IDs remain; unknown
phases stay unclassified. Raw ordinals may have gaps; requests/responses correlate
by `callId`. Tools/directives/token usage/internal events are excluded.

`limit` defaults to 10 (range 1–300). Without `after`, return latest N in original
order; older history does not set `hasMore`. With `after`, start at the earliest
visible ordinal beyond it (`0` starts history). The [item byte budget](session-jsonl-filtering.md#truncation-and-paging)
may reduce counts without further body truncation; one oversized record still returns.
Latest reads scan backward before budgeting; `after` binary-searches ordinals.
Neither maintains a persistent visibility index.

`nextAfter` is the consumed raw boundary: it can cross hidden records, never
unreturned visible items. `hasMore` means visible records remain beyond it. Empty
pages consume hidden tails and return current state. Rewrites are undetected;
out-of-range numbers fail rather than reset. Browser cursors are unaffected.

### CLI continuous inspection

`session inspect --follow` immediately reads the first page, drains pagination
sequentially, then waits `--interval` seconds (default 3) before the next round.
`--count` is a positive safe integer counting rounds, including empty rounds;
the final round drains every page. Both options require `--follow`. Without a
count observation continues until canceled, including while idle, disconnected,
or after an assistant response. Stopping observation does not stop the session.
Task completion is judged by the caller against requirements and deliverables.
Follow has no overall deadline; `--timeout` limits each HTTP request.

The first result always prints. Later results print only for visible new items
or changes to session/interaction fields. JSON output is NDJSON with the same
complete shape as single inspection and only that page's incremental items.
Text output uses fixed separators and marks state changes without new messages.
Position-only advances remain silent. Numeric `after / nextAfter` positions do
not guarantee history consistency. Pagination without forward progress fails
with exit code 1. API/network/request timeout errors end observation without
retrying; Ctrl+C cancels reads and timers and exits normally.

CLI inspection exposes `interaction.tmux: { socketPath, paneId, sessionName } | null`, using
the current observation and ownership checks. When sessionName is known, attach
with `tmux -S <socketPath> attach-session -t <sessionName>`, quoting each argument
for the shell. This attaches the containing session; it does not select a pane.

Launch success exposes `tmux`; launch errors include known `sessionId` and `tmux`
inside `error` (unknown values are null), retaining backend diagnostics and the
latest launch target even when waiting for idle times out.

## File uploads

| Endpoint                                                          | Contract                                       |
| ----------------------------------------------------------------- | ---------------------------------------------- |
| `POST /api/v1/uploads?sessionId=<Hub ID>&filename=<encoded name>` | Raw binary, ≤20 MiB; existing session required |
| `GET /api/v1/sessions/:id/uploads`                                | `{ items }`, newest first, unpaginated         |
| `GET /api/v1/sessions/:id/uploads/:attachmentId/content`          | Raster preview; `?download=1` downloads        |
| `DELETE /api/v1/sessions/:id/uploads/:attachmentId`               | Delete content/registration; idempotent        |

Upload returns `201`: `path`, `id`, `sessionId`, `filename`, `size`, `type`,
`uploadedAt`, also grouped as `attachment`. Unique paths prevent overwrites.
Oversize returns `413`, storage failures `500`; mutations reject cross-origin
access. Content/deletion are session-scoped. Non-preview types (including HTML/SVG)
download; all content uses `nosniff` and sandbox CSP.

Storage: `<home-dir>/uploads/<Hub session ID>/`, with atomic metadata rename and
absolute content paths. HTTP/storage validate session IDs and UUID-v4 attachment
IDs, matching metadata identity and direct content filenames/extensions. Reads,
deletion, and recovery reject corrupt metadata/symlink escapes using real locations.
Invalid IDs return `400`; missing attachments preserve not-found/idempotent-delete semantics.

Deletion tombstones metadata before removing content. Failed cleanup retries on
delete/startup; startup also cleans interrupted uploads without blocking service
or other uploads. Confirmed session deletion triggers background cleanup;
archive/exit and unconfirmed deletion retain files.

Per-session in-memory drafts abort uploads on navigation and revoke preview URLs
on removal/unmount. Sends prepend server paths (quoted when needed), one per line,
then a blank line and text; attachment-only sends contain paths only. Limits apply
to the complete message. Failure retains drafts; success clears only unchanged
drafts. Removing draft attachments retains files. See [usage](usage.md#file-uploads).

## Tmux interaction

| Endpoint                                         | Contract                                   |
| ------------------------------------------------ | ------------------------------------------ |
| `POST /api/v1/sessions/:id/messages`             | `{ message, requireIdle? }` → `204`        |
| `POST /api/v1/sessions/:id/keys`                 | `{ keys, requireIdle? }` → `204`           |
| `POST /api/v1/sessions/:id/handoff-pane-binding` | `{}` → `204`; later bind confirms handoff  |
| `GET /api/v1/sessions/:id/terminal`              | Fresh `{ content, capturedAt, truncated }` |
| `WS /api/v1/sessions/:id/terminal-preview`       | Snapshot/delta/error frames                |

[interaction.ts](../src/shared/interaction.ts) defines keys/message limits.
Supported responses include `state`, `activity`, `supersededBySessionId`,
`attachCommand`; unsupported responses contain `supported: false`, `attachCommand`.
States: `unbound`, `disconnected`, `connected`, `unknown`, `superseded`.

Effects require current-user socket ownership, pane liveness, binding ownership.
Concurrent checks coalesce without caching completed results. Missing sockets,
stopped servers, and dead/missing panes mean unavailable; permissions, timeouts,
and malformed responses mean unknown. Binding changes during awaits fail closed.
Queued input/previews revalidate ownership; uncertain input never resends.
Socket/pane reuse has no process-identity check.

CLI messages/ordinary keys set `requireIdle: true`, requiring idle at transaction
entry; ownership/management occupancy remain checked throughout. Non-idle input
fails without waiting/retry; browser calls omit this restriction. Ordinary keys
use the non-interrupt whitelist. Interrupt permits working; handoff sends the
adapter binding command without requiring idle. Both retain other checks;
handoff success means sent, not confirmed binding.

### Binding format and ownership

Codex reads five-line `AHUB_TMUX_BIND_V1` records from user-message
`<user_shell_command>` output: marker, absolute socket path, numeric `%` pane ID,
optional operation UUID, optional project directory (empty fields retain lines).
An invalid latest attempt never falls back.

A process-wide manager tracks latest attempts/session and valid claims/socket/pane
across homes, ordered by timestamp (invalid = zero), global session ID, ordinal,
position, including appends. New claims retain claims
on other panes. Takeover makes former owners `superseded`, revoking effects and
attach. `supersededBySessionId` names a readable replacement (including archived),
otherwise null. Claims survive archive, deletion, rereads, and Hub close for the
process lifetime; later explicit binds can reclaim them. See [binding manager](../src/server/interaction/pane-binding-manager.ts).

### Project directory

Latest valid bind overrides Working Directory: absolute project path without
NUL/CR/LF; no filesystem/Git checks. Invalid/empty fields preserve earlier project
paths and do not invalidate pane bindings.

### Activity observation

Activity is null unless connected. Output within five monotonic seconds means
`working`, otherwise `idle`; initial/failed observations mean `unknown`.
`%output`/`%extended-output` subscriptions retry on the next read. Reader/interaction
reads renew a 30-minute lease. Activity shares preview control clients without
capturing frames. Transitions affect reader revisions, repeated working output
does not; catalog excludes activity.

### Terminal Preview

Preview is plain-text current screen, without scrollback/emulation. It retains
the last 256,000 UTF-8 bytes at character boundaries, marking removed prefixes
`truncated`. HTTP captures once without listeners/cached WebSocket content; both
transports share binding checks and capture limits.

WebSocket inherits TLS/mTLS, rejects queries/cross-origin browser requests, and
accepts no application messages. Ordinary HTTP returns `426`.

| Frame `type` | Fields                                                              |
| ------------ | ------------------------------------------------------------------- |
| `snapshot`   | `revision`, `content`, `truncated`, `capturedAt`                    |
| `delta`      | `baseRevision`, `revision`, `operations`, `truncated`, `capturedAt` |
| `error`      | `code`, `message`, `retryable`                                      |

Connections start with snapshots. Delta operations (`startLine`, `deleteCount`,
`lines`) use preceding-frame indices in descending, nonoverlapping order.
Split/join on `"\n"` preserves blank/trailing lines; truncation-only changes may
have no operations. Oversized, expensive, or non-smaller deltas become snapshots.
Invalid frames require reconnect without clearing display. Errors close with `1013`
if retryable, otherwise `1008`.

Shared listeners/captures never resize/change terminal environments. Output merges
over 350 ms; only content/truncation changes publish. Capacity is 100/process,
10/session including initialization; overflow returns retryable
`preview_capacity_exceeded`. Identical valid binds preserve subscriptions;
ownership loss, invalid binds, changed targets, or listener failure close them
permanently, even if ownership returns.

Browser connects while expanded, connected, visible. Retryable errors
back off; terminal errors await lifecycle change/explicit retry. Failures retain
the last frame and notice. Dismissing details does not reconnect; retry cancels
backoff. See [service](../src/server/interaction/terminal-preview-service.ts) and
[transport](../src/server/http/terminal-preview-websocket.ts).

## Asynchronous management

| Endpoint                              | Body / result                                                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/sessions`               | New: `{ home?, projectDirectory, workingDirectory?, worktree, yolo?, requestId }`; resume: `{ resumeSessionId, yolo?, requestId }` → `202` operation |
| `POST /api/v1/sessions/:id/exit`      | `{}` → `202` operation                                                                                                                               |
| `POST /api/v1/sessions/:id/archive`   | `{}` → `202` operation                                                                                                                               |
| `DELETE /api/v1/sessions/:id`         | `{}` → `202` operation                                                                                                                               |
| `GET /api/v1/operations/:operationId` | Current operation                                                                                                                                    |

Creation requires `projectDirectory`; optional `workingDirectory` defaults to it.
The adapter validates both as absolute existing local directories and resolves
symlinks, without checking Git relationships. The working directory controls
process launch; the project directory controls binding and association checks.
Idempotency includes both directories and launch options; omitted working
directory equals an explicit project directory. `worktree` remains an independent
agent launch option.

### Service responsibilities

The [coordinator](../src/server/management/operation-service.ts) owns idempotency,
occupancy, deadlines, results, retention/cleanup. [Launch](../src/server/management/session-launch-executor.ts)
and [lifecycle](../src/server/management/session-lifecycle-executor.ts) executors
validate, run adapter effects, confirm, and check operation activity after awaits;
shutdown reuses the exit service.

### Operation model

Operations include `operationId`, `type`, `status`, `createdAt`, `updatedAt`,
nullable `sessionId`, `error`, `phase`, `attachCommand`, optional
`target: { socketPath, paneId, sessionName }`, and launch `mode: new | resume`.
Types: `create`, `exit`, `archive`, `delete`; statuses: `pending`, `succeeded`,
`failed`, `unknown`. Exit phases are `sending_exit`, `waiting_exit`; archive adds
`archiving`, `confirming_archive`.

### Idempotency and conflicts

Request IDs: 8–128 letters/digits/underscores/hyphens. Identical launch IDs/arguments
coalesce through execution and 30-minute terminal retention; changed arguments
return `409`. Different IDs permit concurrent project creation. Resume/lifecycle
share session occupancy: identical lifecycle operations coalesce, conflicts return
`409` without queuing. Different IDs cannot concurrently resume one session.

### Execution and confirmation

Create/resume share launch; worktree/YOLO are options. Resume occupies the session,
refreshes source once, records a binding baseline, and evaluates runtime once,
reusing its directory. Prelaunch checks binding/operation validity without another
external-change scan or filesystem/tmux atomicity. Native commands use owning
`CODEX_HOME`; Hub never moves/deletes rollouts directly.

| Operation | Validation and confirmation                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create    | Project and effective working directories independently resolve to existing real paths; equal inputs share resolution. Confirm operation marker, target, project, valid bind within 300 seconds after launch.                  |
| Resume    | Require unarchived unique valid native identity, plus no binding, confirmed pane death, or explicit transfer. Invalid/uncertain bindings deny resume. Confirm original identity, marker, project, live owned target.           |
| Exit      | Validate latest bind; interrupt/EOF then force-close entire pane if needed. Confirm dead/missing within 30 seconds; query errors/ownership changes mean `unknown`. Unbound succeeds, missing fails; archived uses same checks. |
| Archive   | Refresh source; already archived succeeds. Validate unique native identity, exit, run native archive once (25-second command limit), confirm within 30 seconds.                                                                |
| Delete    | Require archive, native delete, confirm same-source native identity absent within 30 seconds. Initially absent in successful snapshot succeeds.                                                                                |

Codex launches `ahub-<operationId>` with `--no-daemon --no-alt-screen`, optional
`--worktree`/`--yolo` (off by default), and initial binding instruction. Resume uses
`codex resume <UUID>`, trying Working then Project Directory: skip invalid paths,
fall back only on missing/non-directory paths. Launch from chosen real path,
retain original project association; reject home/projectDirectory/workingDirectory/worktree overrides.
Users must ensure unbound sessions' original processes have exited.

Attach appears after 30 seconds and survives timeout, using known target or
configured socket/deterministic session name. Confirmed no-launch tmux errors
mean `failed`; launch timeout, malformed success, and post-launch errors mean
`unknown`, without retry/teardown.

Exit controls the whole pane, including manual binds, retaining session data;
see [ADR-0022](adr/0022-separate-session-exit-from-archive.md). Occupancy blocks
ordinary input/handoff with `409 session_busy`; archive holds it through confirmation.
Successful snapshots can skip unreadable data and confirm absence; thrown reads cannot.

### Tracking and recovery

Tracking continues without clients. Timeout produces `unknown` without undoing
commands. Immutable terminal results release execution/occupancy and retain launch
deduplication for 30 minutes. Hung observations cannot block cleanup; late
continuations check activity. Restart loses tracking, leaving tmux running.
Unknown launches retain target/attach; same request ID retrieves retained results.
A new ID can launch after normal checks even if the earlier launch still runs.

Browser polls one second after query completion; hidden pages pause, stored IDs
support reload recovery. Terminal/`404` results clear
markers; nonretryable query errors require manual retry. Launch network retries
reuse request IDs until terminal results. Submitted writes continue while hidden.

## Optional hosting

Adapter-independent hosting requires `--hosting`.
`GET /api/v1/capabilities` returns `{ hosting: boolean }`; disabled hosting creates
no storage and returns `404`. Offline commands use `--home-dir`
and `--json`; existing HTTPS/mTLS/proxy authentication applies, without added login.

Malformed URLs/encodings return `400`, missing resources `404`, unexpected storage,
metadata, or deletion errors `500 internal_error` with `requestId`. Logs correlate
method/path/error without bodies; post-header errors terminate responses. Damaged entries remain skipped.

Publish/delete share an atomic-rename filesystem lock. Reclaim requires OS-confirmed
PID absence; tombstones protect new locks, live PID reuse blocks recovery.
Avoid manual storage changes while publishing.

### Web pages

`GET /api/v1/artifacts` rescans projects (`directory`, `artifacts`);
`DELETE /api/v1/artifacts/:id` removes all snapshots. Invalid metadata is diagnosed
and skipped; resources do not depend on homes/sessions.

Canonical project `realpath` plus name determines identity. Republishing retains
history/title unless overridden; moving projects changes association. Random
32-character lowercase hex IDs identify artifacts/snapshots. Storage:
`<hosting>/artifacts/<id>/artifact.json` and `snapshots/<snapshot-id>/`. Metadata
contains identity, title, project/source, current snapshot, timestamps, relative
URL, without session/server identity.

Publication accepts regular files/directories, canonicalizes source root, rejects
nested symlinks, special files, and hosting overlap. Snapshot rename precedes atomic
metadata replacement, preserving prior metadata on failure. Snapshots persist until
artifact deletion, including inert interrupted/unreferenced snapshots; no expiry/history management.

`/web/:id/` redirects (`302`) to `/web/:id/:snapshotId/`. GET/HEAD serve files and
directory `index.html`: no listing, traversal, metadata access, or SPA fallback.
Disk metadata makes offline changes visible. Responses use `private, no-store`;
entry/directory redirects preserve queries. Use relative assets; root-relative
paths are not rewritten. External resources require connectivity/provider permission.

Pages execute trusted same-origin code with Hub authority, omitting Hub UI's
restrictive CSP to support scripts/styles/modules/fonts/JSON/external HTTPS.
Hub CSP remains unchanged. Session Markdown accepts canonical `/web/<id>/` links;
copied links use browser origin.

### Temporary diffs

Each `diff publish <file>` creates UUID-v4 `<hosting>/diffs/<uuid>/` with original
`raw.diff` and `metadata.json` (identity, title, creation time, URL). Directory
publication uses atomic rename under the shared write lock. CLI list reads metadata;
delete is idempotent. Explicit cleanup preserves source; no project/session association.

`/diffs/<uuid>` serves the viewer; `GET /api/v1/diffs/:uuid` returns metadata/`raw`;
`DELETE` returns `204`. Missing/disabled returns `404`; no HTTP list exists.
Responses: `private, no-store`, Hub CSP, text rendering; Markdown links open new tabs. Viewer supports Git unified diffs,
renames, mode changes, binary markers, C-quoted paths; unsupported/incomplete input
warns and retains original text access.

## Browser state

`ahub.preferences.v1` localStorage synchronizes same-origin preferences;
`ahub.browser-state.v1` sessionStorage holds tab-local browsing. Recovery/drafts
have independent lifecycles; storage failures preserve in-memory behavior.

## Interface localization

`ahub.preferences.v1.language` selects `en` (default), `zh-CN`, `zh-TW` (Taiwan).
Missing/malformed/unsupported values use English. Changes apply without reload,
synchronize across tabs, and preserve existing launch/theme preferences. Locale affects presentation, preserving API values, identities, conversation/terminal
text, paths, commands. Dates use device time zone; documentation captures use UTC.

`src/client/i18n/` owns catalogs, metadata, keys, interpolation, namespaces/formatters. English defines keys/parameters; Chinese entries must match.
Namespaces: `common`, `hub`, `reader`, `interaction`, `hosting`, `errors`, `settings`.
Missing/empty translations fall back to English. New languages require catalog,
`languageOptions`/initialization registration, validation tests. No runtime fetch
or browser-language detection.

Notifications retain keys until rendering; native diagnostics remain verbatim
beside localized explanations. Structured API errors use codes, never English
message matching. Translation preserves HTTP/WebSocket contracts. Preference
changes must not restart operations, remount drafts, or reload requested details.

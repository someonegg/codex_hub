# Technical reference

Current API and runtime contracts. See [Usage](usage.md) for setup,
[JSONL filtering](session-jsonl-filtering.md) for record processing, and
[ADRs](adr/README.md) for decision history. Response types live in
[api-contract.ts](../src/shared/api-contract.ts); IDs, cursors, and revisions are
opaque values that clients must return unchanged.

- [Sources and identity](#sources-and-identity)
- [Catalog](#catalog)
- [Reader and automatic updates](#reader-and-automatic-updates)
- [Session CLI and observation](#session-cli-and-observation)
- [File uploads](#file-uploads)
- [Tmux interaction](#tmux-interaction) and [Terminal Preview](#terminal-preview)
- [Asynchronous management](#asynchronous-management)
- [Optional hosting](#optional-hosting): [pages](#web-pages) and [diffs](#temporary-diffs)

## Sources and identity

### Discovery and caching

Codex discovery reads `rollout-*.jsonl` under `sessions/` and `archived_sessions/`.
`session_index.jsonl` supplies advisory names; Codex databases are not read.
The configured home is a trusted local data source. Discovery follows root, directory,
and file symlinks, including targets outside the home. Each root is depth 0; files
in directories through depth 8 are read, and depth 9 is not entered. There is no
cycle detection or real-path deduplication; the depth limit bounds directory cycles.
Descriptors, ordering, and fallback path IDs use logical absolute paths rather
than canonical targets; cache keys remain source-relative logical paths.

Unchanged unarchived rollouts reuse cached content by size and modification time,
without probing read permissions. Changes to permissions alone do not invalidate
cached content; actual metadata, traversal, open and read failures are recovered
when those operations run. Unarchived rollouts use in-memory checkpoints. A growing
file reuses its decoded prefix only when decoder/normalizer versions and SHA-256 probes match. Probes
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

Shared services treat native IDs as opaque strings and check identity presence.
Format validation belongs to the adapter; Codex requires UUIDs. Parent
relationships never cross homes.

### Adapter publication and diagnostics

Adapters publish immutable snapshots, including nested timeline and detail values.
Reference reuse is optional and means unchanged content; equivalent fresh values
are valid. Registration requires nonempty, independently unique `instanceKey` and
`home`. Adapters use server domain types.

HTTP path IDs are decoded once after segment splitting. They must be nonempty,
at most 1,024 UTF-8 bytes, and contain no controls, slashes, backslashes, or
standalone `.` / `..`. Reads also validate item kind, ownership, and cursor bounds.

Diagnostics stay in server logs, outside public responses, management policy, and
revisions. Logging defaults to stderr and deduplicates by source, session, and
content; cleared diagnostics may recur and vanished objects release logging state.
Per-source limits prevent one source from hiding another's diagnostics. Unchanged
cache hits do not traverse diagnostics; logging failures do not stop operations.

`ENOENT`, `EACCES`, `EPERM`, `ESTALE`, `EISDIR`, and `ENOTDIR` cause unreadable
portions to be skipped and diagnosed (`ELOOP` is also recoverable). Absent scan roots
are normal; unexpected exceptions propagate.
Successful snapshots have no completeness gate.

### Home identity and routing

Home nicknames identify configured homes in public responses and operation routing.
Internal session and timeline namespaces follow the configured absolute path.
Renaming or reordering homes preserves session IDs; moving a home changes them.
Projects merge by directory across homes. Home paths remain private.

Creation accepts an optional Home nickname in `home`; omission selects the first
configured home. An unknown nickname returns `400` without fallback. Reusing a
request ID for another home returns `409`. Launch and lifecycle operations use
the selected or owning home and its `CODEX_HOME`, with the same local `codex` executable. See [Multiple homes](usage.md#multiple-homes).

## Catalog

`GET /api/v1/sessions` returns the complete `{ revision, homes, projects, sessions }`
snapshot. There is no pagination or server-side filtering.

| Collection | Fields                                                                           |
| ---------- | -------------------------------------------------------------------------------- |
| `homes`    | `nickname`; includes empty homes                                                 |
| `projects` | `id`, `directory`                                                                |
| `sessions` | `id`, `home`, `title`, `projectId`, `status`, `parentId`, `isChild`, `updatedAt` |

Public session titles use the valid `thread_name` from the owning Home's session
index, falling back to the original session title. Lists, details, inspect, and
updates expose this resolved `title`.

Missing directories yield `projectId: null`. `isChild` records a declared parent
even when `parentId` cannot resolve.

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
effective runtime status, and relationships. Timestamps, content, statistics, and
diagnostics do not wake catalog requests.

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
Capacity is reserved before the first read, including requests that could return
immediately. Requests for one session share each state read, interaction assembly
and revision calculation; cursor validation and backlog decisions use that same
immutable snapshot independently for each request. Only in-flight initial reads
are shared; completed runtime observations are not cached. A bad cursor or
cancellation affects only its request. Disconnect, timeout and shutdown release
capacity, including during an unfinished initial read.

Reader metadata exposes `resume: { allowed, reason }`, with null `reason` when
allowed. The full public session, including resolved title and `updatedAt`, and
effective interaction state affect reader revisions independently of catalog
revisions. Each response shares one pane observation for
runtime and interaction; effects validate ownership again at execution time.
Only the opened, unarchived session subscribes. History paging coexists with
updates while preserving reading position.

## Session CLI and observation

### CLI output contract

All `ahub-cli` business commands default to human-readable stdout; diagnostics go to stderr. `--json` emits one compact JSON result or `{ "error": { "code": "...", "message": "..." } }` on stdout, followed by a newline. Help is always text.

Resource and dispatch failures exit with code 1; `invalid_arguments` identifies argument parsing, validation, and dispatch errors, and `command_failed` identifies other resource failures.

### Client behavior and results

The stateless `ahub-cli session` command is a Node HTTP client of an existing hub.
It does not read rollout files, control tmux directly, start or discover servers,
or persist sessions, cursors, or recovery records.

`codex-hub` starts the server. `ahub-cli page` and `ahub-cli diff` manage local
hosting storage directly, using `--home-dir` to select the Hub data root.

URL precedence is `--url`, `CODEX_HUB_URL`, then `http://127.0.0.1:4173`. Only HTTP
origins are accepted; the client's HTTPS restriction does not change server TLS
support. One invocation deadline (`--timeout`, seconds, default 360) covers stdin,
requests, operation polling, and launch readiness.

Lifecycle commands wait internally for the existing [management operation](#asynchronous-management).
Create and resume then poll inspect until live, connected, and idle. Output maps
public results without operation/request IDs, tmux targets, or operation attach
commands. JSON mode emits a structured result or error; human errors go to stderr.
No input success asserts task completion or answer correctness. List filtering
uses project association, not launch or worktree directories.

| Exit code | Meaning                                                         |
| --------- | --------------------------------------------------------------- |
| `0`       | Success                                                         |
| `1`       | Definite failure, including failed queries                      |
| `2`       | A submitted write may have taken effect but cannot be confirmed |

Disconnects, interruption, deadlines, failed operation polling, and explicit
unknown backend results never cause mutation resubmission or backend cancellation.
Users can issue list, inspect, or terminal queries to assess actual state. The CLI
adds no confirmation prompt; exit, archive, and delete retain the existing
[validation and confirmation rules](#execution-and-confirmation).

### Public session CLI results

Session CLI types are independent of HTTP API types. Both text and JSON are
produced from explicit field-whitelist mappings; extra server properties are
never passed through. Launch readiness still uses the original API `live` and
interaction state, before public output mapping.

Argument parsing and local validation return `invalid_arguments` before any request;
connection failures remain `query_failed`.

- `list`: `{ sessions }`, excluding every `isChild` session, including orphans.
  Each entry contains only `id`, `title`, `status`, `home`, `projectDirectory`,
  and `updatedAt`. `home` is the configured Home nickname. `projectDirectory`
  resolves the associated project directory; missing project associations become null.
  `--project` filters by this directory. Association tables, keys and hierarchy
  are omitted.
- `inspect`: `{ session, interaction, items, nextAfter, hasMore }`.
  `session` contains only `id`, `title`, `status`, `home`,
  `agentName`, `workingDirectory`, `projectDirectory`, `createdAt`,
  `updatedAt`, and `resume: { allowed, reason }`. Nullable metadata remains null.
  `home` comes directly from the session origin nickname, without a catalog
  request. Native IDs, hierarchy, agent identity details, versions and counts
  are omitted.
- `interaction`: `{ supported: false }` or
  `{ supported: true, state, activity, supersededBySessionId }`. No attach command
  is exposed. Null activity is rendered as `unknown`, never idle.
- `items`: only message and structured user-input records. All contain `id`,
  `ordinal`, `timestamp`, and `kind`. Messages contain `role`, `phase`, `itemType`,
  and `markdown`. User input contains `stage` and `callId`: requests include
  `questions: [{ id, header, question, options: [{ label, description }] }]`;
  answered responses include `outcome: "answered"` and
  `answers: [{ questionId, answers: string[] }]`; aborted responses contain
  `outcome: "aborted"`; unavailable responses contain `outcome: "unavailable"`
  and `summary`. Other record kinds and additional nested properties are omitted.
- `terminal`: `{ content, truncated, capturedAt }`.
- Input and handoff results: `{ sessionId, status: "sent" }`. Lifecycle results:
  `{ sessionId, status: "succeeded" }`.

Explicit IDs go straight to the normal server endpoint, including child IDs;
there is no catalog preflight, child check or parent redirection.

Inspect text has a labeled session summary, numbered history blocks, then
`Next after` and `Has more: yes|no`. English labels leave user content in its
original language. Summary and table fields replace newlines and tabs with
spaces; message Markdown and line breaks are preserved. Questions show each
prompt and numbered options. Answers match headers by `callId` and question ID
within the page, falling back to question IDs. Cancelled and unavailable outcomes
are explicit, including the unavailable explanation. Empty history reads
`No visible items.`; unsupported interaction reads `Interaction: unsupported`.
List retains its table; terminal and operation confirmations remain concise.

### Inspect and numbered pagination

`GET /api/v1/sessions/:id/inspect?limit=N&after=number` uses the existing source
snapshot and runtime state assembly. It returns `session`, `live`, `interaction`,
`items`, `latestNumber`, `nextAfter`, and `hasMore`. Interaction follows the existing
[connection and activity contracts](#tmux-interaction). Log and runtime observations
are not atomic. A missing session returns `404`, distinct from an empty page.

Visible items match the browser default: messages and structured user input
requests/responses, including Plan markers, question options, answers, aborted
and unavailable outcomes. Roles, normalized phases, item types, IDs, ordinals,
and call IDs are preserved; unknown phases remain unclassified. Tools,
directives, token usage, and internal events are excluded. Ordinals are original
record numbers with possible gaps, not turn numbers. Requests and responses remain
separate and correlate through `callId`.

Limit defaults to 10 and accepts 1–300 visible records, returned in original order.
Without `after`, the page starts at the latest N; older history does not set
`hasMore`. With `after`, it starts at the earliest visible record beyond that
number; `after=0` starts at the beginning. The existing [item-page byte budget](session-jsonl-filtering.md#truncation-and-paging)
can yield fewer records without additional body truncation.

| Field          | Meaning                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------- |
| `latestNumber` | Latest visible ordinal, or null                                                               |
| `nextAfter`    | Consumed raw timeline boundary; may cross hidden records but never an unreturned visible item |
| `hasMore`      | Visible records remain after that boundary                                                    |

An empty page still advances through hidden tail records and supplies current
state. Numbers refer to the current timeline: rewrites are not detected, and
numbers beyond its raw range fail rather than reset. The browser cursor API is
unchanged.

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
Metadata commits use atomic rename and record absolute content paths. HTTP and
storage entry points validate public session IDs; attachment IDs are UUID v4.
Metadata identities must match the request, and content must be a direct file in
that session directory with the generated attachment ID and supported extension.
Reads, deletion and deletion recovery validate real locations and reject symlink
escapes or corrupt metadata. Invalid request IDs return `400`; missing attachments
retain their normal not-found/idempotent-delete behavior.

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
| `POST /api/v1/sessions/:id/messages`             | `{ message, requireIdle? }` → `204`                   |
| `POST /api/v1/sessions/:id/keys`                 | `{ keys, requireIdle? }` → `204`                      |
| `POST /api/v1/sessions/:id/handoff-pane-binding` | `{}` → `204`; a later binding record confirms handoff |
| `GET /api/v1/sessions/:id/terminal`              | Fresh `{ content, capturedAt, truncated }` screen     |
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

Message and key POST bodies accept optional boolean `requireIdle`. The CLI sends
true for messages and ordinary keys: the server requires idle at input transaction
entry, while checking binding ownership and management occupancy throughout.
Non-idle input is refused without waiting for idle or automatic retry; browser
calls omit this condition. Ordinary CLI keys use the existing non-interrupt
whitelist. `interrupt` uses the interrupt capability and permits working;
`handoff` sends the adapter's binding command without an idle restriction. Both
retain connection, ownership, and occupancy checks. Handoff success means sent,
not that a new binding has been confirmed.

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
Reader and interaction reads renew a 30-minute lease. Activity shares control
clients with preview without capturing frames. Transitions affect reader revisions;
repeated output while already working does not. Catalog omits activity.

### Terminal Preview

Preview is the current screen as plain text, not scrollback or terminal emulation.
It retains the last 256,000 UTF-8 bytes without splitting a character and marks
removed prefixes as `truncated`.

The HTTP terminal endpoint captures a fresh screen once and ends without a
listener or cached WebSocket content. HTTP and WebSocket share binding resolution,
ownership checks, capture limits, and truncation.

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

| Endpoint                              | Body / result                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/sessions`               | New: `{ home?, directory, worktree, yolo?, requestId }`; resume: `{ resumeSessionId, yolo?, requestId }` → `202` operation |
| `POST /api/v1/sessions/:id/exit`      | `{}` → `202` operation                                                                                                     |
| `POST /api/v1/sessions/:id/archive`   | `{}` → `202` operation                                                                                                     |
| `DELETE /api/v1/sessions/:id`         | `{}` → `202` operation                                                                                                     |
| `GET /api/v1/operations/:operationId` | Current operation                                                                                                          |

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
Resume occupies the session, refreshes the source once, records the binding baseline,
and runs one complete runtime evaluation, reusing its resolved directory. Before
launch it checks that the binding and operation remain valid. It does not scan again
to detect external changes or guarantee atomicity between the filesystem and tmux.
Native commands use the owning `CODEX_HOME`; the Hub never moves or deletes rollout
files directly.

| Operation | Validation and confirmation                                                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create    | Resolve an existing directory to its real path for launch and project association, including worktrees. Match operation marker, launch target, project, and valid binding within 300 seconds after launch.                                                                           |
| Resume    | Require an unarchived, unique valid native identity and no binding, confirmed pane death, or explicit transfer. Invalid bindings and uncertain checks deny resume. Validate once before launch; confirm original identity, operation marker, project, and live owned target.         |
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
Malformed URLs or path encodings return `400`; missing resources return `404`.
Unexpected storage, metadata, or deletion failures return `500` with a generic
`internal_error` and `requestId`. Server logs correlate that ID with the method,
path and original error, without request bodies. Errors after headers are sent
(including file stream failures) are logged and terminate the response.
Damaged artifact entries retain their existing skip policy.
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

The browser preference `ahub.preferences.v1.language` selects `en` (default),
`zh-CN` (Simplified Chinese), or `zh-TW` (Traditional Chinese, Taiwan). Missing, malformed, and unsupported stored values fall back to English;
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

# Technical reference

See [Usage](usage.md), [JSONL processing](session-jsonl-filtering.md),
[ADRs](adr/README.md), and [response types](../src/shared/api-contract.ts).
Treat IDs and revisions as opaque strings. Message positions are nonnegative
ordinal numbers; pass each returned `nextAfter` as the next request’s `after`.

- [Sources and identity](#sources-and-identity)
- [Conversation model](#conversation-model)
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

Codex scans `rollout-*.jsonl` under `sessions/` and `archived_sessions/`;
`session_index.jsonl` supplies advisory titles. Claude scans
`projects/<project>/<UUID>.jsonl`. Codex follows trusted-home symlinks through
depth 8 (root = 0), without cycle detection or real-path deduplication.
Logical paths determine discovery order, fallback identity, and cache keys.

Both adapters cache by source-relative path, size, and `mtimeMs`. Changes that
preserve these fields, including permission-only changes, do not trigger reads.
Growing files reuse decoded prefixes when SHA-256 probes match the first 4 KiB
and up to 4 KiB before the previous EOF. A single open handle reads to observed
EOF, resuming after the last committed newline. Restart, truncation, detected
same-size changes, or probe mismatch require full decoding.

Checkpoints are process-local. A middle rewrite preserving both probes followed
by an append can escape detection; see [ADR-0012](adr/0012-use-checkpointed-incremental-rollout-loading.md).
Loaded archives remain cached until restart or restoration, even after in-place
edits. Discovery, removal, advisory metadata refresh, and failed-load retries continue.

### Session identity

Native IDs and parent relationships are home-scoped. Shared services check native
ID presence; format validation belongs to the owning adapter (both current adapters
require UUIDs). Missing native IDs use path identity.

Duplicates retain the accepted readable rollout, otherwise the first fully
readable candidate in logical path order. Codex retains only fingerprints and
native IDs for confirmed duplicates, skipping unchanged candidates while the
winner remains valid. Claude identifies candidates by filename before decoding.
Changed candidates and replacements are reloaded; missing paths leave the caches.

### Adapter publication and diagnostics

Adapters publish deeply immutable snapshots. Reused references indicate unchanged
content; an unchanged source signature returns the same snapshot object.
Binding events come from the current decoded batch; project/task metadata
accumulates. Public origins expose `agentVersion`, omitting `formatVersion`.
Registration requires independently unique, nonempty `instanceKey` and `home`.
See [adapter domain types](../src/server/domain/session-domain.ts).

Diagnostics affect logs only, never responses, policy, or revisions. Default
logging deduplicates and limits reports; logging failures do not interrupt work.
Cache hits skip diagnostics traversal. Refresh telemetry is internal, with no HTTP API.

`ENOENT`, `EACCES`, `EPERM`, `ESTALE`, `EISDIR`, `ENOTDIR`, and `ELOOP` skip and
diagnose unreadable portions. Missing scan roots are normal; unexpected errors
propagate. A successful snapshot does not guarantee complete filesystem coverage.

Session API path IDs use the opaque Hub ID syntax (`[A-Za-z0-9_-]{20,100}`),
not native session IDs. Message reads also validate ordinal bounds. See
[path validation](../src/server/http/session-path.ts).

### Home identity and routing

Home nicknames route publicly; configured absolute paths namespace internally. Renaming/reordering homes preserves session IDs; moving a home changes them.
Projects merge by directory across homes; home paths remain private.

Creation defaults `home` to the first configured nickname. Unknown nicknames return `400`; reusing a request ID across homes returns
`409`. Operations use the selected/owning adapter's local CLI and home environment
(`CODEX_HOME` for Codex, `CLAUDE_CONFIG_DIR` for Claude). See [Multiple homes](usage.md#multiple-homes).

### Claude Code adapter

Claude supports main-session reading, tmux interaction, create/resume, exit, and
delete, with worktree/YOLO launch options. Archive and subagent reading are
unavailable; native shell commands/output are excluded from conversations. Reading
does not modify native history or depend on Codex internals. Filtering and limits
are defined in [JSONL processing](session-jsonl-filtering.md#claude-code).

Before launching, configure and authenticate the local `claude` CLI for the home.
Launch sets `CLAUDE_CONFIG_DIR` and runs interactive `claude`, with
`--resume <UUID>`, `--worktree`, or `--dangerously-skip-permissions` as applicable.
The adapter waits up to 15 seconds for the native prompt, then pastes the complete
`! printf ...` binding command once, even if no prompt was detected. Binding uses
shell expansion without tmux queries to accommodate worktree isolation checks.

A CLI prompt starting with `!` is ordinary model input; this behavior was verified
against Claude Code 2.1.318 and needs rechecking after upgrades. Claude records the
binding. Create/resume interrupts once after binding confirmation; handoff does not.
A running process alone cannot confirm launch: management verifies the operation
marker, ownership, project, and original identity on resume. Capture, delivery, or
interrupt failures retain the target/attach command with an unknown result.

Interrupt sends Ctrl-U, waits 100 ms, then Escape. Exit sends Ctrl-C three times
at one-second intervals, then follows the [shared exit sequence](#execution-and-confirmation).
See [adapter implementation](../src/server/adapters/claude/session-manager.ts).

## Conversation model

An adapter publishes an immutable `NormalizedSession`: session metadata, an ordered
`timeline`, and optional interaction configuration. Session metadata includes source
identity, directories, task association, parent/child relationships, archive state,
and log diagnostics. The API maps metadata into `SessionSummary` and `SessionDetail`,
combining archive facts with observed runtime status and resume availability.

Adapter publications and HTTP reads share `TimelineItem`. Every item has `id`,
`ordinal`, and `timestamp`, plus fields determined by `kind`:

- `message`: `role` (`user | assistant`), `phase` (`update | response | null`),
  `itemType` (`plan | null`), and `markdown`.
- `user_input`: `callId` and `stage`.
  Requests contain questions with IDs, headers, text, and options. Responses contain
  an `outcome`: `answered` with question-scoped answers, `aborted`, or `unavailable`
  with a summary.

Plans are assistant response messages with `itemType: plan`. The browser combines
loaded input requests and responses by `callId` into cards. See
[domain types](../src/shared/domain.ts) and [JSONL processing](session-jsonl-filtering.md).

## Catalog

`GET /api/v1/sessions` returns a complete catalog snapshot:
`{ revision, homes, projects, sessions }`. Clients filter and group sessions locally.

| Collection | Fields                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| `homes`    | `nickname` and `management: { archive }`, including empty homes                                              |
| `projects` | `directory`                                                                                                  |
| `sessions` | `id`, `home`, `title`, `projectDirectory`, optional `taskName`, `status`, `parentId`, `isChild`, `updatedAt` |

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
them. Revisions cover homes, titles, projects, task associations, effective runtime status,
and relationships. Timestamps, conversation content, and diagnostics are excluded.

Browser sorting uses best-effort `updatedAt`, retaining newer snapshot/reader
timestamps in memory. Projects follow their latest visible main session; IDs
break ties, invalid times sort last, and hidden pages pause requests.

Status is `normal | live | archived`: archive wins; Live requires an observed
living, owned tmux session. Normal does not authorize Resume. Runtime checks coalesce
concurrent observations and bound socket concurrency; errors revoke Live and resume.

## Reader and automatic updates

`GET /api/v1/sessions/:id/messages` is the single conversation read endpoint.
Queries: `after` (nonnegative ordinal), `limit` (1–300, default 10), `wait`
(boolean, default false), and optional `stateRevision` (43-character base64url).
It returns `session`, `interaction`, `items`, `nextAfter`, `hasMore`, and
`stateRevision`. `GET /api/v1/sessions/:id` returns
`{ session, interaction, stateRevision }` and accepts no query parameters.

Without `after`, reads return the latest messages in original order.
Ordinals retain adapter order and may have gaps.
`nextAfter` is the consumed boundary; `hasMore` indicates remaining messages.
Pages use binary search and an approximately 4 MiB item budget; the first item
always returns to guarantee progress, even if oversized.

With `wait=true`, backlog returns immediately. At the end, a missing revision
returns a baseline snapshot; a changed public session/interaction state also
returns immediately. Matching state and no messages wait up to 25 seconds before
bodyless `204`. Probes run every 1.5 seconds with capacity 100/process and
10/session; overflow returns `429` and `Retry-After: 2`. Disconnect, timeout, and
shutdown release capacity. Concurrent same-session probes share immutable source
and runtime observations; pagination remains request-specific. Each response
uses the same runtime observation for status and interaction; effects revalidate.

Public response assembly belongs to `SessionReadService`. Interaction operations
read internal facts through `InteractionSessionReader` over the same catalog,
without calling the public response assembler. The interaction describer is
injected at construction.

`stateRevision` covers `session` except `updatedAt`, and the complete
`interaction` value. `session.updatedAt` remains in responses but does not wake
waiting requests. The revision does not validate message history. An ordinal
beyond the current range returns `400 after_out_of_range`; clients retry once from `after=0`.
Other history rewrites may go undetected; reload the browser page to reread history.
Terminal Preview uses its own snapshot/delta protocol.

The browser reads from `after=0` in pages of up to 300 items as the user scrolls.
Historical pages and tail waiting share one request slot. Tail waiting starts
at the end for unarchived sessions. Requests are canceled on session changes,
hiding, or unmount; appends preserve reading position. Resume availability is
`session.resume: { allowed, reason }`.

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
Lifecycle commands run without a CLI confirmation prompt; [execution rules](#execution-and-confirmation) apply.

### Public session CLI results

CLI output uses explicit whitelists independent of HTTP response types. It omits
operation/request IDs and attach commands. Exact fields and text formatting live
in [session-output.ts](../src/server/cli/session-output.ts).

| Command       | Result                                                                             |
| ------------- | ---------------------------------------------------------------------------------- |
| `list`        | `{ sessions }`: identity, title, status, home, project, update time, optional task |
| `inspect`     | `{ session, interaction, items, nextAfter, hasMore }`                              |
| `terminal`    | `{ content, truncated, capturedAt }`                                               |
| Input/handoff | `{ sessionId, status: "sent" }`                                                    |
| Lifecycle     | `{ sessionId, status: "succeeded" }`; create/resume also include `tmux`            |

`list` excludes children, including orphans; `--project` filters project association,
not launch/worktree location. Explicit IDs, including children, go directly to
endpoints without catalog lookup or parent redirection. Nullable metadata remains
null; absent task names remain omitted. Inspect includes the owning home's nickname
and current interaction, with `tmux: { socketPath, sessionName } | null`.

Items retain message Markdown and user-input content. Plans and input requests
include `inputHint`; answered responses flatten selections into `answers: string[]`
in question/answer order. Text output preserves full content, flattening whitespace
only in summaries/tables. See [ahub-control](../skills/ahub-control/SKILL.md#choose-actions-by-session-state)
for the input workflow.

### CLI continuous inspection

`inspect --follow` reads immediately, drains pagination sequentially, then long-polls.
`--count` requires `--follow` and counts rounds, including empty/`204` rounds; the
final round drains all pages. Without a count, observation continues until canceled,
including while idle or disconnected. Stopping observation does not stop the session.
Follow has no overall deadline; `--timeout` applies per request (default 30 seconds).

The first result always prints. Later output requires new visible items or changed
session/interaction state other than `updatedAt`; position-only advances stay silent.
JSON is NDJSON with the single-inspection shape and that page's incremental items.
Ordinals do not guarantee history consistency. Nonadvancing pagination, API/network
errors, and request timeouts end observation with exit code 1, without retry;
Ctrl+C cancels reads/timers and exits normally. The caller judges task completion.

Inspection exposes the current owned tmux target. Attach with
`tmux -S <socketPath> attach-session -t =<sessionName>:`, shell-quoting each argument.
Launch errors retain known `sessionId` and `tmux` inside `error` (unknown values are
null), including when readiness times out.

## File uploads

| Endpoint                                                          | Contract                                         |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| `POST /api/v1/uploads?sessionId=<Hub ID>&filename=<encoded name>` | Raw binary, ≤20 MiB; existing session required   |
| `GET /api/v1/sessions/:id/uploads`                                | `{ items }`, newest first, unpaginated           |
| `GET /api/v1/sessions/:id/uploads/:attachmentId/content`          | Raster preview; `?download=1` downloads          |
| `GET /api/v1/sessions/:id/uploads/:attachmentId/thumbnail`        | Cached WebP thumbnail; unavailable returns `404` |
| `DELETE /api/v1/sessions/:id/uploads/:attachmentId`               | Delete content/registration; idempotent          |

Upload returns `201`: `path`, `id`, `sessionId`, `filename`, `size`, `type`,
`uploadedAt`. Unique paths prevent overwrites.
Oversize returns `413`, storage failures `500`; mutations reject cross-origin
access. Content/deletion are session-scoped. Non-preview types (including HTML/SVG)
download; original content uses `nosniff`, sandbox CSP, and `no-store`.

PNG, JPEG, GIF, WebP, and AVIF uploads schedule background thumbnail generation
without delaying or failing the upload. Sharp produces a static, auto-oriented
WebP within 360 × 280 pixels (no enlargement, 40-million-pixel input limit).
Generation is serialized; concurrent requests for the same thumbnail share work.
Existing uploads are generated on first request; decoding failures return `404`.

History loads thumbnails lazily and originals only on expansion. BMP skips
thumbnails; unsupported or failed thumbnails never automatically load originals.
Thumbnails use `private, max-age=86400` and atomic files beside originals.
Deletion removes both; startup clears interrupted writes and orphan thumbnails.

Storage: `<home-dir>/uploads/<Hub session ID>/`, with atomic metadata rename and
absolute content paths. HTTP/storage validate session IDs and UUID-v4 attachment
IDs, matching metadata identity and direct content filenames/extensions. Reads,
deletion, and recovery reject corrupt metadata/symlink escapes using real locations.
Invalid IDs return `400`; missing attachments preserve not-found/idempotent-delete semantics.

Deletion tombstones metadata before removing content. Failed cleanup retries on
delete/startup; startup also cleans interrupted uploads without blocking service
or other uploads. Confirmed session deletion triggers background cleanup;
archive/exit and unconfirmed deletion retain files.

Attachment sends prepend absolute server paths, one per line, before optional
text. Message limits include these paths. Failed sends retain drafts; successful
sends clear unchanged drafts. Removing a draft attachment retains its stored file.
See [usage](usage.md#file-uploads).

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

Effects require current-user socket ownership, session liveness, and binding ownership.
Targets use a required absolute `socketPath` and `sessionName` matching `ahub-<UUID>`.
Each session must have exactly one window and one pane. Users must not rename,
move, link, or add windows/panes; Hub validates names but does not inspect or repair topology.

Liveness matches session names exactly. Concurrent checks coalesce without caching
completed results. Missing sockets, stopped servers, and absent sessions establish
exit; permissions, timeouts, and query errors do not. Binding changes during awaits
fail closed. Input and captures serialize per target and revalidate liveness and
ownership before effects; uncertain writes are never retried. Socket/session reuse
has no process-identity check. See [runtime](../src/server/interaction/session-runtime.ts)
and [tmux service](../src/server/interaction/tmux-service.ts).

CLI `send` rejects messages whose first character is `/`, unless `--force` is
used. It checks only the start of the entire message, without trimming whitespace,
for both `--message` and `--stdin`; subsequent lines are not checked. This guard is
CLI-only and does not change API validation.

CLI messages/ordinary keys default to `requireIdle: true`: non-idle input fails at
transaction entry without waiting/retry. `--force` sends `requireIdle: false`, allowing
input while working; browser calls omit the idle restriction. Connection, ownership, and management occupancy checks apply throughout. Ordinary keys use
the non-interrupt whitelist. Interrupt and handoff also skip the idle requirement while
retaining other checks. Handoff sends the adapter binding command; success means sent,
not confirmed binding.

### Binding format and ownership

Both adapters bind using `printf` and shell environment expansion without tmux
queries, allowing binding under Claude's worktree isolation checks.

Codex and Claude emit and recognize six-line `AHUB_TMUX_BIND_V3` records:
marker, absolute socket path, `ahub-<UUID>` session name, optional operation UUID,
optional project directory, and JSON task name or `null` (empty fields retain lines).
Codex accepts user-message `<user_shell_command>` output; Claude accepts native
main-user `<bash-stdout>` output. Unknown markers produce no binding events.
Invalid required V3 fields produce an invalid binding event.
An invalid latest binding attempt never falls back.

A process-wide manager tracks latest attempts/session and valid claims/socket/session
across homes, ordered by timestamp (invalid = zero), global session ID, ordinal,
position, including appends. New claims retain claims
on other sessions. Takeover makes former owners `superseded`, revoking effects and
attach. `supersededBySessionId` names a readable replacement (including archived),
otherwise null. Claims survive archive, deletion, rereads, and Hub close for the
process lifetime; later explicit binds can reclaim them. See [binding manager](../src/server/interaction/pane-binding-manager.ts).

### Project directory

Latest valid bind overrides Working Directory: absolute project path without
NUL/CR/LF; no filesystem/Git checks. Invalid/empty fields preserve earlier project
paths and do not invalidate pane bindings.

### Task association

Create accepts optional `taskName`; resume retains it and rejects overrides.
Names are trimmed, case-sensitive, and shared across homes/projects;
`<`, `>`, NUL, CR and LF are rejected. Unassigned responses omit the field.

Latest valid bind overrides the task; empty or invalid task fields preserve the
earlier value and do not invalidate pane bindings. Null and missing task fields
also preserve the existing task; there is no clear operation.

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

| Endpoint                              | Body / result                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/sessions`               | New: `{ home?, projectDirectory, workingDirectory?, taskName?, worktree, yolo?, requestId }`; resume: `{ resumeSessionId, yolo?, requestId }` → `202` operation |
| `POST /api/v1/sessions/:id/exit`      | `{}` → `202` operation                                                                                                                                          |
| `POST /api/v1/sessions/:id/archive`   | `{}` → `202` operation                                                                                                                                          |
| `DELETE /api/v1/sessions/:id`         | `{}` → `202` operation                                                                                                                                          |
| `GET /api/v1/operations/:operationId` | Current operation                                                                                                                                               |

Creation requires `projectDirectory`; optional `workingDirectory` defaults to it.
The adapter validates both as absolute existing local directories and resolves
symlinks, without checking Git relationships. The working directory controls
process launch; the project directory controls binding and association checks.
Idempotency includes both directories, normalized task name, and launch options;
omitted working directory equals an explicit project directory. `worktree` is
an independent agent launch option.

### Service responsibilities

The [coordinator](../src/server/management/operation-service.ts) owns idempotency,
occupancy, deadlines, retention, and cleanup. [Launch](../src/server/management/session-launch-executor.ts)
and [lifecycle](../src/server/management/session-lifecycle-executor.ts) executors
validate, invoke adapters, and confirm results. Continuations check operation
activity after awaits; shutdown reuses the exit service. Shared services delegate
native identity validation, directory resolution, history changes, and exit steps
to the owning adapter.

### Operation model

Operations include `operationId`, `type`, `status`, `createdAt`, `updatedAt`,
nullable `sessionId`, `error`, `phase`, `attachCommand`, optional
`target: { socketPath, sessionName }`, and launch `mode: new | resume`.
Types: `create`, `exit`, `archive`, `delete`; statuses: `pending`, `succeeded`,
`failed`, `unknown`. Exit phases are `sending_exit`, `waiting_exit`; archive adds
`archiving`, `confirming_archive`; delete adds `deleting`, `confirming_delete`.

### Idempotency and conflicts

Request IDs: 8–128 letters/digits/underscores/hyphens. Identical launch IDs/arguments
coalesce through execution and 30-minute terminal retention; changed arguments
return `409`. Different IDs permit concurrent project creation. Resume/lifecycle
share session occupancy: identical lifecycle operations coalesce, conflicts return
`409` without queuing. Different IDs cannot concurrently resume one session.

### Execution and confirmation

Delete is required; archive is optional. Public home archive capability derives from
method presence; Codex supports archive and Claude does not. Unsupported archive
HTTP requests return `409 operation_not_supported`; lifecycle execution repeats
the check before resolving targets, exiting, or invoking native effects.

Create/resume share launch; worktree/YOLO are options. Resume occupies the session,
refreshes source once, records a binding baseline, and evaluates runtime once,
reusing its directory. Prelaunch checks binding/operation validity without another
external-change scan or filesystem/tmux atomicity. Native commands use the
[owning adapter's home environment](#home-identity-and-routing). Shared services
delegate native history changes to the owning adapter.

| Operation | Validation and confirmation                                                                                                                                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create    | Project and effective working directories independently resolve to existing real paths; equal inputs share resolution. Confirm operation marker, target, project, valid bind within 60 seconds after launch.                                                                                                                                                        |
| Resume    | Require unarchived unique valid native identity, plus no binding, confirmed session exit, or explicit transfer. Invalid/uncertain bindings deny resume. Confirm original identity, marker, project, live owned target.                                                                                                                                              |
| Exit      | Validate latest bind; interrupt/EOF then force-close the tmux session if needed. Confirm session absence within 30 seconds; query errors/ownership changes mean `unknown`. Unbound succeeds, missing fails; archived uses same checks.                                                                                                                              |
| Archive   | Refresh source; already archived succeeds. Validate unique native identity, exit, run native archive once (25-second command limit), confirm within 30 seconds.                                                                                                                                                                                                     |
| Delete    | Run Exit validation and sequence first, then permanently remove history through the owning adapter (Codex: `codex delete <UUID> --force`; Claude: remove session JSONL and associated subagents directory). Exit, deletion, and same-source absence confirmation have separate 30-, 25-, and 30-second budgets. Initially absent in a successful snapshot succeeds. |

Codex launches `ahub-<operationId>` with `--no-daemon --no-alt-screen`, optional
`--worktree`/`--yolo` (off by default), and an initial native `! printf ...` shell binding command, whose recorded output
provides the operation marker and project/task association. Resume uses
`codex resume <UUID>`, trying Working then Project Directory: skip invalid paths,
fall back only on missing/non-directory paths. Launch from chosen real path,
retain original project association; reject home/projectDirectory/workingDirectory/worktree overrides.
Users must ensure unbound sessions' original processes have exited.

Attach appears after 30 seconds and survives timeout, using known target or
configured socket/deterministic session name. Confirmed no-launch tmux errors
mean `failed`; launch timeout, malformed success, and post-launch errors mean
`unknown`, without retry/teardown.

Exit controls the whole tmux session, including manual binds, retaining session data;
see [ADR-0022](adr/0022-separate-session-exit-from-archive.md). After the adapter's
exit steps, the shared state machine waits 4 seconds before Ctrl-D and another
9 seconds before one targeted `kill-session`. Each step checks cancellation and
target ownership/state; natural exit stops further sends, and forced close still
requires exit confirmation. Occupancy blocks
ordinary input/handoff with `409 session_busy`; archive and delete hold it through confirmation.
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
and `--json`. Hosted resources use the configured HTTPS/mTLS/proxy authentication.

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
Session Markdown accepts canonical `/web/<id>/` links;
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
Missing/malformed/unsupported values use English. Changes apply without reload
and synchronize across tabs. Locale affects presentation, preserving API values, identities, conversation/terminal
text, paths, commands. Dates use device time zone; documentation captures use UTC.

[Client i18n](../src/client/i18n/) owns catalogs, interpolation, and formatters.
English defines translation keys/parameters; Chinese catalogs must match.
Missing/empty translations fall back to English. Adding a language requires
catalog registration and validation tests; there is no runtime catalog fetch or
browser-language detection.

Notifications retain keys until rendering; native diagnostics remain verbatim
beside localized explanations. Structured API errors use codes, never English
message matching. Translation preserves HTTP/WebSocket contracts. Preference
changes preserve running operations, drafts, and loaded conversations.

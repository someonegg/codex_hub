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

Codex scans `rollout-*.jsonl` in `sessions/` and `archived_sessions/`;
`session_index.jsonl` provides advisory names.
Trusted homes allow symlinks outside them, through directory depth 8 (root = 0),
without cycle detection/real-path deduplication. Descriptors, ordering, fallback IDs, and source-relative
cache keys use logical paths.

Both adapters index content caches by logical source-relative path, size, and
mtimeMs, without device, inode, ctime, or decoder/normalizer versions. Permission-only
changes and replacements preserving all three fields do not trigger reads. Growing
files reuse decoded prefixes when SHA-256 probes match. Probes cover the first
4 KiB and up to 4 KiB before the previous EOF. One open handle reads to observed
EOF, starting after the last committed newline. Restart, truncation, same-size
detected changes, or probe mismatch require full decoding. Checkpoints are generated
and consumed only within the process; they are not a persisted compatibility protocol. A middle
rewrite preserving both probes followed by an append can escape detection; see
[ADR-0012](adr/0012-use-checkpointed-incremental-rollout-loading.md).

Loaded archives remain cached until restart or restoration, including in-place
edits and permission changes. Discovery, removal, advisory metadata refresh, and
failed-load retries continue. Filesystem failures surface when operations run.

### Session identity

Native IDs and parent relationships are home-scoped. Duplicates retain the accepted readable rollout, or select the first fully
readable candidate in existing path order. Codex caches only the fingerprint and native ID of confirmed duplicates, without
timelines, checkpoints, or bindings. Unchanged duplicates skip decoding while the
winner remains valid; changed candidates and replacements load fully. Missing paths
leave both caches. Claude identifies duplicate candidates by filename before decoding. Missing native IDs use path identity.
Shared services check native identity presence; adapters validate format (Codex
requires UUIDs).

### Adapter publication and diagnostics

Snapshots are immutable, including nested values; reused references mean unchanged
content. An unchanged source signature returns the same snapshot object; each
refresh still resets and records independent telemetry. Binding events are extracted
from the current decoded batch, while only project/task metadata accumulates.
Public origins expose `agentVersion` for display and omit `formatVersion`. Registration requires
independently unique, nonempty `instanceKey` and `home`, using server domain types.

HTTP path IDs are decoded once after segment splitting: nonempty, at most 1,024
UTF-8 bytes, without controls, slashes, backslashes, or standalone `.` / `..`.
Message reads validate ordinal bounds.

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
`409`. Operations use the selected/owning adapter's local CLI and home environment
(`CODEX_HOME` for Codex, `CLAUDE_CONFIG_DIR` for Claude). See [Multiple homes](usage.md#multiple-homes).

### Claude Code adapter

The independent `claude-jsonl` source scans only `projects/<project>/<UUID>.jsonl`.
It never imports Codex adapter internals or writes native history. Native UUID
validation belongs to Claude; `parentUuid` is a message link, never a parent session.
Main records with sidechain/subagent provenance, API copies, thinking, ordinary
tool calls/results, local commands, interruption notices and shell wrappers are
excluded from conversation output. Ordinary assistant text is retained regardless
of model. Each complete JSONL line is processed independently without message-ID
aggregation; block order determines monotonically increasing item ordinals/IDs.
Decoder ordinals count physical lines, and only newline-terminated records commit.

Claude uses the shared [checkpointed JSONL reader](#discovery-and-caching).
Unchanged fingerprints (logical source-relative path, size, mtimeMs) reuse cached entries;
caches retain checkpoints and parsing state, not full log bytes or full-file digests.
Both adapters cap lines at 8 MiB, messages at 1,000,000 UTF-16 code units without
splitting surrogate pairs, and session diagnostics at 50. Decoder diagnostics take
priority over separately retained normalizer diagnostics. Identity conflicts remain
explicit state even when diagnostics are full. Both adapters cap final source
diagnostics at 50 while continuing to process valid files. The shared
[filesystem failure](#adapter-publication-and-diagnostics), duplicate-identity,
and immutable-publication rules apply; invalid/unavailable duplicate paths allow
valid replacements. Internal telemetry reports full/append file counts,
probe/decode bytes, and decode/normalization time, without an HTTP API.

Assistant phase uses only that row's `message.stop_reason`: `tool_use` → `update`,
`end_turn` → `response`, all other values → `null`. `ExitPlanMode.input.plan`
produces an assistant plan response; external plan files are never read.
`AskUserQuestion` emits independent request/result items keyed by tool call ID,
with question IDs `<callId>:<index>`. Structured answers take precedence; explicit
rejection is `aborted`, uninterpretable results are `unavailable`. No approval UI,
permission-mode, annotations or multi-select domain fields are synthesized.

Project association uses valid V1/V2 shell binding metadata, otherwise the first
valid cwd; execution uses the latest valid cwd. Titles prefer the latest nonempty
`custom-title`, then `ai-title`, then first ordinary user text; otherwise the title is
`Untitled session`, matching Codex.
Explicit titles use the first nonempty trimmed line and an 80-character limit;
user titles share Markdown heading extraction.
`agent-name` does not supply a task name. Only main native user `<bash-stdout>`
wrappers can claim a pane; API copies, ordinary quoted prose and tool results cannot.

Launch sets `CLAUDE_CONFIG_DIR` explicitly and uses interactive `claude`, optionally
`--resume <UUID>`, `--worktree`, and `--dangerously-skip-permissions`.
On Claude Code 2.1.318, a CLI prompt starting with `!` is ordinary model input.
The adapter instead waits up to 30 seconds for the native interactive prompt,
then pastes the complete `! printf ...` binding command. It reads
`"${TMUX%%,*}"` and `"$TMUX_PANE"` using native shell expansion; avoiding command
substitution also permits binding under Claude's worktree isolation checks.
Claude records the binding itself. Failure to reach the interactive prompt retains
the target and attach command as an unknown launch result. A running process alone
never confirms launch: public management still verifies operation ID, pane ownership, project,
and original identity on resume.

Interrupt clears input with Ctrl-U, waits 100 ms, then sends Escape, matching
Codex. Exit immediately sends Ctrl-C, then repeats at one-second intervals for
three sends total, followed by the shared [exit sequence](#execution-and-confirmation).
See the [native keyboard reference](https://code.claude.com/docs/en/interactive-mode)
and [stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons).

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
| `homes`    | `nickname` and `management: { archive, delete }`, including empty homes                                      |
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
living, owned pane. Normal does not authorize Resume. Runtime checks coalesce
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
uses the same pane observation for status and interaction; effects revalidate.

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

Text/JSON whitelists are independent of HTTP types; extra fields never pass through. Readiness uses API `session.status` and interaction before
mapping. Operation/request IDs and attach commands are excluded. Tmux diagnostics
include socketPath, paneId, and sessionName (null when unknown).

| Command/result    | Public fields                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list`            | `{ sessions }`; entries: `id`, `title`, `status`, `home`, `projectDirectory`, `updatedAt`, optional `taskName`                                                     |
| `inspect`         | `{ session, interaction, items, nextAfter, hasMore }`                                                                                                              |
| Inspect `session` | `id`, `title`, `status`, `home`, `agentName`, `workingDirectory`, `projectDirectory`, `createdAt`, `updatedAt`, `resume: { allowed, reason }`, optional `taskName` |
| `interaction`     | `{ supported: false, tmux: null }` or `{ supported: true, state, activity, supersededBySessionId, tmux }`                                                          |
| `terminal`        | `{ content, truncated, capturedAt }`                                                                                                                               |
| Input/handoff     | `{ sessionId, status: "sent" }`                                                                                                                                    |
| Lifecycle         | `{ sessionId, status: "succeeded" }`; create/resume also include `tmux`                                                                                            |

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
`phase=response` and `itemType=plan` also include `inputHint`, preserving full
Markdown. User input adds `stage`: requests add `questions` (header, question,
and option labels/descriptions) and `inputHint`; responses add `outcome`:
`answered` adds `answers: string[]` in original question/answer order;
`unavailable` adds `summary`; `aborted` adds no fields.

Text preserves content/Markdown, flattening tabs/newlines only in summaries and
tables. Requests show question headers, full questions, numbered options with
descriptions, and a hint; answers show one selection per line; Plans append the
hint to their full text. See [output formatting](../src/server/cli/session-output.ts)
for labels and [ahub-control](../skills/ahub-control/SKILL.md#choose-actions-by-session-state)
for the input workflow.

### CLI continuous inspection

`session inspect --follow` immediately reads the first page, drains pagination
sequentially, then long-polls the same endpoint for the next round.
`--count` is a positive safe integer counting rounds, including empty rounds;
the final round drains every page. `--count` requires `--follow`; `204` timeouts count as rounds. Without a
count observation continues until canceled, including while idle, disconnected,
or after an assistant response. Stopping observation does not stop the session.
Task completion is judged by the caller against requirements and deliverables.
Follow has no overall deadline; `--timeout` limits each HTTP request (default 30 seconds, above the server’s 25-second wait).

The first result always prints. Later results print only for visible new items
or changes to session/interaction fields other than `session.updatedAt`. JSON output is NDJSON with the same
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

History lazily loads thumbnails and requests originals only on expansion. BMP
skips thumbnail generation and requests. Unsupported, missing, or failed thumbnails
show “Preview unavailable” and still allow expansion; they never automatically
load the original.

Thumbnails use `private, max-age=86400` browser caching and atomic
`<attachment ID>.thumb.webp` files beside originals. Deletion removes both;
startup clears interrupted thumbnail writes and orphan thumbnails.

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

Codex reads five-line `AHUB_TMUX_BIND_V1` records from user-message
`<user_shell_command>` output: marker, absolute socket path, numeric `%` pane ID,
optional operation UUID, optional project directory (empty fields retain lines).
Six-line `AHUB_TMUX_BIND_V2` records add a final JSON task name or `null`.
An invalid latest binding attempt never falls back.

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

Archive/delete are optional manager methods. Public home capabilities derive from
method presence; Codex supports both and Claude supports neither. Unsupported
HTTP requests return `409 operation_not_supported`; lifecycle execution repeats
the check before resolving targets, exiting, or invoking native effects.

Create/resume share launch; worktree/YOLO are options. Resume occupies the session,
refreshes source once, records a binding baseline, and evaluates runtime once,
reusing its directory. Prelaunch checks binding/operation validity without another
external-change scan or filesystem/tmux atomicity. Native commands use the
[owning adapter's home environment](#home-identity-and-routing); Hub never
moves/deletes native history directly.

| Operation | Validation and confirmation                                                                                                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create    | Project and effective working directories independently resolve to existing real paths; equal inputs share resolution. Confirm operation marker, target, project, valid bind within 300 seconds after launch.                          |
| Resume    | Require unarchived unique valid native identity, plus no binding, confirmed pane death, or explicit transfer. Invalid/uncertain bindings deny resume. Confirm original identity, marker, project, live owned target.                   |
| Exit      | Validate latest bind; interrupt/EOF then force-close entire pane if needed. Confirm dead/missing within 30 seconds; query errors/ownership changes mean `unknown`. Unbound succeeds, missing fails; archived uses same checks.         |
| Archive   | Refresh source; already archived succeeds. Validate unique native identity, exit, run native archive once (25-second command limit), confirm within 30 seconds.                                                                        |
| Delete    | Permanently remove session history through native delete (`codex delete <UUID> --force`), confirm same-source native identity absent within 30 seconds. Initially absent in successful snapshot succeeds. Running panes remain active. |

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

Exit controls the whole pane, including manual binds, retaining session data;
see [ADR-0022](adr/0022-separate-session-exit-from-archive.md). After the adapter's
exit steps, the shared state machine waits 4 seconds before Ctrl-D and another
9 seconds before one targeted `kill-pane`. Each step checks cancellation and
target ownership/state; natural exit stops further sends, and forced close still
requires exit confirmation. Occupancy blocks
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

`src/client/i18n/` owns catalogs, metadata, keys, interpolation, namespaces/formatters. English defines keys/parameters; Chinese entries must match.
Namespaces: `common`, `hub`, `reader`, `interaction`, `hosting`, `errors`, `settings`.
Missing/empty translations fall back to English. New languages require catalog,
`languageOptions`/initialization registration, validation tests. No runtime fetch
or browser-language detection.

Notifications retain keys until rendering; native diagnostics remain verbatim
beside localized explanations. Structured API errors use codes, never English
message matching. Translation preserves HTTP/WebSocket contracts. Preference
changes preserve running operations, drafts, and loaded conversations.

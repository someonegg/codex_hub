---
status: accepted
date: 2026-10-16
---

# Observe asynchronous management operations on the server

The exit sequence and no-forced-kill policy below are historical; see
[ADR-0022](0022-separate-session-exit-from-archive.md) for their replacement.
[ADR-0023](0023-separate-runtime-status-from-resume-permission.md) extends creation
and session occupancy to Resume. See the
[management reference](../technical-reference.md#asynchronous-management) for the current protocol.

## Context and Problem Statement

CLI completion does not guarantee visible session data. Creation begins without
a native session ID, and unloading the page must not interrupt execution.

## Decision Drivers

- Organize sessions by project while retaining the native Codex lifecycle.
- Verify results without duplicate execution or guessed associations.

## Considered Options

- Observe asynchronous operations on the server.
- Wait for command completion within synchronous requests.

## Decision Outcome

Writes return `202`. A shared server loop observes operations every second;
GET requests only read results and never resume execution.

### Identity and concurrency

Create retains `requestId`: identical IDs and arguments coalesce while pending
and during terminal retention; changed arguments return `409`. Different IDs may
create concurrently in one project. Archive/delete accept `{}` and coalesce the
same operation on a session; conflicting operations return `409` without queuing.

Managers register by the read adapter's unique `sourceInstanceId`; composition
selects the default creation source. Archive/delete use only the owning source's
manager and fail without management support. Native identity uniqueness, binding
correlation, and confirmation are source-local. Generic services accept nonempty
native IDs; the Codex adapter validates UUIDs. Diagnostics are server-only and do
not alter management policy; snapshots carry no completeness flag.

### Execution and confirmation

Create passes the binding shell instruction as Codex's initial CLI argument and
matches `operationId`, launch target, project, and valid binding. Only tmux errors
that confirm no launch are `failed`. A `new-session` timeout, malformed successful
output, or post-launch setup, connection, or binding-correlation error is `unknown`;
there is no automatic retry or teardown. Attach uses the known target, or the
configured socket and deterministic `codex-hub-<operationId>` name if unknown.
After launch, binding observation allows 300 seconds. Attach is hidden for the
first 30 seconds, then shown and retained on timeout.

Archive rereads the snapshot and succeeds immediately if already archived.
Otherwise validate the target, send `Ctrl+C` and `Ctrl+D` once without Enter,
wait for exit, run native archive, and confirm. Delete succeeds immediately if
absent from a successful initial snapshot; otherwise require archive, run native
delete, and confirm no same-source native identity remains. Thrown read errors
do not prove deletion: startup applies existing failure/unknown rules, while
observation keeps waiting until timeout. Successful snapshots that skip unreadable
data remain valid confirmation evidence without a completeness gate.

Delete allows 30 seconds; archive exit and archive confirmation each allow 30
seconds, and native archive allows 25 seconds. Execution contexts are discriminated
unions with phase-specific required fields, separate from results and create
idempotency records. Every terminal state immediately clears execution context,
concurrency indexes, and session occupancy. Immutable results remain for 30 minutes.
Hung checks cannot block timeout cleanup; asynchronous continuations and subsequent
commands verify operation validity so old tasks cannot affect newer operations.

### Client recovery

Only `pending` operations are polled, one second after each completed query.
Reload resumes polling; all terminal states and `404` clear recovery markers.
Create retries after network errors reuse the ID until a terminal result, then
discard it. There is no separate result-reconciliation action; failed progress
queries can be retried.

Timeout ends tracking without undoing submitted external commands. After an
uncertain create, attach or refresh before submitting again to avoid duplicates.
Session discovery is independent of operation tracking; restarts do not recover it.

### Positive Consequences

- Progress survives page reloads, and thrown read errors do not falsely prove deletion.

### Negative Consequences

- Tracking is in memory, confirmation is delayed, and uncertain results require
  checking tmux or the catalog.
- Successful partial snapshots can treat skipped sessions as absent.

## Pros and Cons of the Options

### Server-observed asynchronous operations

- Good: Decouples browser lifetime from execution and verifies visible results.
- Bad: Adds observation state and timeouts without durable recovery.

### Synchronous command requests

- Good: Preserves existing behavior with fewer changes.
- Bad: Command completion does not establish visible results, and page lifetime
  remains coupled to execution.

See [ADR-0018](0018-cache-validation-per-binding-record.md) for V3 binding and current pane validation.

## Execution responsibility refinement (2026-10-21)

`OperationService` owns registration, request idempotency, session occupancy,
tracking deadlines, result publication, and retention. `SessionLaunchExecutor`
executes create/resume validation, adapter launch, and association observation.
`SessionLifecycleExecutor` executes exit/archive/delete and confirms their effects,
reusing `SessionExitService` for pane shutdown.

Executors use an internal operation control contract to advance phases, request
coalesced observations, and report outcomes. They do not own operation registries,
idempotency records, or occupancy cleanup. This extraction preserves operation
semantics, adapter-native identity boundaries, and cancellation checks after
asynchronous work. The cost is an explicit internal state/control contract shared
between the coordinator and executors.

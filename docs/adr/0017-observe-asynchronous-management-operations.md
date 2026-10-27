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

Operations coalesce identical requests, reject conflicting session work, and
confirm effects from source observations rather than command completion alone.
Identity validation and confirmation belong to the owning adapter. Uncertain
external effects are not retried; tracking is process-local and time-bounded.

### Historical archive sequence

At introduction, archive sent `Ctrl+C` and `Ctrl+D` once, waited for pane exit,
then ran the native command. It did not force-close the pane. ADR-0022 replaces
that sequence with an independent exit service and bounded whole-pane shutdown.

The [management reference](../technical-reference.md#asynchronous-management)
owns current endpoints, deadlines, retention, recovery, and executor boundaries.

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

See [ADR-0018](0018-cache-validation-per-binding-record.md) for binding ownership and pane
validation; see the [current binding format](../technical-reference.md#tmux-interaction) for supported versions.

## Execution responsibility refinement (2026-10-21)

Separate operation coordination from launch/lifecycle execution while preserving
idempotency, occupancy, adapter boundaries, and cancellation checks. This adds an
explicit control contract between coordinator and executors; see the
[current responsibility boundaries](../technical-reference.md#service-responsibilities).

---
status: accepted
date: 2026-10-19
---

# Separate runtime status from resume permission

## Context and Problem Statement

The public archive flag does not express whether a session owns a living pane.
Interaction's disconnected state includes malformed bindings as well as confirmed
pane death. Treating either Normal or disconnected as permission to launch another
process can duplicate a running session.

## Considered Options

- Infer resume permission from the existing disconnected interaction state.
- Retain explicit binding and pane evidence and expose a separate resume capability.

## Decision Outcome

Expose `normal | live | archived` as session status throughout catalog and reader
responses. Archive wins; Live requires a living owned pane. Preserve interaction
connection states independently. Use shared bounded pane observations and retain
archive facts inside source snapshots. Status participates in catalog revisions;
status, resume capability and interaction participate in reader revisions.

Resume extends the existing create request with an exclusive `resumeSessionId`
form. Resolve its home, native identity and directory on the server. Require a
valid latest binding with confirmed pane death or explicit ownership transfer,
or no binding record, and a unique valid native identity and usable directory.
The 2026-10-22 refinement permits unbound sessions to resume and places a concise
reminder beside Unbound to ensure the original session has exited. This accepts
that the hub cannot establish whether an unbound session is already running. Unknown checks fail
closed. Acquire the session management occupancy before asynchronous checks,
refresh the source and repeat validation before launch. Observe operation marker,
original identity, project, launched pane and ownership before success. Reuse
create idempotency and tracking; retain `type: create` with `mode: resume`.

Unknown launch results retain known targets and attach access, then release
session occupancy. Resume uses the same requestId idempotency as Create and keeps
no separate reservation for unknown launches. A different requestId can launch
again if the normal resume checks pass; the previous launch may still be running.
Request records remain process-local with the existing retention policy. This
accepts the same uncertain-retry tradeoff as Create.

Unarchived reader panels render immediately and show only connection information,
events, errors and management actions until connected. Disconnect hides controls
and retains the draft. The panel and menu share one operation controller. Exit
reuses ADR-0022 and never archives history.

## Consequences

Normal deliberately gives no recovery guarantee. Unbound sessions can resume
without manual binding evidence; users must ensure the original session has exited
to avoid concurrent processes for the same identity. Invalid bindings and uncertain
runtime checks still deny resume. Runtime observations add
bounded tmux work to catalog probes even when rollouts have not changed. Failures
may temporarily remove Live and Resume; retaining optimistic stale results would
weaken the safety boundary. This refines ADR-0017/0018 tracking and binding rules
and ADR-0021 catalog revisions without replacing their other decisions.

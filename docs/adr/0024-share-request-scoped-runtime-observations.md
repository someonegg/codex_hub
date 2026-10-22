---
status: accepted
date: 2026-10-21
---

# Share runtime observations within each reader response

## Context and Problem Statement

Runtime evaluation and interaction descriptions queried pane liveness separately.
A single reader response therefore performed two sequential tmux observations;
in-flight coalescing could not combine them. Reconciliation then combined facts
observed at different times.

Session metadata, pane ownership, tmux liveness, and adapter identity/directory
validation have different owners. Sharing an observation must preserve those
boundaries and must not create a completed-result cache for later operations.

## Considered Options

- Keep separate observations and reconcile their results.
- Share one request-scoped observation while retaining independent source owners.

## Decision Outcome

Reader metadata, item pages, and update probes carry an internal interaction
snapshot with the pane observation used for runtime evaluation. The interaction
service derives connection state from that same evidence. One application-level
assembler removes internal facts, reconciles public policy, and computes the
update revision for all three response paths.

Pane observations retain the binding record and replacement owner they checked.
Changes during observation, directory validation, or response assembly revoke
optimistic connection/resume results. Observation failures remain unknown and
never establish pane death. Archive state and interaction support remain separate
source and configuration facts.

Each subsequent read/probe makes a new observation. Input and management effects
retain their execution-time ownership and activity checks; they never reuse a
reader response's completed observation. Concurrent transport checks may still
share in-flight work. Polling capacity and browser timeline rendering are outside
this change.

This refines ADR-0018 and ADR-0023 without replacing their validation rules.

## Consequences

- A reader response uses one pane observation for status and interaction.
- Source snapshots and adapter validation keep their existing responsibilities.
- Internal read contracts must carry observation evidence until assembly and keep
  it out of public responses.
- Observation is not an atomic transaction across the filesystem and tmux. Binding
  changes fail closed; later external pane changes are seen by the next fresh
  observation or execution-time validation.

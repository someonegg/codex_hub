---
status: superseded by ADR-0019
date: 2026-08-20
---

Superseded by [ADR-0019](0019-enable-automatic-updates-for-unarchived-sessions.md).

# Remember automatic updates per browser tab

## Context and Problem Statement

The automatic updates switch previously reset whenever the reader remounted or navigated to another session. This made page refreshes unexpectedly disable a user-selected polling behavior, while permanent cross-browser persistence could unexpectedly resume polling much later.

## Decision Drivers

- Refreshing or navigating within one tab should preserve the user's choice.
- Closing the tab should restore the safe default of disabled automatic updates.
- Archived sessions must never start automatic updates polling.

## Considered Options

- Store one tab-scoped preference in `sessionStorage`.
- Store one durable browser-wide preference in `localStorage`.
- Store a durable preference for every session in `localStorage`.

## Decision Outcome

Chosen option: "Store one tab-scoped preference in `sessionStorage`", because it survives the expected short-term reader lifecycle without turning polling into a durable or session-by-session policy.

The preference defaults to disabled, is shared by active sessions opened sequentially in the same tab, and is updated for both user changes and terminal failures that disable automatic updates. A stored enabled preference has no effect for archived sessions; their switch remains hidden and no scheduler starts. Missing, malformed, or unavailable storage falls back to disabled behavior.

### Positive Consequences

- Page refresh and same-tab session navigation preserve an intentional automatic updates setting.
- Closing the tab clears the preference and restores disabled-by-default behavior.
- The implementation needs no server-side preference store or per-session cleanup.

### Negative Consequences

- Enabling automatic updates for one active session enables it for the next active session opened in that tab.
- Different tabs can have different preferences.
- Storage restrictions silently reduce the behavior to in-memory state.

## Pros and Cons of the Options

### Tab-scoped global preference

- Good: Remembers short-term intent and naturally expires with the tab.
- Bad: Applies one choice to every active session visited in that tab.

### Durable browser-wide preference

- Good: Survives browser restarts without further input.
- Bad: Can resume polling long after the user last enabled it.

### Durable per-session preference

- Good: Preserves a distinct choice for every session.
- Bad: Accumulates stale identifiers and creates a more complex policy than the reader needs.

---
status: accepted
date: 2026-10-16
---

# Enable automatic updates by default for unarchived sessions

Current scope (updated 2026-10-16): reader automatic updates remain in force.
[ADR-0021](0021-split-catalog-structure-and-activity.md) replaces the periodic catalog
summary refresh below with structural long polling and best-effort timestamps in
list snapshots. See the [catalog reference](../technical-reference.md#catalog).

## Context and Problem Statement

An interactive hub needs timely updates. Manual toggles and browser
preferences add steps and can block history paging.

## Decision Drivers

- Receive conversation updates without requiring a toggle or stored preference.
- Allow history paging and automatic updates to coexist without losing reading position.

## Considered Options

- Enable automatic updates by default for unarchived sessions.
- Retain a tab-scoped automatic updates preference.

## Decision Outcome at Introduction

Enable automatic updates for unarchived sessions, remove its toggle and stored preference,
and stop subscriptions on archive. History paging does not depend on disabling
automatic updates; appends preserve reading position. At this decision's introduction, the
visible catalog refreshed summaries every three seconds and paused while hidden;
only the opened session subscribed to conversation updates.

### Positive Consequences

- Opening a session receives updates without preventing history loading.

### Negative Consequences

- Open unarchived sessions keep long polls active. Catalog reads add periodic
  work; snapshot checks and cancellation must handle paging/automatic updates races.

## Pros and Cons of the Options

### Default automatic updates for unarchived sessions

- Good: Automatic updates coexist with history loading.
- Bad: Requires ongoing polling and careful request coordination.

### Tab-scoped automatic updates preference

- Good: Preserves existing behavior with fewer changes.
- Bad: Adds manual steps and can obstruct history paging.

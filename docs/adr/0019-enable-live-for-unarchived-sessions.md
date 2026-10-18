---
status: accepted
date: 2026-10-16
---

# Enable Live by default for unarchived sessions

## Context and Problem Statement

An interactive hub needs timely updates. Manual toggles and browser
preferences add steps and can block history paging.

## Decision Drivers

- Receive conversation updates without requiring a toggle or stored preference.
- Allow history paging and Live updates to coexist without losing reading position.

## Considered Options

- Enable Live by default for unarchived sessions.
- Retain a tab-scoped Live preference.

## Decision Outcome

Enable Live for unarchived sessions, remove its toggle and stored preference,
and stop subscriptions on archive. History paging does not depend on disabling
Live; appends preserve reading position. At this decision's introduction, the
visible catalog refreshed summaries every three seconds and paused while hidden;
only the opened session subscribed to conversation updates.

### Positive Consequences

- Opening a session receives updates without preventing history loading.

### Negative Consequences

- Open unarchived sessions keep long polls active. Catalog reads add periodic
  work; snapshot checks and cancellation must handle paging/Live races.

## Pros and Cons of the Options

### Default Live for unarchived sessions

- Good: Automatic updates coexist with history loading.
- Bad: Requires ongoing polling and careful request coordination.

### Tab-scoped Live preference

- Good: Preserves existing behavior with fewer changes.
- Bad: Adds manual steps and can obstruct history paging.

## Catalog protocol update, 2026-10-16

[ADR-0021](0021-split-catalog-structure-and-activity.md) supersedes only the catalog
behavior: server-resolved display titles participate in structural long polling;
pagination and three-second summary refreshes become structural long polling and
best-effort timestamps included in list snapshots. Details retain separate title/nickname fields;
reader Live and timeline cursor semantics are unchanged.

---
status: accepted
date: 2026-10-16
---

# Enable hub management and interaction by default

## Context and Problem Statement

A read-only interface with opt-in interaction cannot support creating, interacting
with, and managing sessions by project.

## Decision Drivers

- Organize sessions by project while retaining the native Codex lifecycle.
- Verify operation results without duplicate execution or guessed associations.

## Considered Options

- Enable management and interaction by default.
- Retain read-only operation with opt-in interaction.

## Decision Outcome

Enable management and interaction by default. All unarchived sessions can be
archived, including unbound sessions; only archived sessions can be deleted.
The Codex adapter handles native commands while tmux transport stays generic.
Retain ADR-0007's socket ownership, pane liveness, and serialized-input constraints.

### Positive Consequences

- Creation and management share the project entry point without extra startup flags.

### Negative Consequences

- Starting the server grants write and delete capabilities within the existing
  network trust boundary. Management requires Codex CLI and tmux.

## Pros and Cons of the Options

### Enable management and interaction by default

- Good: Supports the complete project workflow without extra configuration.
- Bad: Deployments must protect endpoints that can modify and delete sessions.

### Retain read-only operation with opt-in interaction

- Good: Preserves existing behavior with fewer changes.
- Bad: Does not support the complete project workflow.

See [ADR-0018](0018-cache-validation-per-binding-record.md) for V3 bindings and live checks.

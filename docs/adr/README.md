# Architecture decisions

ADRs explain why a choice was made, including alternatives and accepted costs.
Use the [technical reference](../technical-reference.md) for current contracts.

- Preserve record numbers, decision dates, and historical context when editing.
- Keep each record focused on one decision; link to implementation details instead
  of duplicating the technical reference.
- Mark full replacements as superseded and link their successors. For partial
  refinements, retain the status and add a scope note linking the later decision
  or current reference. A later refinement does not change the decision date.

## Decision index

The status column records the lifecycle; scope notes identify later refinements.

| Decision | Status | Scope / successor |
| --- | --- | --- |
| [0001: Use generation-based whole-file session snapshots](0001-use-generation-based-session-snapshots.md) | superseded | [ADR-0012](0012-use-checkpointed-incremental-rollout-loading.md) |
| [0002: Use JSONL-only session discovery](0002-use-jsonl-only-session-discovery.md) | accepted | unreadable placeholders replaced by skip-and-retry behavior |
| [0003: Use session source adapters](0003-use-session-source-adapters.md) | accepted | — |
| [0004: Use session-scoped revisions for reader consistency](0004-use-session-scoped-reader-revisions.md) | superseded | [ADR-0009](0009-use-opaque-single-writer-timeline-cursors.md) |
| [0005: Use query-scoped revisions for session-list pagination](0005-use-query-scoped-revisions-for-session-list-pagination.md) | superseded | [ADR-0010](0010-use-opaque-session-list-cursors.md) |
| [0006: Use conditional read cursors for session resources](0006-use-timeline-prefix-continuity.md) | superseded | [ADR-0009](0009-use-opaque-single-writer-timeline-cursors.md) |
| [0007: Discover tmux interaction targets through adapters](0007-use-adapter-discovered-tmux-interaction.md) | superseded | [ADR-0016](0016-enable-hub-management-by-default.md) and [ADR-0018](0018-cache-validation-per-binding-record.md) |
| [0008: Split the session catalog and reader into a multi-page application](0008-split-session-catalog-and-reader-into-an-mpa.md) | superseded | [ADR-0020](0020-use-a-unified-project-hub.md) |
| [0009: Use opaque single-writer timeline cursors](0009-use-opaque-single-writer-timeline-cursors.md) | accepted | — |
| [0010: Use opaque cursors for session-list pagination](0010-use-opaque-session-list-cursors.md) | superseded | [ADR-0021](0021-split-catalog-structure-and-activity.md) |
| [0011: Use repository-probed bounded long polling for automatic updates](0011-use-repository-probed-bounded-long-polling.md) | accepted | cache policy replaced by [ADR-0018](0018-cache-validation-per-binding-record.md); toggle removed by [ADR-0019](0019-enable-automatic-updates-for-unarchived-sessions.md) |
| [0012: Use checkpointed incremental rollout loading with probe validation](0012-use-checkpointed-incremental-rollout-loading.md) | accepted | probe validation applies to unarchived rollouts; loaded archives reuse cached content |
| [0013: Filter session archive state in the browser](0013-filter-session-archive-state-in-the-browser.md) | superseded | [ADR-0020](0020-use-a-unified-project-hub.md) |
| [0014: Remember automatic updates per browser tab](0014-remember-automatic-updates-per-browser-tab.md) | superseded | [ADR-0019](0019-enable-automatic-updates-for-unarchived-sessions.md) |
| [0015: Expose session index names as presentation metadata](0015-expose-session-index-names-as-presentation-metadata.md) | accepted | catalog behavior replaced by [ADR-0021](0021-split-catalog-structure-and-activity.md) |
| [0016: Enable hub management and interaction by default](0016-enable-hub-management-by-default.md) | accepted | — |
| [0017: Observe asynchronous management operations on the server](0017-observe-asynchronous-management-operations.md) | accepted | exit replaced by [ADR-0022](0022-separate-session-exit-from-archive.md); resume added by [ADR-0023](0023-separate-runtime-status-from-resume-permission.md) |
| [0018: Use V3 bindings and current pane validation](0018-cache-validation-per-binding-record.md) | accepted | commands now emit V4 (V3 readable); exit replaced by [ADR-0022](0022-separate-session-exit-from-archive.md); runtime extended by [ADR-0023](0023-separate-runtime-status-from-resume-permission.md) and [ADR-0024](0024-share-request-scoped-runtime-observations.md) |
| [0019: Enable automatic updates by default for unarchived sessions](0019-enable-automatic-updates-for-unarchived-sessions.md) | accepted | catalog refresh replaced by [ADR-0021](0021-split-catalog-structure-and-activity.md) |
| [0020: Use a unified project hub](0020-use-a-unified-project-hub.md) | accepted | navigation now stores expanded project IDs instead of collapsed IDs |
| [0021: Long-poll session structure with best-effort timestamps](0021-split-catalog-structure-and-activity.md) | accepted | runtime status added by [ADR-0023](0023-separate-runtime-status-from-resume-permission.md) |
| [0022: Separate session exit from archive](0022-separate-session-exit-from-archive.md) | accepted | — |
| [0023: Separate runtime status from resume permission](0023-separate-runtime-status-from-resume-permission.md) | accepted | reader observations refined by [ADR-0024](0024-share-request-scoped-runtime-observations.md) |
| [0024: Share runtime observations within each reader response](0024-share-request-scoped-runtime-observations.md) | accepted | — |

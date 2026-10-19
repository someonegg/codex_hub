# Architecture decisions

Records preserve their original decision context. Superseded behavior is historical;
use the [technical reference](../technical-reference.md) for current behavior.
Existing numbers, dates, statuses, and replacement links are retained.

| Decision | Status |
| --- | --- |
| [0001: Use generation-based whole-file session snapshots](0001-use-generation-based-session-snapshots.md) | superseded by ADR-0012 |
| [0002: Use JSONL-only session discovery](0002-use-jsonl-only-session-discovery.md) | accepted |
| [0003: Use session source adapters](0003-use-session-source-adapters.md) | accepted |
| [0004: Use session-scoped revisions for reader consistency](0004-use-session-scoped-reader-revisions.md) | superseded by ADR-0009 |
| [0005: Use query-scoped revisions for session-list pagination](0005-use-query-scoped-revisions-for-session-list-pagination.md) | superseded by ADR-0010 |
| [0006: Use conditional read cursors for session resources](0006-use-timeline-prefix-continuity.md) | superseded by ADR-0009 |
| [0007: Discover tmux interaction targets through adapters](0007-use-adapter-discovered-tmux-interaction.md) | superseded by ADR-0016 and ADR-0018 |
| [0008: Split the session catalog and reader into a multi-page application](0008-split-session-catalog-and-reader-into-an-mpa.md) | superseded by ADR-0020 |
| [0009: Use opaque single-writer timeline cursors](0009-use-opaque-single-writer-timeline-cursors.md) | accepted |
| [0010: Use opaque cursors for session-list pagination](0010-use-opaque-session-list-cursors.md) | superseded by ADR-0021 |
| [0011: Use repository-probed bounded long polling for automatic updates](0011-use-repository-probed-bounded-long-polling.md) | accepted |
| [0012: Use checkpointed incremental rollout loading with probe validation](0012-use-checkpointed-incremental-rollout-loading.md) | accepted |
| [0013: Filter session archive state in the browser](0013-filter-session-archive-state-in-the-browser.md) | superseded by ADR-0020 |
| [0014: Remember automatic updates per browser tab](0014-remember-automatic-updates-per-browser-tab.md) | superseded by ADR-0019 |
| [0015: Expose session index names as presentation metadata](0015-expose-session-index-names-as-presentation-metadata.md) | accepted |
| [0016: Enable hub management and interaction by default](0016-enable-hub-management-by-default.md) | accepted |
| [0017: Observe asynchronous management operations on the server](0017-observe-asynchronous-management-operations.md) | accepted |
| [0018: Use V3 bindings and current pane validation](0018-cache-validation-per-binding-record.md) | accepted |
| [0019: Enable automatic updates by default for unarchived sessions](0019-enable-automatic-updates-for-unarchived-sessions.md) | accepted |
| [0020: Use a unified project hub](0020-use-a-unified-project-hub.md) | accepted |
| [0021: Long-poll session structure with best-effort timestamps](0021-split-catalog-structure-and-activity.md) | accepted |
| [0022: Separate session exit from archive](0022-separate-session-exit-from-archive.md) | accepted |
| [0023: Separate runtime status from resume permission](0023-separate-runtime-status-from-resume-permission.md) | accepted |

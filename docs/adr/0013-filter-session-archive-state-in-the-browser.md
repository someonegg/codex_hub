---
status: superseded by ADR-0020
date: 2026-08-20
---

# Filter session archive state in the browser

## Context and Problem Statement

Archive state is presentation metadata already present on every session summary. Keeping it as a server query dimension made the API, project facets, pagination cursors, and client request lifecycle depend on a UI-only three-state control.

## Decision Drivers

- The sessions API should expose one catalog containing active and archived sessions.
- Changing the archive-state control should be immediate and should not restart pagination.
- Catalog loading must remain bounded for large session collections.

## Considered Options

- Keep archive state as a server-side query filter.
- Return mixed pages and incrementally filter accumulated sessions in the browser.
- Return mixed pages, eagerly load the complete catalog, and then filter in the browser.

## Decision Outcome

Chosen option: "Return mixed pages and incrementally filter accumulated sessions in the browser", because it removes presentation state from the API without forcing the browser to load every page.

`GET /api/v1/sessions` applies project and date filters but always includes active and archived sessions. Archive state is absent from the request contract, canonical cursor filters, and list revision. The browser defaults to All and filters the summaries accumulated so far. When a selected state has no match in the current pages, ordinary infinite scrolling continues until a match appears or pagination is exhausted.

### Positive Consequences

- One API query and cursor can back all three archive-state views.
- Switching archive state does not cancel, restart, or duplicate list requests.
- Large catalogs retain incremental network and memory costs.

### Negative Consequences

- Active and Archived counts describe only accumulated pages and may grow during pagination.
- A state-specific empty result is definitive only after pagination is exhausted.
- Project facet counts cover both archive states rather than the selected browser view.

## Pros and Cons of the Options

### Server-side archive-state filtering

- Good: Produces exact state-specific totals and pages.
- Bad: Couples a presentation control to the public query and pagination protocol.

### Incremental browser filtering

- Good: Removes archive state from the API while retaining bounded pagination.
- Bad: State-specific results and counts are incomplete until relevant pages load.

### Eager complete-catalog browser filtering

- Good: Produces complete state-specific results after loading finishes.
- Bad: Increases startup requests and memory in proportion to the entire catalog.

Superseded by the hub redesign; see [ADR-0020](0020-use-a-unified-project-hub.md).

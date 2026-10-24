---
status: superseded by ADR-0020
date: 2026-08-01
---

# Split the session catalog and reader into a multi-page application

Superseded by [ADR-0020](0020-use-a-unified-project-hub.md).

## Context and Problem Statement

The catalog and reader shared one React tree, URL state model, and combined hook even though they have independent loading and refresh lifecycles. Catalog refreshes could affect an open reader, direct reader URLs depended on SPA selection state, and browser refresh semantics were obscured by client-side navigation.

## Decision Drivers

- Give the catalog and a single-session reader independent state and failure boundaries.
- Make direct access and browser refresh of `/sessions/:id` ordinary document navigation.
- Preserve catalog filters when returning from a reader without retaining the catalog React tree.
- Avoid adding a router dependency for two pages.

## Considered Options

- Keep one SPA and refine the combined browser hook.
- Keep one JavaScript entry and conditionally render by pathname.
- Use two HTML and React entries in a Vite multi-page application.

## Decision Outcome

Chosen option: "Use two HTML and React entries in a Vite multi-page application", because the document boundary matches the independent ownership and refresh semantics of the two screens.

The catalog is served at `/`; each session link opens `/sessions/:id` in a new browsing context so the catalog remains available. The development and production servers map valid session paths to the reader HTML entry. Shared components, styles, domain types, and the API client remain common. Catalog filters are persisted in `sessionStorage`, while timeline visibility and automatic updates are kept only in the current reader page's in-memory state.

The automatic update preference lifecycle was later refined by [ADR-0014](0014-remember-automatic-updates-per-browser-tab.md).

### Positive Consequences

- Direct reader links and full-page refreshes have explicit, testable behavior.
- Catalog refresh and reader polling cannot mutate each other's state.
- The two pages can evolve their loading and error handling independently.
- No SPA router or route synchronization layer is required.

### Negative Consequences

- Navigating between catalog and reader reloads JavaScript and discards loaded pages and expanded details.
- Vite and the production HTTP server must maintain the same document-route mapping.
- Shared client code may be emitted into common chunks, but each page still has its own bootstrap entry.

## Pros and Cons of the Options

### One SPA with a combined hook

- Good: Preserves all transient UI state while selecting sessions.
- Bad: Keeps catalog and reader request lifecycles coupled and makes refresh semantics implicit.

### One entry with pathname branching

- Good: Requires only one HTML document.
- Bad: Retains a shared bootstrap and makes page ownership less explicit without gaining SPA navigation.

### Two-entry MPA

- Good: Aligns URL documents, React roots, and state ownership.
- Bad: Accepts full navigation cost and requires two build inputs.

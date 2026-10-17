---
status: accepted
date: 2026-10-16
---

# Use a unified project hub

## Context and Problem Statement

Separate catalog and reader pages split navigation, reading, and management,
requiring cross-document state restoration. The requested workflow places a
project/main-session sidebar beside the conversation.

## Decision Drivers

- Preserve direct URLs, refresh, and browser back/forward without a routing dependency.
- Restore project expansion, archive filtering, and scroll position.
- Show unarchived main sessions by default; reach children from the conversation.

## Considered Options

- Separate catalog and reader pages in an MPA.
- A single HTML/React entry point with History API navigation.

## Decision Outcome

Use one entry point. Development and production map `/` and `/sessions/:id` to
the same HTML; History API handles selection and browser navigation. The catalog
stays mounted while the reader lifecycle follows session ID. CSS owns the single
column transition below 768px.

Tab storage contains only `includeArchived`, `collapsed`, and `scroll`; remove
the old filter format without migration. Archived sessions support direct access
and stay open after archive. The sidebar shows main sessions matching the archive
filter, also used by direct child links. Unknown projects without a directory
have no creation entry point.

### Positive Consequences

- Reading and management retain project context.
- One hub supports wide/narrow screens and stable links.

### Negative Consequences

- Catalog and reader need independent cancellation and navigation restoration.
- Client and server must both validate direct access and browser navigation.

## Pros and Cons of the Options

### Separate pages in an MPA

- Good: Document boundaries isolate catalog and reader lifecycles.
- Bad: Shared-screen navigation and return-state restoration are difficult.

### Single entry point with History API

- Good: Retains catalog state and supports a shared-screen hub.
- Bad: Requires synchronization between client URL and selection state.

---
status: accepted
date: 2026-08-07
---

# Use repository-probed bounded long polling for Live updates

## Context and Problem Statement

The session reader needs to observe timeline appends, public session metadata, and effective interaction state without issuing fixed-interval browser refreshes. Changes are discovered through immutable repository snapshots, while the opaque timeline cursor must remain the sole mechanism that confirms and advances a loaded timeline prefix.

## Decision Drivers

- Live updates must preserve the existing timeline-prefix conflict guarantees.
- One response must describe session and interaction state derived from one repository probe.
- Waiting requests and external interaction checks must have explicit resource bounds.
- The browser must be able to cancel work when Live is disabled, hidden, switched, conflicted, or unmounted.
- The design should reuse repository freshness and refresh coalescing rather than add another source-observation path.

## Considered Options

- Repository-probed bounded HTTP long polling.
- Continue fixed-interval browser polling of the items endpoint.
- Server-Sent Events driven by repository or filesystem observation.
- WebSockets with a server-side subscription protocol.
- Filesystem watchers that push rollout changes directly to clients.

## Decision Outcome

Chosen option: "Repository-probed bounded HTTP long polling", because it removes client refresh intervals while reusing immutable repository snapshots, ordinary HTTP cancellation, and the existing opaque timeline cursor validation.

`GET /api/v1/sessions/:id/live` validates a cursor but never returns timeline items or advances it. A process-private HMAC revision covers the complete public session state and effective interaction response. The service probes immediately, then every 1.5 seconds for at most 25 seconds; it returns `200` when the revision changes or items exist after the cursor, and `204` when the wait expires unchanged. The browser loads reported backlog through the ordinary items endpoint.

Waiting requests are limited to 100 per process and 10 per session. Interaction connection descriptions use a 1.5-second cache that coalesces concurrent promises, while mutation operations retain their real-time validation. Client disconnect, server shutdown, and abort signals release waiters immediately.

Composition creates shared tmux transport, catalog polling, Live, and operation
tracking services; interaction explicitly receives transport. The API router
receives business services without creating or closing them. Composition exposes
idempotent `close()`, called by the HTTP server before it stops accepting and
waits for existing connections, releasing long polls and operation tracking.
Construction/listen failures also release resources. Entry points share the same
services; polling intervals, capacity, and tmux protocol remain unchanged.
Diagnostics stay in server logs, outside public session state and Live revisions.

### Positive Consequences

- An unchanged visible session normally holds one request instead of repeatedly transferring empty item pages.
- Timeline continuity remains owned by the existing cursor and items endpoint.
- Metadata-only and interaction-only changes can update without fabricating timeline progress.
- Request duration, waiter counts, interaction probes, and client retries are bounded.
- Existing HTTP infrastructure works without a persistent bidirectional protocol.

### Negative Consequences

- Each active waiter still causes periodic repository probes and holds an HTTP connection.
- Change notification latency is bounded by the 1.5-second probe interval rather than being event-driven.
- Process-local revisions change after restart and are comparison tokens only, not durable versions or authorization credentials.
- Capacity rejection and transient failures require client-side jittered exponential backoff.
- The implementation adds cancellation, compare-and-set, and stale-response handling on both sides of the API.

## Pros and Cons of the Options

### Repository-probed bounded HTTP long polling

- Good: Reuses snapshot freshness, cursor validation, HTTP cancellation, and deployment behavior.
- Good: Bounds request lifetime and waiter resources without a new subscription registry.
- Bad: Retains periodic server-side probing and long-lived HTTP requests.

### Fixed-interval browser polling of items

- Good: Has the smallest protocol surface and no waiting-request accounting.
- Bad: Repeatedly transfers empty pages, exposes interval tuning in the UI, and couples change detection to cursor advancement reads.

### Server-Sent Events

- Good: Supports a one-way stream and could reduce repeated HTTP setup.
- Bad: Requires event lifecycle, reconnect position, buffering, and an independent mechanism that discovers repository changes.

### WebSockets

- Good: Supports bidirectional subscriptions and low-latency delivery.
- Bad: Adds connection state, heartbeat, backpressure, and authorization complexity beyond the reader's one-way notification need.

### Filesystem watchers

- Good: Could react quickly to rollout file events.
- Bad: Platform event semantics do not by themselves provide normalized snapshot atomicity, prefix validation, or reliable recovery from missed events.

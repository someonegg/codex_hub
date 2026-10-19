---
status: accepted
date: 2026-07-30
---

# Use session source adapters

## Context and Problem Statement

The reader's normalized session domain, generation snapshot, and HTTP DTOs are intended to remain stable while Codex directory layouts and rollout formats evolve and while other agents are added. The repository previously orchestrated Codex-specific discovery, decoding, identity resolution, normalization, file fingerprints, and I/O recovery, so adding a source required coupling generic snapshot code to that source's storage model.

## Decision Drivers

- Isolate agent-specific directory, format, parsing, and cache behavior.
- Aggregate multiple source instances without native session-ID collisions.
- Preserve generation-scoped lists and bounded detail APIs.
- Keep source paths and configuration identities out of HTTP responses.

## Considered Options

- Keep the repository-level discover/decode/identity/normalize pipeline.
- Introduce high-level session source adapters that return normalized entries.
- Generalize raw event records and parse every agent through one shared decoder.

## Decision Outcome

Chosen option: "Introduce high-level session source adapters that return normalized entries", because each adapter can own its unstable storage compatibility surface while the repository consumes one source-neutral contract.

Each source instance has a private stable instance key and a public opaque instance ID. Adapters return source-local stable session identities, native parent identities, normalized session content, a source signature, and diagnostics. The aggregate snapshot generates global opaque IDs from the source instance key and local identity, links parents only within a source instance, and publishes one immutable generation.

Within a Codex source instance, a native session ID always determines the stable
local identity. If multiple rollouts declare that ID, retain the previously
accepted readable file; on first discovery choose the first readable file in the
existing path order. Ignore the others: publish no additional session, submit no
binding events, and retain no decode cache for them. Report duplicates only in
server diagnostics, deduplicated by the diagnostic logger. If the retained file
becomes unavailable, fully read the first remaining candidate. Rollouts without
a native ID retain their path-based identity.

Every normalized value returned by an adapter is a published immutable snapshot. An adapter must not mutate a previously returned `NormalizedSession`, timeline item, detail value, map, or other nested value in place when its source changes or a later refresh completes. It must instead publish new values for the changed path so earlier repository generations remain coherent.

Adapters may preserve references for unchanged normalized sessions, timeline items, and tool or directive details. The repository treats such reference reuse only as an optimization hint: a reused reference must mean that value is unchanged, while a fresh reference may still contain equivalent content and remains valid at the cost of recomputing derived state. This permits copy-on-write adapters to extend timeline-prefix indexes cheaply without making reference reuse mandatory for other adapter implementations.

Source registration requires nonempty, independently unique `instanceKey` and
`sourceInstanceId`; conflicts fail construction. Adapters use server domain types.
Item IDs are opaque, with no required naming pattern. HTTP splits path segments
before decoding once, requires nonempty IDs of at most 1,024 UTF-8 bytes, and
rejects control characters, slashes, backslashes, and standalone `.` or `..`.
Queries still validate kind, session ownership, cursor signatures, and read bounds.

Diagnostics belong only in server logs, not public `SessionDetail`, the UI,
management decisions, or update revisions. Refresh reports source, session, and
aggregate diagnostics through an injectable port defaulting to stderr. Deduplicate
by source, session, and content; cleared diagnostics may recur, and vanished
objects release state. Reuse unchanged snapshots and diagnostic references;
cache hits do not traverse or serialize diagnostics. Logging failures do not
interrupt operations. Apply per-source limits so aggregate truncation cannot
hide other sources.

Path checks, scanning, and rollout loading treat `ENOENT`, `EACCES`, `EPERM`,
`ESTALE`, `EISDIR`, and `ENOTDIR` as recoverable I/O errors: skip and diagnose
unreadable portions while serving the rest. Initially absent allowed directories
are normal. Scope and symlink restrictions remain; unexpected exceptions propagate.
Successful snapshots carry no completeness gate.

### Positive Consequences

- New agents can be added without teaching the repository their files or formats.
- Native IDs from different agents or installations cannot collide.
- Sessions with a stable native ID retain their hub ID when their source resource moves.
- Source-specific caching and recovery policies can evolve independently.
- Immutable snapshots keep earlier repository generations coherent, while optional reference reuse enables cheap incremental derivation.

### Negative Consequences

- Adapters have a larger contract and must normalize identity and operational failures correctly.
- Adapter implementations must use immutable publication rather than mutating previously returned values in place.
- Source-local identity mistakes can still cause unstable IDs, so contract tests are required.
- Cross-source parent relationships are intentionally unsupported.
- The initial ID migration invalidates path-derived session URLs.
- Diagnostics no longer appear in the UI; inspect server stderr for partial read
  failures. Release client and server together without a legacy diagnostic-field
  compatibility layer.

## Pros and Cons of the Options

### Repository-level parsing pipeline

- Good: Uses the existing small interfaces and centralizes refresh behavior.
- Bad: Assumes every source has Codex-like files, decoding stages, and fingerprints.

### High-level session source adapters

- Good: Places unstable storage and parser details behind one boundary.
- Good: Allows one snapshot to merge independently implemented sources.
- Bad: Moves cache and recovery logic into each adapter.

### Shared raw event decoder

- Good: Could reuse normalization when agents expose closely related event schemas.
- Bad: Creates a lowest-common-denominator raw model and leaks format evolution into the shared core.

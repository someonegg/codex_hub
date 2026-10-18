---
status: accepted
date: 2026-08-08
---

# Use checkpointed incremental rollout loading with probe validation

## Context and Problem Statement

Codex rollout files are append-heavy JSONL streams, but the generation-based source rereads and renormalizes an entire changed file. Large active sessions therefore make each refresh proportional to historical size. Incremental state must preserve incomplete-tail, malformed-line, diagnostic, tool-pairing, atomic snapshot, paging, and cursor semantics while safely recovering from truncation or replacement.

## Decision Drivers

- Make ordinary append refresh work proportional to the uncommitted tail and new bytes.
- Preserve existing HTTP, cursor, normalized-domain, diagnostic, and JSONL filtering behavior.
- Detect common replacement or historical-edit cases without rereading the entire prefix.
- Keep every published source and repository generation immutable and recover through a whole-file rebuild.
- Avoid coupling the generic repository to JSONL offsets or file validation.

## Considered Options

- Continue rereading and deriving the entire changed rollout.
- Hash and validate the complete historical prefix before each append.
- Validate two bounded probes, incrementally decode and derive appended records, and rebuild the whole file on validation failure.

## Decision Outcome

Chosen option: "Validate two bounded probes, incrementally decode and derive appended records, and rebuild the whole file on validation failure", because it removes historical-size I/O from ordinary append refreshes while keeping a simple recovery path and unchanged public contracts.

Each in-memory rollout checkpoint stores the observed EOF, the byte position after the last committed newline, the consumed physical-line count, decoder diagnostics and version, normalizer version, and SHA-256 probes for the first 4 KiB and up to 4 KiB immediately before the old EOF. A strictly growing file may use the append path only when both probes and versions match. The decoder re-reads from the committed newline through the EOF observed on one open file handle, so an unfinished tail becomes visible once terminated and is committed once. Truncation, non-growth changes, probe mismatch, incompatible state, or derivation uncertainty triggers a full rebuild.

Identity and normalization use copy-on-write accumulators and publish only after the complete source snapshot succeeds. The repository extends an HMAC timeline prefix only when the old timeline is a reference prefix and all old encoded tool/directive detail references remain unchanged. Whole-file rebuilding, atomic generations, timeline paging, and existing cursor conflict behavior remain supported.

### Positive Consequences

- Normal append reads and decodes only two probes, the unfinished tail, and appended bytes.
- Tool output and user-input responses can pair with calls or requests from earlier refreshes.
- Previously issued timeline cursors remain valid across pure append without changing the protocol.
- Parser or normalizer version changes, truncation, and common replacements recover automatically through full rebuild.
- Restart behavior remains simple because checkpoints are process-local and disposable.

### Negative Consequences

- Two 4 KiB probes are heuristic, not a proof that every historical byte is unchanged; a middle rewrite that preserves both probe regions and then appends may be missed.
- Decoder, identity, normalization, and prefix derivation now maintain versioned copy-on-write state and require more boundary tests.
- An unfinished oversized line may be reread on every refresh until its newline arrives.
- A process restart still requires a complete decode and derivation.

## Pros and Cons of the Options

### Continue whole-file changed-rollout reads

- Good: Has the smallest state machine and treats every observed change uniformly.
- Good: Cannot miss a historical edit in a file that is reread.
- Bad: Refresh I/O, JSON parsing, and normalization grow with the entire active session.
- Bad: Repeated small appends regenerate stable timeline and prefix work.

### Validate the complete historical prefix before append

- Good: Proves the cached prefix still matches the file before consuming new bytes.
- Good: Retains incremental JSON parsing and normalization after validation.
- Bad: Validation I/O remains proportional to historical file size, defeating the primary append-read objective.
- Bad: Adds state complexity without removing the dominant large-file read.

### Validate bounded probes and incrementally derive

- Good: Bounds normal validation I/O while preserving a whole-file fallback.
- Good: Keeps offsets and file probes inside the Codex adapter.
- Good: Allows stable normalized objects and repository prefix slots to be reused.
- Bad: Accepts the documented possibility of an undetected middle rewrite.
- Bad: Requires explicit decoder and normalizer version invalidation.

## Archived rollout scope update, 2026-10-18

This policy now applies to unarchived rollouts. Successfully loaded archives reuse
cached content; directory discovery is unchanged. See the
[cache rules](../technical-reference.md) for details.

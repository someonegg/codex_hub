# Second-batch coverage ownership

This audit compares against the supplied baseline of 855 regular tests and 13
integration tests, including the first batch's staged changes. It records removed
upper-layer execution, not a claim that every migration reduces test count.

## CLI and HTTP

- **Session CLI invalid-argument subprocess matrix:**
  `session-cli.test.ts` now calls `parseSessionArguments` in
  `rejects invalid session arguments: %j`.
  `wires invalid arguments without requests (json=%s)` retains exit status,
  output streams, and zero requests. Existing success tests retain URL, payload,
  lifecycle, and output wiring.
- **Resource CLI syntax and option subprocess matrices:**
  `resource-cli.test.ts` retains direct validation in
  `rejects invalid resource arguments: %s %s %j`,
  `rejects inapplicable options: %j`, and
  `parses publication options and requires a project for pages`.
  `wires resource errors to the correct stream (json=%s)` owns output streams;
  `accepts legal %s options through publish, list and delete` retains storage wiring.
- **Resource CLI invalid diff ID:** `diff.test.ts` retains invalid UUID deletion in
  `publishes independent snapshots offline and serializes concurrent writes and idempotent deletion`.
- **Resource CLI directory-as-diff and blank page name:**
  `diff.test.ts`: `rejects a directory as the diff source`;
  `hosting.test.ts`: `rejects a blank artifact name`.
- **Resource CLI help subprocess:** `resource-cli.test.ts` directly checks the short
  circuit in `preserves help before checking inapplicable options`. This case no
  longer asserts the printed help text or its output stream.
- **Update HTTP invalid-query matrix and malformed revision:**
  `session-updates-http.test.ts` checks `parseUpdatesQuery`, exception type, and
  message in `preserves query validation for %s`; its return value is checked by
  `parses valid updates without applying adapter identity rules`.
  Existing HTTP tests retain 200/204/400/404, HEAD, no-store, capacity, and
  disconnect cleanup.
- **Interaction HTTP body boundaries and idle-option failures:**
  `interaction-body.test.ts` owns message structure and byte boundaries, supported
  keys, sequence bounds, idle requirements, and validation precedence.
  `interaction-http.test.ts` retains both 400 error codes and zero service calls in
  `maps body and message validation failures without invoking interaction`.
  Existing success tests retain optional idle argument forwarding.

The resource store cases no longer independently assert CLI error serialization;
CLI error stream wiring remains covered separately. No input acceptance rule was
dropped. CLI and HTTP validators remain within their owning layers.

## Hooks and pages

| Removed page test                                                                          | Retained direct Hook test                                                                                                         |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `reconnects immediately after consecutive 204 responses`                                   | `use-session-updates.test.tsx`: `reconnects immediately after consecutive empty updates`                                          |
| `backs off retryable failures and stops on terminal 4xx responses`                         | `use-session-updates.test.tsx`: `retries at the backoff boundary and stops on terminal errors`                                    |
| `aborts while hidden and resumes immediately when visible`                                 | `use-session-updates.test.tsx`: `pauses hidden requests and resumes when visible`                                                 |
| `discards an old automatic updates response after manual pagination advances the snapshot` | `use-session-reader.test.tsx`: `ignores obsolete updates %s after pagination advances the snapshot`, for late success and failure |
| `backs off retryable automatic timeline page failures`                                     | `use-session-reader.test.tsx`: `retries pagination at the boundary using the original cursor`                                     |
| `stops automatic timeline pagination on a terminal page error`                             | `use-session-reader.test.tsx`: `stops pagination retries on a terminal error while preserving loaded data`                        |

Additional direct Hook tests cover late success/failure after snapshot replacement
or refresh and cancellation during retry. `request-lifecycle.test.tsx` continues
to own the generic request-ticket contract. Page tests retain initial loading,
scroll-triggered pagination, displayed errors and retry controls, archived-session
behavior, drafts, conflict presentation, metadata rendering, and preview expansion.

## Queries, services, and decoding

- Replaced service test `defaults to 100 items, supports 300, and rejects limits
above 300` with `session-queries.test.ts`: `defaults to 100 items and accepts the
maximum page length` and `rejects invalid item limit %s`.
- Replaced service test `fills byte-bounded pages and reads every long message
exactly once` with `session-queries.test.ts`: `fills byte-bounded pages and reads
every long UTF-8 message exactly once`. The existing oversized-item test remains.
- The service now uses `maps public identity and passes cursors across consecutive
reads` as its small composition check. Snapshot coordination, session isolation,
  archive moves, runtime status, recovery, and captured-snapshot tests remain.
- Decoder/normalizer tests retain parsing and truncated-tail rules. The service's
  `does not revise a session until an appended JSONL tail is terminated` remains
  the publication contract; no tail-line coverage was deleted in this batch.

## Validation and counts

Regular suite: **881 passed**, no skipped or pending tests. Integration collection:
**13**, without running native integration tests. Total: **894**, a net **increase
of 26**, leaving **195** above 699. The final pruning removed nine redundant
parameterized cases from the second-batch total of 890 regular tests. Added direct boundary and race tests outweigh
removed duplicate cases; the count-reduction objective is not achieved this batch.
Type checking, Prettier, and staged/unstaged diff checks pass. Production UI and
adapter/tmux execution paths are unchanged.

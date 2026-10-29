# Session JSONL filtering rules

This is the canonical reference for converting Codex rollout records into timeline
items. The rules cover four concerns:

1. **Decode:** read complete JSONL lines and skip invalid input.
2. **Normalize:** map records to timeline items and lazy details.
3. **Display:** apply browser visibility preferences without changing server items.
4. **Bound:** cap text and page sizes while preserving paging progress.

| Responsibility             | Implementation                                                       |
| -------------------------- | -------------------------------------------------------------------- |
| Decoding and normalization | [Codex adapter](../src/server/adapters/codex/)                       |
| Paging                     | [session-queries.ts](../src/server/repository/session-queries.ts)    |
| Client visibility          | [timeline-visibility.ts](../src/client/state/timeline-visibility.ts) |

For endpoint and cursor contracts, see the [reader reference](technical-reference.md#reader-and-automatic-updates).

## Decode-time skips

### Loading and checkpoints

Archived rollouts are decoded once per cache lifetime; see
[discovery and caching](technical-reference.md#discovery-and-caching).

Only complete lines are committed. Unterminated tails, including partial UTF-8
and oversized lines, are reread without decoding or diagnostics until terminated.
For checkpoint probes, fallback rules, and their limits, see
[discovery and caching](technical-reference.md#discovery-and-caching).

### Invalid input and diagnostics

| Input                                     | Result                 |
| ----------------------------------------- | ---------------------- |
| Empty line                                | Ignore                 |
| Malformed JSON or a non-object JSON value | Skip with a diagnostic |
| Line larger than 8 MiB                    | Skip with a diagnostic |
| Record without a usable type              | Diagnostic             |

Each session retains at most 50 diagnostics. Decoder diagnostics take priority;
remaining slots contain normalizer diagnostics in production order. Further
diagnostics are silently discarded. Diagnostics remain in server logs, not public
timeline responses.

## Record normalization

### Record-to-item mapping

| Record                                         | Timeline result                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `session_meta`                                 | Metadata only; no timeline item                                       |
| `turn_context`                                 | `internal`; decoded JSON available through lazy detail                |
| `response_item` message                        | `directive` for accepted roles and text parts                         |
| `user_message` / `agent_message` event         | User / assistant `message` when `message` is a non-empty string       |
| `item_completed` event                         | `message` only for the allowlisted shapes below; otherwise `internal` |
| `token_count` event                            | `token`                                                               |
| Reasoning response                             | `internal` with event type `reasoning`                                |
| Recognized tool call or output                 | Separate append-stable `tool` item                                    |
| `request_user_input` call or recognized output | Separate append-stable `user_input` item                              |
| Other typed record                             | Safe `internal` event type                                            |

Response and event records are retained independently; normalization does not
match or remove duplicates. Internal compatibility summaries always use
`Internal event: <eventType>`; reasoning summaries are not semantically parsed.

### Messages and directives

Response messages accept only roles `user`, `assistant`, and `developer`, and
content parts `input_text`, `output_text`, and `text`. Messages without accepted
text are dropped; accepted messages become directives.

Legacy `user_message` and `agent_message` events with an invalid `message` become
safe internal summaries of their event type.

For `item_completed`, only these item shapes become conversation messages:

| Item type      | Accepted text                  | Message                                         |
| -------------- | ------------------------------ | ----------------------------------------------- |
| `UserMessage`  | Non-empty `text` content parts | User                                            |
| `AgentMessage` | Non-empty `Text` content parts | Assistant                                       |
| `Plan`         | Non-empty `item.text`          | Assistant, phase `response`, `itemType: "Plan"` |

Joined content parts are separated by a blank line. `AgentMessage` phases `final`
and `final_answer` normalize to `response`; `commentary` normalizes to `update`. Only `Plan`
publishes its item type; user and agent messages leave `itemType` unset.

Empty, non-text, and other completed items become internal events labeled
`item_completed.<subtype>` when the subtype is usable.

### Tools, user input, and tokens

- **Tools:** an output links to its preceding call by `call_id` during the same
  forward scan. Calls and outputs remain separate items.
- **User input:** requests retain questions and options. Outputs retain exact
  answers, an aborted outcome, or a safe unavailable fallback for unrecognized
  shapes. Calls and recognized outputs link by `call_id`.
- **Tokens:** retain only non-negative integer counters in `total_token_usage`
  and `last_token_usage`. Missing groups are unavailable; rate limits and unknown
  payload fields are discarded.

## Client visibility

### Defaults and preferences

Server pages include every normalized item kind. Browser filters control display:

| Item kind                                | Default visibility            |
| ---------------------------------------- | ----------------------------- |
| User / assistant `message`, `user_input` | Always shown                  |
| `directive`, `tool`, `token`, `internal` | Hidden; independently enabled |

Changing filters requires no timeline reload and never changes page cursors.
Preferences use `sessionStorage`, shared across sessions visited in the same tab,
with an in-memory fallback when storage is unavailable.

### Display rules

- **Internal events:** show only the event type until JSON detail is requested.
- **Directives:** up to 512 JavaScript code units appear as literal plain-text
  blocks; longer directives load details on demand.
- **Duplicate inline directives:** hide an inline directive if a message with
  exactly the same text occurs among the two preceding or two following loaded
  items. Matching uses the unfiltered timeline, so visibility settings do not
  change the neighborhood.
- **User input cards:** merge loaded requests and responses by `call_id`. Show
  waiting status until the output loads, then exact answers or an aborted state
  beside the original options. Server items and cursors remain unchanged.

## Truncation and paging

Truncation shortens text while retaining the item. Limits use JavaScript code
units unless a byte unit is specified.

| Content                                                         | Limit                                            |
| --------------------------------------------------------------- | ------------------------------------------------ |
| Message text                                                    | 1,000,000 code units                             |
| Directive detail, tool detail, formatted internal JSON          | 256,000 code units each                          |
| Directive summary, unavailable-user-input summary, tool preview | 256 code units each                              |
| Timeline page                                                   | 100 items by default; `limit` accepts 1–300      |
| Serialized item array                                           | Approximately 4 MiB, excluding response metadata |

The page budget may defer items to the next page. The first item is always
included, even if it exceeds the budget, to guarantee forward progress.
Client filtering never changes paging boundaries. Terminal capture has separate
[preview limits](technical-reference.md#terminal-preview).

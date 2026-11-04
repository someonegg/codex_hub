# Session JSONL processing

The [Codex adapter](../src/server/adapters/codex/) decodes complete JSONL lines
and publishes only conversation messages and user input. See the
[technical reference](technical-reference.md#reader-and-automatic-updates) for
pagination and long polling, and [loading guarantees](technical-reference.md#discovery-and-caching)
for checkpoints, probe validation, and archive caching.

## Decode and normalize

Empty lines are ignored. Malformed JSON, non-object records, and lines above
8 MiB produce bounded diagnostics. Unterminated tails are reread after the next
append. At most 50 diagnostics are retained per session, decoder diagnostics
first; diagnostics appear in logs only.

`user_message` and `agent_message` events publish nonempty message text.
Completed `UserMessage` accepts `text` parts; `AgentMessage` accepts `Text` parts;
`Plan` accepts `item.text` and publishes an assistant response with `itemType: plan`.
Parts join with blank lines. `commentary` maps to `update`; `final` and
`final_answer` map to `response`. Other phases remain null.

`request_user_input` calls retain questions/options; matched outputs retain exact
answers, an aborted result, or a safe unavailable fallback. Matching by `call_id`
continues across incremental batches. Browser cards combine loaded requests and
responses; API records retain their original ordinals.

Other records do not produce timeline items or detail maps. Raw parsing needed
for metadata, relationships, pane bindings, and runtime state remains adapter-owned.

## Bounds

Message text is capped at 1,000,000 JavaScript code units; unavailable answer
summaries at 256. Truncation avoids splitting surrogate pairs. Ordinals retain
raw adapter positions, including gaps; visible messages are never renumbered.

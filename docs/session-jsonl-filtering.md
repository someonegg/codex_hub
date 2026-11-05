# Session JSONL processing

The [Codex](../src/server/adapters/codex/) and
[Claude Code](../src/server/adapters/claude/) adapters decode complete JSONL lines
and publish only conversation messages and user input. Metadata, relationships,
pane bindings, and runtime facts are extracted independently of conversation
publication. See the [technical reference](technical-reference.md#reader-and-automatic-updates)
for pagination and long polling, and [loading guarantees](technical-reference.md#discovery-and-caching)
for checkpoints, probe validation, and archive caching.

## Shared decoding and limits

Empty lines are ignored. Malformed JSON, non-object records, and lines above
8 MiB produce bounded diagnostics. Only newline-terminated records commit;
unterminated tails are reread after the next append. Decoder ordinals count
physical lines.

Message text is capped at 1,000,000 UTF-16 code units. Truncation avoids splitting
surrogate pairs.

Both adapters retain at most 50 diagnostics per session, with decoder diagnostics
taking priority over separately retained normalizer diagnostics. Final source
diagnostics are also capped at 50 while valid files continue to be processed. Identity
conflicts remain explicit state even when diagnostics are full. Diagnostics
appear in logs only.

## Codex

`user_message` and `agent_message` events publish nonempty message text.
Completed `UserMessage` accepts `text` parts; `AgentMessage` accepts `Text` parts;
`Plan` accepts `item.text` and publishes an assistant response with `itemType: plan`.
Parts join with blank lines. `commentary` maps to `update`; `final` and
`final_answer` map to `response`. Other phases remain null.

`request_user_input` calls retain questions/options; matched outputs retain exact
answers, an aborted result, or a safe unavailable fallback. Matching by `call_id`
continues across incremental batches. Unavailable answer summaries are capped at
256 UTF-16 code units. Browser cards combine loaded requests and responses; API
records retain their original ordinals.

Ordinals retain raw adapter positions, including gaps; visible messages are never
renumbered.

## Claude Code

Main records with sidechain/subagent provenance, API copies, thinking, ordinary
tool calls/results, local commands, interruption notices and shell wrappers are
excluded from conversation output. Ordinary assistant text is retained regardless
of model. Each complete JSONL line is processed independently without message-ID
aggregation; block order determines consecutive item ordinals/IDs starting at 1.
`parentUuid` is a message link, never a parent session.

Assistant phase uses only that row's `message.stop_reason`: `tool_use` → `update`,
`end_turn` → `response`, all other values → `null`. `ExitPlanMode.input.plan`
produces an assistant plan response; external plan files are never read.
`AskUserQuestion` emits independent request/result items keyed by tool call ID,
with question IDs `<callId>:<index>`. Structured answers take precedence; explicit
rejection is `aborted`, uninterpretable results are `unavailable`. No approval UI,
permission-mode, annotations or multi-select domain fields are synthesized.

Project association uses valid V1/V2 shell binding metadata, otherwise the first
valid cwd; execution uses the latest valid cwd.

Titles prefer the latest nonempty
`custom-title`, then `ai-title`, then first ordinary user text; otherwise the title is
`Untitled session`, matching Codex. Explicit titles use the first nonempty trimmed
line and an 80-character limit; user titles share Markdown heading extraction.

`agent-name` does not supply a task name. Only main native user `<bash-stdout>`
wrappers can claim a pane; API copies, ordinary quoted prose and tool results cannot.

See the native [stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
for assistant phase inputs.

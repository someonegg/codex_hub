---
name: ahub-control
description: Manage agent sessions through an existing Agent Hub using ahub-cli session. Use only when the user explicitly requests `ahub-control` by name.
---

# Coordinate sessions through Agent Hub

The CLI reports runtime state, replies, input requests, and diagnostics. The caller verifies deliverables and decides whether the task is complete. Create, control, or clean up only sessions within the authorized task scope.

## Check the environment and target

- Check `command -v ahub-cli` and `ahub-cli session --help` for the commands and options needed by the task. Report missing capabilities; install, update, or start services only when authorized.
- Address precedence is `--url`, `AGENT_HUB_URL`, then `http://127.0.0.1:4173`. Keep custom addresses consistent across commands.
- HTTP and HTTPS origins are supported. HTTPS uses Node.js certificate verification; for a private CA, set `NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem` before starting the CLI.
- Select existing sessions with `list --project /absolute/project --json`. It lists main sessions. Known child IDs can be inspected directly. Treat IDs as opaque strings.

## Resolve projects and agents before creation

- For an absolute project path, verify that it exists as a directory and use it directly, even if it is not in the known project list. Otherwise, ask for the correct path; do not fall back to name matching.
- For a non-absolute project value, run `ahub-cli project list --json` and match its directory name (for example `agent_hub`) against known project directory names. Use the known absolute path only for a unique match. Resolve this in the skill before invoking create, not against the current working directory.
- For multiple project matches, show the candidate absolute paths and ask the user to choose. For no match, show the known project list and ask for the correct path. Do not pass an unresolved relative path to create.
- Omit `--agent` to use Hub's default Agent. If the user specifies an agent, run `ahub-cli agent list --json` and match known nicknames and runtime names. Pass the nickname with `--agent` only for a unique match; otherwise show the matching or available agents and ask the user to choose.

## Suggested assignment framing

Give the worker agent a concise brief:

- **Goal:** the problem and desired result.
- **Context:** relevant background, decisions, and references.
- **Constraints:** scope, compatibility, authorization boundaries, and fixed choices; distinguish requirements from suggestions.
- **Deliverables:** expected artifacts or changes, their destination, and validation evidence.
- **Acceptance criteria:** observable conditions for completion and quality.

Describe specifications rather than prescribed steps or file-by-file edits. Trust the agent to investigate and plan the implementation; include implementation guidance only when a known constraint requires it.

## Create, resume, and send

- `create --project <directory>` sets project association and the default launch directory. Add `--cwd <directory>` to change the launch location while retaining the project association.
- Add `--task <name>` when creating a session to assign an optional task name. Use `list --task <name>` to find matching sessions across projects.
- Creation accepts `--agent <nickname>`, defaulting to the first configured Agent. Use `--worktree` and `--yolo` as authorized launch options, not universal defaults.
- `resume <id>` retains the original Agent and uses an available original working or project directory. It accepts `--yolo` but no directory overrides.
- Successful create/resume means the session was observed live, connected, and idle. Save `sessionId` and `tmux` (`socketPath`, `sessionName`); diagnostics may be null.
- Before sending, inspect and follow `nextAfter` until `hasMore=false`. Save the final `nextAfter` as the turn's baseline, then observe new replies from that position.
- Consider the framing above when sending an assignment. Prefer `--stdin` from a file or pipe for long messages to avoid shell interpolation and quoting errors. `sent` confirms delivery only.

Replace the example IDs, positions, and paths with actual values:

```bash
# For non-absolute project values only, resolve to a unique known absolute path:
ahub-cli project list --json
# Only for a user-specified agent, resolve before adding --agent <nickname>:
# ahub-cli agent list --json
ahub-cli session create --project /absolute/project --json
# Save sessionId; add --cwd /absolute/working-directory if needed.

ahub-cli session inspect SESSION_ID --json
# If hasMore, continue with --after <nextAfter>; save the final nextAfter as BASELINE.

ahub-cli session send SESSION_ID --stdin --json < /absolute/task.txt
ahub-cli session inspect SESSION_ID --after BASELINE --follow --count 10 --json
# Retain the latest nextAfter. Continue observing, respond, or verify deliverables.

# After verifying deliverables, if the user requested session exit:
ahub-cli session exit SESSION_ID --json
```

## Observe replies and input requests

- Prefer `--json`. Single inspection returns one object; follow emits NDJSON. Parse each line independently as a result or `error` object. Text follow emits separate blocks.
- Without `--after`, inspect returns the latest 10 visible records; `--after 0` starts from the beginning. Continue with the returned `nextAfter`.
- Follow drains available messages immediately, then long-polls for messages or state changes. Changes only to `session.updatedAt` do not wake a wait or produce output. `--count N` limits polling rounds, including rounds with no changes.
- Use continuous follow when the execution tool supports background processes and incremental output; otherwise use finite rounds and continue from the last received `nextAfter`. Allow opportunities to report progress to the user.
- Follow prints the first result, then only new messages or state changes. Unchanged rounds are silent; use inspect when you need to confirm the current state.
- Read `role`, `phase`, `itemType`, and message body. `phase=update` usually indicates progress; `phase=response` signals a reply. Neither idle nor response ends follow; verify completion separately.
- Input requests include question headers, questions, option labels/descriptions, and an `inputHint`; assistant response Plans retain their full message and add the same hint. Answered responses list selected content in order; cancelled/unavailable responses retain their outcome.

## Choose actions by session state

Before each `send` or ordinary `keys` input, inspect and confirm `interaction.state=connected`. By default, `activity=idle` is also required; working sessions reject input rather than queue it, even after an input reminder. When input during working is intentional, add `--force` to `send` (with `--message` or `--stdin`) or `keys`; it skips the idle check, retaining connection, binding ownership, and management occupancy checks.

The CLI also rejects `send` messages whose first character is `/` (without trimming whitespace or checking subsequent lines); `--force` skips this guard too. This guard does not apply to the API.

| State                   | Next action                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connected and idle      | Send a task or answer a question or Plan as described below. Idle does not guarantee an input menu.                                                                 |
| Connected and working   | Continue inspect/follow; use `terminal <id>` when useful. To adjust or stop execution, use `interrupt <id>`, then wait for connected and idle before further input. |
| Disconnected or unknown | Diagnose and observe again before input. Neither state establishes task success or failure.                                                                         |

Interrupt does not require idle. Ctrl+C stops follow without interrupting session execution.

If inspect/follow reports idle while awaiting a task result and there is no unhandled reply, question, or Plan, run `terminal <id>` to inspect the prompt and diagnose the stall.

## Answer questions and Plans

For a question or Plan reminder:

1. Confirm connected and idle, then run `terminal <id>` to check the current prompt.
2. Use `keys <id> <key...>`, preferring the number keys shown in its menu, for example `ahub-cli session keys SESSION_ID 1 --json`. If confirmation is required, reconfirm connected and idle before sending Enter separately.
3. Inspect from the saved `nextAfter` to observe selected answers and subsequent progress.

For questions (not Plans), an alternative is to interrupt, organize the chosen answers by question, wait for connected and idle, then submit them together with `send`. This is useful for answering multiple questions at once.

## Verify and finish

- Read and retain each new assistant `phase=response` reply. Continue observing until connected and idle, collecting any subsequent messages; if already connected and idle, proceed immediately.
- Use the collected replies and verification of deliverables against the task's acceptance criteria to decide whether to finish or address questions, blockers, or remaining work. Neither idle nor a reply alone proves completion. Resolve output locations against the actual `workingDirectory`, which may differ from `projectDirectory` with explicit cwd or worktrees.
- Perform lifecycle actions as requested, not automatically on a final reply. `exit <id>` ends session execution; delete permanently removes session history. Verify an uncertain exit before claiming success.
- Report deliverables, verification scope, and whether the session exited.

## Recover from errors

- Follow defaults to 30 seconds per request. Other defaults are 15 seconds for list, inspect, terminal, send, keys, and interrupt; 45 seconds for create, resume, exit, and delete. `--timeout` limits the invocation, except in follow where it limits each HTTP request and there is no overall deadline.
- Exit code 0 means command success, not task completion; 1 means a definite failure or query error; 2 means a submitted write has an uncertain result.
- After a timeout or exit code 2, check state before repeating a write. Stopping the client does not cancel backend operations; resubmitting create/send can duplicate sessions or messages.
- For create/resume errors, read `error.code`, `error.message`, `error.sessionId`, and `error.tmux`. Use inspect/terminal when an ID is known; otherwise use the project list and tmux diagnostics.
- For exceptional tmux diagnosis, use `tmux -S SOCKET capture-pane -p -t =SESSION_NAME:`; a human can connect with `tmux -S SOCKET attach-session -t =SESSION_NAME:`. Use the returned `tmux.socketPath` for `SOCKET` and `tmux.sessionName` for `SESSION_NAME`; shell-quote each argument. Do not bypass the CLI to send tasks directly to a pane.

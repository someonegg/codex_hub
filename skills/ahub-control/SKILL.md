---
name: ahub-control
description: Manage agent sessions through an existing Codex Hub using ahub-cli session. Use to create or resume sessions, send tasks, follow replies, handle input requests, and diagnose launch or connection problems. Does not install or start Hub, or publish pages or diffs.
---

# Coordinate sessions through Codex Hub

The CLI reports runtime state, replies, input requests, and diagnostics. The caller verifies deliverables and decides whether the task is complete. Create, control, or clean up only sessions within the authorized task scope.

## Check the environment and target

- Check `command -v ahub-cli` and `ahub-cli session --help` for the commands and options needed by the task. Report missing capabilities; install, update, or start services only when authorized.
- Address precedence is `--url`, `CODEX_HUB_URL`, then `http://127.0.0.1:4173`. Keep custom addresses consistent across commands; only HTTP origins are supported.
- Select existing sessions with `list --project /absolute/project --json`. It lists main sessions only; known child IDs can be inspected directly. Treat IDs as opaque strings.

## Create, resume, and send

- `create --project <directory>` sets project association and the default launch directory. `--cwd <directory>` changes the launch location without changing association.
- Creation accepts `--home <nickname>`, defaulting to the first configured Home. Use `--worktree` and `--yolo` as authorized launch options, not universal defaults.
- `resume <id>` retains the original Home and uses an available original working or project directory. It accepts `--yolo` but no directory overrides.
- Successful create/resume means the session was observed live, connected, and idle. Save `sessionId` and `tmux` (`socketPath`, `paneId`, `sessionName`); diagnostics may be null.
- Before sending, inspect and save `nextAfter` as the turn's baseline; then observe new replies from that position.
- Specify the objective, output location, constraints, and acceptance criteria. Prefer `--stdin` from a file or pipe for long messages to avoid shell interpolation and quoting errors. `sent` confirms delivery only.

Replace the example IDs, positions, and paths with actual values:

```bash
ahub-cli session create --project /absolute/project --json
# Save sessionId; add --cwd /absolute/working-directory if needed.

ahub-cli session inspect SESSION_ID --json
# Save nextAfter as BASELINE.

ahub-cli session send SESSION_ID --stdin --json < /absolute/task.txt
ahub-cli session inspect SESSION_ID --after BASELINE --follow --interval 3 --count 10 --json
# Retain the latest nextAfter. Continue observing, respond, or verify deliverables.

# After verifying deliverables, if the user requested session exit:
ahub-cli session exit SESSION_ID --json
```

## Observe replies and input requests

- Prefer `--json`. Single inspection returns one object; follow emits NDJSON. Parse each line independently as a result or `error` object. Text follow emits separate blocks.
- Without `--after`, inspect returns the latest 10 visible records by default; `--after 0` starts from the beginning. Continue with `nextAfter`, not the last message ordinal: raw ordinals can have gaps.
- Follow reads immediately, drains every `hasMore=true` page in the round, then waits `--interval` seconds (default 3). `--count N` counts rounds, including unchanged rounds; the final round also drains all pages. It is neither an output count nor a strict duration.
- Use continuous follow when the execution tool supports background processes and incremental output; otherwise use finite rounds and continue from the last received `nextAfter`. Allow opportunities to report progress to the user.
- The first result always prints; subsequent results print only for new visible records or session/interaction changes. Position-only advances may remain silent. Numeric positions do not detect rewritten history; out-of-range positions or stalled pagination fail. Do not silently reset positions.
- Read `role`, `phase`, `itemType`, and message body. `phase=update` usually indicates progress; `phase=response` signals a reply. Neither idle nor response proves task completion or ends follow.
- Input requests include question headers, questions, option labels/descriptions, and an `inputHint`; assistant response Plans retain their full message and add the same hint. Answered responses list selected content in order; cancelled/unavailable responses retain their outcome.
- Verify files, tests, or other deliverables. Resolve output locations against the actual `workingDirectory`, which may differ from `projectDirectory` with explicit cwd or worktrees. A completion claim alone is not verification.

## Operation state machine

- **Connected and idle:** assess the task context. For a question or Plan reminder, run `terminal <id>` to confirm the current prompt, then use `keys <id> <key...>`, preferring the number keys shown in its menu. Observe selected answers and subsequent progress. Reconfirm connected and idle before every later input. Submit ordinary tasks with `send`. Idle neither proves completion nor guarantees an input menu. Verify deliverables before authorized lifecycle actions.
- **Working:** continue inspect/follow, checking terminal output when useful. Do not send tasks or ordinary keys. Even after an input reminder, wait for idle. Interrupt when execution needs adjustment or stopping, or to use the question-answering alternative below; confirm idle before further input.
- **Disconnected or unknown:** diagnose and observe again before input. Neither state establishes task success or failure.

For questions (not Plans), an alternative is to interrupt, organize the chosen answers by question, wait for connected and idle, then submit them together with `send`. This is useful for answering multiple questions at once.

```bash
ahub-cli session inspect SESSION_ID --json
# Confirm interaction.state=connected and activity=idle.
ahub-cli session terminal SESSION_ID --json
# Prefer number keys supported by the current menu, for example:
ahub-cli session keys SESSION_ID 1 --json
# Send enter separately if the menu requires confirmation.
# Observe the result; inspect again before any later input.
ahub-cli session inspect SESSION_ID --after BASELINE --json
```

## Interact and finish

| Need                                                  | Action                                              |
| ----------------------------------------------------- | --------------------------------------------------- |
| Observe a working session                             | inspect/follow; `terminal <id>` for terminal output |
| Adjust the running task                               | `interrupt <id>`, confirm idle, then send           |
| End session execution                                 | `exit <id>` when authorized                         |
| Transfer binding after the terminal switches sessions | Confirm the target, then `handoff <id>`             |

- Send and ordinary keys require idle; while working they fail rather than queue, so they cannot steer execution. Interrupt and handoff do not require idle. Handoff success confirms sending the binding command; observe again to confirm the binding.
- For superseded bindings, check `supersededBySessionId` and the actual binding before sending to the old target.
- Ctrl+C stops follow without interrupting the session. Interrupt stops current execution; exit ends the session; archive retains it as archived; delete requires prior archive. Perform lifecycle actions as requested, not automatically on a final reply.
- Report deliverables, verification scope, and whether the session exited. Verify an uncertain exit before claiming success.

## Recover from errors

- Defaults are 15 seconds for list, inspect, terminal, send, keys, interrupt, and handoff; 45 seconds for create, resume, exit, archive, and delete. `--timeout` limits the invocation, except in follow where it limits each HTTP request and there is no overall deadline.
- Exit code 0 means command success, not task completion; 1 means a definite failure or query error; 2 means a submitted write has an uncertain result.
- After a timeout or exit code 2, check state before repeating a write. Stopping the client does not cancel backend operations; resubmitting create/send can duplicate sessions or messages.
- For create/resume errors, read `error.code`, `error.message`, `error.sessionId`, and `error.tmux`. Use inspect/terminal when an ID is known; otherwise use the project list and tmux diagnostics. Targets may be incomplete or stale; do not invent missing values.
- For exceptional tmux diagnosis, use `tmux -S SOCKET capture-pane -p -t PANE`; a human can connect with `tmux -S SOCKET attach-session -t SESSION_NAME`. Substitute and quote actual values. Do not bypass the CLI to send tasks directly to a pane.
- API, network, or request timeout errors end follow without retry. Check the cause, then restart observation from the saved position if appropriate; observation failure is not a reason to resend the task.

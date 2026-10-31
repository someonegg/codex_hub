---
name: ahub-control
description: Manage agent sessions through an existing Codex Hub using ahub-cli session. Use only when the user explicitly requests `ahub-control` by name.
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
- Without `--after`, inspect returns the latest 10 visible records; `--after 0` starts from the beginning. Continue with the returned `nextAfter`.
- Follow checks immediately, then every `--interval` seconds (default 3). `--count N` limits polling rounds, including rounds with no changes.
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
- Perform lifecycle actions as requested, not automatically on a final reply. `exit <id>` ends session execution; archive retains the session as archived; delete requires prior archive. Verify an uncertain exit before claiming success.
- Report deliverables, verification scope, and whether the session exited.

## Recover from errors

- Defaults are 15 seconds for list, inspect, terminal, send, keys, and interrupt; 45 seconds for create, resume, exit, archive, and delete. `--timeout` limits the invocation, except in follow where it limits each HTTP request and there is no overall deadline.
- Exit code 0 means command success, not task completion; 1 means a definite failure or query error; 2 means a submitted write has an uncertain result.
- After a timeout or exit code 2, check state before repeating a write. Stopping the client does not cancel backend operations; resubmitting create/send can duplicate sessions or messages.
- For create/resume errors, read `error.code`, `error.message`, `error.sessionId`, and `error.tmux`. Use inspect/terminal when an ID is known; otherwise use the project list and tmux diagnostics.
- For exceptional tmux diagnosis, use `tmux -S SOCKET capture-pane -p -t PANE`; a human can connect with `tmux -S SOCKET attach-session -t SESSION_NAME`. Substitute and quote actual values. Do not bypass the CLI to send tasks directly to a pane.

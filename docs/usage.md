# Usage and configuration

English | [简体中文](usage.zh-CN.md) | [繁體中文](usage.zh-TW.md)

## Start the hub

```sh
npx @someonegg/codex-hub@latest
```

Open <http://127.0.0.1:4173> or the URL printed by the server. Press `Ctrl-C`
to stop the server. Installation and requirements are in the [README](../README.md#quick-start).

By default, Hub reads Codex sessions from `~/.codex` and Claude Code sessions from
`~/.claude`, and listens only on this machine. For another device, configure
[remote access](#access-from-other-devices) first.

## Read conversations

Choose a project and main session in the sidebar; open child sessions from the
parent conversation. Messages load from the beginning as you scroll, then update
automatically at the end. Use **Archived** to browse read-only archived sessions.
You can bookmark a session URL.

The latest loaded plan opens automatically. Use **Show** and **Hide** to control
individual plans, including opening several at once.

## Create and manage sessions

Click a project's **+**, or the global **+** to select a project or enter an
absolute local directory. Choose a [Agent](#multiple-agents) and optional launch settings:

- **Worktree:** start in a separate Git worktree for isolated changes.
- **YOLO:** skip the runtime's approval prompts; Codex also disables its sandbox.

Open an exited session and click **Resume** when available to continue it. Resume
keeps the original Agent and project association, using an available original
working or project directory. Before resuming a session started elsewhere, make
sure its original process has exited.

Use the session's **…** menu to:

- **Exit session:** stop its connected terminal and retain history.
- **Archive:** stop execution and move the session to the archived list.
- **Delete:** permanently remove session history after confirmation.

Creating and resuming use tmux. If login or permission confirmation blocks startup,
use **… → Tmux access** or the displayed attach command to finish in a terminal.
Do not rename Hub's tmux sessions or change their window/pane structure.
See [tmux requirements](technical-reference.md#tmux-interaction) for details.

## Send prompts and files

A green **Live** badge indicates a connected terminal. Send prompts from the
message input. By default, **Shift+Enter** sends and **Enter** inserts a newline.
Enable **Enter to send** in [Settings](#browser-settings) to reverse this.

Expand **Terminal Preview** to inspect the CLI. Use **Interrupt** or press
**Ctrl+C** in the preview to interrupt; **Esc** collapses it. **Working** and
**Idle** reflect terminal output, not task completion.

Sent prompts appear as **Pending** until conversation messages update; pure slash
commands skip this preview. Failed sends retain your draft. Draft text and
attachment selections survive session navigation but reset on page refresh.

If Codex switches sessions in the same terminal after `/clear`, `/resume`, or
running a plan, click **Handoff** on the old session's connected page. When it
shows **Superseded**, follow **Go to bound session**. Unsent drafts stay on the old page.

### File uploads

Use the attachment button to **Take photo**, **Choose images**, or **Choose files**;
you can also paste images or drop files. Preview or remove attachments before
sending, with or without text. Multiple files are supported; folders are not.
Each file can be up to **20 MiB**.

Images retain their original content, including EXIF metadata. Camera behavior
depends on the browser; HEIC/HEIF support depends on the runtime.

Open **Upload history** from the session header to preview, download, or delete
files, including unsent uploads. Removing an attachment from a draft does not
delete its uploaded file; deleting it from history also removes it from the draft.

Files persist under `uploads/` in the [Hub data root](#configure-the-server), which
must be accessible to the agent. Session deletion triggers background cleanup;
archive and exit retain uploads. See the [upload reference](technical-reference.md#file-uploads)
for storage and cleanup details, or [preview upload history](images/ahub-uploads.png).

## Browser settings

Open **Settings** at the bottom of the sidebar to choose language, theme, the
default Agent for new sessions, and Worktree/YOLO defaults. Changes save automatically
in this browser. YOLO defaults also apply to resume; launch dialogs allow overrides.

The interface starts in English. Language changes take effect immediately
and do not translate conversation or terminal content.

## Use the CLI

`codex-hub` starts the server; `ahub-cli` manages sessions and published resources.
The examples below assume a global installation:

```sh
npm install -g @someonegg/codex-hub
ahub-cli --help
```

Without installing globally, replace `ahub-cli` in any example with
`npx --package=@someonegg/codex-hub@latest ahub-cli`.
Add `--json` for structured command results.

### Session commands

Start Hub first, then run commands in another terminal:

```sh
ahub-cli session list --project /path/to/project
ahub-cli session create --project /path/to/project
ahub-cli session send <id> --message "Explain the failing tests"
ahub-cli session inspect <id>
ahub-cli session inspect <id> --follow
```

Use a Hub ID returned by `list` or `create`. `list` excludes archived sessions
unless `--all` is supplied; `inspect` also accepts child session IDs. Pass the
returned `Next after` value as `--after <value>` to read the next page.
`--follow` keeps observing until `Ctrl+C`; it does not stop when a task finishes.

Create defaults to the project directory and first configured Agent. Use `--cwd`
to change the working directory while retaining the project association, or
`--agent <nickname>` to select an Agent. Optional `--worktree` and `--yolo` control
launch behavior; `resume <id>` retains the original Agent and accepts `--yolo`.
Use `create --task <name>` and `list --task <name>` to group sessions across projects.

Input requires a connected, idle terminal by default. Use `send <id> --stdin`
for piped input, `terminal <id>` to inspect the terminal, or `interrupt <id>` to
interrupt execution. `--force` on `send` or `keys` allows input while working;
it also permits `send` messages starting with `/`. After a terminal switches
sessions, use `handoff <id>` to transfer its binding.

Commands connect to `http://127.0.0.1:4173` by default. Set `CODEX_HUB_URL` or
pass `--url` to change it; use `--timeout <seconds>` to adjust the timeout.
For a private CA, set `NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem` before starting the CLI.

Successful sending does not mean task completion. After a timeout or exit code `2`
(unknown write result), check `list`, `inspect`, or `terminal` before retrying.
Stopping the client does not cancel a submitted operation. Lifecycle commands,
including delete, run without a CLI confirmation prompt.
See `ahub-cli session --help` for all commands and the
[CLI reference](technical-reference.md#session-cli-and-observation) for result and timeout contracts.

## Publish pages and diffs

Start Hub with `--hosting` to view published resources. Publishing commands read
local files on the Hub machine and work even while the server is stopped.
They print a relative URL and Markdown link; open the URL on your Hub server.

Storage defaults to `~/.codex-hub/hosting`. If using a custom data root, pass the
same `--home-dir /path` to both the commands and server.

### Publish a page

Publish a built directory containing `index.html`:

```sh
ahub-cli page publish ./demo --project /path/to/project --name demo --title "Design comparison"
```

Both directories must exist. Use relative asset paths; Hub does not build sites
or accept remote publication uploads. Hosted pages run as trusted code on the
same origin as Hub, so publish only content you trust.

Publish again with the same project and name to update the page while retaining
its URL. Without `--name`, the source directory name is used. For worktrees,
pass the original project to `--project`.

Open **Pages** (`/artifacts`) to browse, copy links, or delete pages and their
snapshots. The CLI also supports `page list` and `page delete <id>`.
Published pages survive removal of the source directory or worktree.
See the [hosting reference](technical-reference.md#optional-hosting) for details.

### Share a diff

Generate the comparison you want, then publish it:

```sh
git diff HEAD > /tmp/review.diff
ahub-cli diff publish /tmp/review.diff --title "Review changes"
```

Open the returned `/diffs/<uuid>` URL. Publications do not expire: use
`ahub-cli diff list` to find them and `ahub-cli diff delete <uuid>` after review.
Deleting a publication leaves the source file unchanged.
See the [diff reference](technical-reference.md#temporary-diffs) and
[desktop](images/ahub-diff.png) / [mobile](images/ahub-diff-mobile.png) previews.

### Publish with an agent

Install the bundled [`ahub-publish` skill](../skills/ahub-publish) and request it
by name. Run `ahub-cli skill path ahub-publish` to locate it; if using `npx`, copy
the returned cache directory to a lasting skill location.

## Configure the server

Pass options at startup and restart after changing them. Use `codex-hub --help`
for the full list.

| Option                 | Default        | Purpose                                            |
| ---------------------- | -------------- | -------------------------------------------------- |
| `--port <port>`        | `4173`         | Listen port; `0` selects a free port               |
| `--home-dir <path>`    | `~/.codex-hub` | Hub data root containing `uploads/` and `hosting/` |
| `--hosting`            | Disabled       | Serve published pages and diffs                    |
| `--tmux-socket <path>` | tmux default   | Use a custom tmux socket                           |

### Multiple agents

An Agent is an identity with its own configuration, Skills, memory, and model settings.
Codex and Claude Code are Runtimes; identities spawned within a task are Subagents.
Each Agent has a unique nickname and directory, containing `sessions/` for Codex
or `projects/` for Claude Code:

```sh
codex-hub \
  --codex-agent 'work=~/.codex-work' \
  --claude-agent 'claude=~/.claude'
```

Repeat or combine these options as needed. Explicit agents replace **both**
defaults; the first is the default for creation.
Use the sidebar Agent filter to narrow sessions. For web creation, an active Agent
filter or valid default Agent preference takes priority over the first Agent.
See [Agent routing](technical-reference.md#agent-identity-and-routing) for exact rules.

## Access from other devices

Hub has no application login. Anyone who can access it can read conversations,
send input, and manage sessions. Keep the default `127.0.0.1` listener unless you
configure authenticated, restricted access through a reverse proxy or mutual TLS (mTLS).

For built-in mTLS:

```sh
codex-hub \
  --host 0.0.0.0 \
  --ssl \
  --ssl-cert /path/to/server-fullchain.pem \
  --ssl-key /path/to/server-key.pem \
  --ssl-ca /path/to/client-ca.pem
```

Install a client certificate and private key on each device, and ensure it trusts
the server certificate. Without `--ssl-ca`, HTTPS encrypts traffic but does not
authenticate clients. Restart after replacing certificates or keys.

To let the local CLI connect without a client certificate, also start the server
with `--local-port 4174`, then use:

```sh
ahub-cli session list --url http://127.0.0.1:4174
```

This additional HTTP listener is disabled by default and binds to `127.0.0.1`.
Other local users and processes can access it; do not forward external proxy traffic to it.

## Troubleshooting

- **No sessions:** check that each configured Agent contains `sessions/` (Codex)
  or `projects/` (Claude). Check the server output for unreadable or skipped files.
- **Port in use:** choose another port, such as `codex-hub --port 4180`.
- **Cannot send input:** complete CLI prompts via **Tmux access**, wait if busy,
  or use **Resume** if available. Archived sessions are read-only; session logs
  alone do not provide a live terminal connection.
- **Create/resume status unclear:** inspect tmux and refresh the session list before
  retrying to avoid duplicates. Closing the page does not stop an operation;
  restarting the server loses its progress tracking.
- **Camera unavailable or upload interrupted:** use the file picker, check that
  the session is connected and idle, and retry.

For runtime and recovery details, see the [technical reference](technical-reference.md).

## Uninstall

Stop the server. For a global installation, run:

```sh
npm uninstall -g @someonegg/codex-hub
```

An `npx` run needs no global uninstall. Sessions, worktrees, running tmux sessions,
uploads, and hosted snapshots remain; clean them up separately as needed.

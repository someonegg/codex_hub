# Usage and configuration

## Start the hub

```sh
npx @someonegg/codex-hub@latest
```

Open <http://127.0.0.1:4173>, or the URL printed by the server. Press `Ctrl-C`
to stop it. For installation and requirements, see the [README](../README.md#quick-start).

By default, the hub reads `~/.codex` and listens only on this machine.

## Reading and managing sessions

Choose a project and session in the sidebar. Conversations update automatically;
use **Include archived** to browse archived sessions. You can bookmark or share a
session URL with another device that can access the hub.

- **Create:** click a project's **+**, or the global **+** to choose a project or
  enter an absolute local directory. Optionally enable a worktree or YOLO mode.
- **Resume:** open an exited session and click **Resume** when available. It
  continues the same session using its original home and an available original
  working or project directory.
- **Exit session:** use the session's **…** menu to stop the connected terminal
  pane without archiving the conversation.
- **Archive or delete:** use the session's **…** menu. Permanent deletion is
  available for archived sessions and requires confirmation.

Creating and resuming sessions use tmux. If startup needs login, permission, or
trust confirmation, use **Tmux access** in the session's **…** menu or the attach
command shown by the hub to
finish in the terminal. Before resuming a session started elsewhere, make sure
its original process has exited.

The latest loaded plan opens automatically and collapses earlier plans. Use
**Show** or **Hide** to review plans individually; you can open several at once.

## Interacting with Codex

A green **Live** badge indicates a connected terminal. Send prompts from the
message input and expand **Terminal Preview** to inspect the CLI. Use
**Interrupt**, or press **Esc** in the preview, to interrupt.
**Working** and **Idle** reflect terminal output, not whether a task is complete.

Press **Shift+Enter** to send; **Enter** inserts a newline, or sends a standalone
command (such as `/help`) when no files are attached.

If Codex switches sessions in the same terminal after `/clear`, `/resume`, or
running a plan, click **Handoff** on the previous session's connected page.
When it shows **Superseded**, follow **Go to bound session**. Your unsent draft
stays on the old page.

### File uploads

Use the attachment button to **Take photo**, **Choose images**, or **Choose files**;
you can also paste images or drop files. Preview images or remove attachments
before sending, with or without text. Multiple files are supported; folders are not.

Draft text and attachment selections survive session navigation but reset on refresh.

Camera behavior depends on the browser and may fall back to a file picker. Images
are uploaded unchanged, including EXIF metadata, up to 20 MiB each; HEIC/HEIF
support depends on the agent. If the session becomes disconnected or busy while
taking a photo, reconnect or retry later.

Open **Upload history** from the session header to browse,
preview, download, or delete uploads, including unsent files and files removed
from drafts. Deleting a file removes it from the current draft. Attachment deletion
and cleanup are best effort. Session deletion triggers background cleanup; archive
and exit retain uploads. [Preview upload history](images/ahub-uploads.png).

Uploads persist under `uploads/` in the [Hub data root](#server-options), which
must be accessible to the agent. See the [technical reference](technical-reference.md#file-uploads)
for API and storage guarantees.

## Multiple homes

To use a different Codex home, pass `--codex-home 'nickname=path'`. Point to the
directory containing `sessions/`, not to `sessions/` itself. Repeat the option
for multiple homes:

```sh
codex-hub \
  --codex-home 'personal=~/.codex' \
  --codex-home 'work=/path/to/codex-work'
```

Explicit homes replace the default `~/.codex`. Give each home a unique nickname
and directory. Use the sidebar home filter to narrow the session list, and choose
the destination home when creating a session.

## Publish resources

Start `codex-hub --hosting` to view published pages and diffs. Resource commands
work while the server is stopped and print a relative URL and Markdown link on
publication. Storage defaults to `~/.codex-hub/hosting`; for a custom location,
pass the same `--home-dir /path` to the commands and server. Add `--json`
for structured output.

For agent-assisted publishing, install the
[`ahub-publish` skill](https://github.com/someonegg/devkit/tree/main/skills/ahub-publish)
and request it by name to publish static pages or review diffs to an existing Hub.

### Publish web pages

Hosted pages run as trusted code on the same origin as Hub; publish only
content you trust. Open **Pages** at `/artifacts` to manage them.

Publish an already built directory containing `index.html` on the Hub machine:

```sh
codex-hub page publish ./demo --project /absolute/path/to/project --title "Design comparison"
```

Both directories must exist. Use relative asset paths; Hub does not build sites
or accept remote uploads.

To update a page, publish with the same project and name. The name defaults to
the source directory name after resolving symlinks. Use `--name` to keep a name
across different source directories. Updates retain the URL; the title is kept
unless `--title` is supplied. For worktrees, pass the original project to `--project`.

The **Pages** link opens management in a new tab. Open pages, copy absolute
links, refresh the list, or confirm deletion of a page and all its snapshots. Removing the source or worktree does
not remove published pages. The CLI also supports `page list` and `page delete <id>`.
See the [hosting reference](technical-reference.md#optional-hosting)
for resource loading limits, project identity, and snapshot guarantees.

### Share a temporary diff

Generate a diff file for the intended comparison, then publish it:

```sh
git diff HEAD > /tmp/review.diff
codex-hub diff publish /tmp/review.diff --title "Review changes"
codex-hub diff list
codex-hub diff delete <uuid>
```

Open the returned `/diffs/<uuid>` link to review the diff. The agent chooses the
comparison and deletes the publication when finished; there is no automatic
cleanup. The source file is unchanged.
See the [diff reference](technical-reference.md#temporary-diffs) and
[desktop](images/ahub-diff.png) / [mobile](images/ahub-diff-mobile.png) previews.

## Server options

Pass options to `codex-hub`; restart after changing them. Run `codex-hub --help`
for the full command-line help.

| Option                         | Default            | Purpose                                             |
| ------------------------------ | ------------------ | --------------------------------------------------- |
| `--codex-home <nickname=path>` | `default=~/.codex` | Choose one or more Codex homes                      |
| `--host <host>`                | `127.0.0.1`        | Listen address                                      |
| `--port <port>`                | `4173`             | Listen port; `0` selects a free port                |
| `--home-dir <path>`            | `~/.codex-hub`     | Hub data root (`uploads/` and `hosting/`)           |
| `--hosting`                    | Disabled           | Enable static web hosting                           |
| `--tmux-socket <path>`         | tmux default       | Use a custom tmux socket                            |
| `--ssl`                        | Disabled           | Enable HTTPS; requires `--ssl-cert` and `--ssl-key` |
| `--ssl-cert <path>`            | None               | PEM server certificate or chain                     |
| `--ssl-key <path>`             | None               | PEM private key                                     |
| `--ssl-ca <path>`              | None               | Require client certificates signed by this CA       |

## Security

The hub has no application login. Anyone who can access it can read conversations,
send input, and manage sessions. Keep the default local address unless you have
configured authentication and restricted network access.

For access from other devices, use an authenticated reverse proxy or built-in
mutual TLS (mTLS). For example:

```sh
codex-hub \
  --host 0.0.0.0 \
  --ssl \
  --ssl-cert /path/to/server-fullchain.pem \
  --ssl-key /path/to/server-key.pem \
  --ssl-ca /path/to/client-ca.pem
```

Install a client certificate and its private key on each device, and ensure the
device trusts the server certificate. Without `--ssl-ca`, HTTPS encrypts traffic
but does not authenticate clients. Restart after replacing certificates or keys.

## Troubleshooting

- **No sessions:** check that `--codex-home` points to the directory containing
  `sessions/`. Check the server's terminal output for unreadable or skipped files.
- **Port in use:** choose another port, such as `codex-hub --port 4180`.
- **Cannot send input:** the session needs a live, connected tmux pane. Complete
  any CLI prompts in tmux, or use **Resume** if available. Archived sessions are
  read-only. Existing log files alone do not provide a terminal connection.
- **Creation or resume status is unclear:** inspect tmux and refresh the session
  list before retrying, to avoid starting another session. Closing the page does
  not stop an operation; restarting the server loses its progress tracking.

For connection and management details, see the [technical reference](technical-reference.md).

## Uninstall

Stop the server. If installed globally:

```sh
npm uninstall -g @someonegg/codex-hub
```

An `npx` run needs no global uninstall. Uninstalling retains sessions, worktrees,
running tmux sessions, uploads, and hosted snapshots; clean them up separately as needed.

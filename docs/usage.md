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
- **Exit:** stop the connected terminal pane without archiving the conversation.
- **Archive or delete:** use the session's **…** menu. Permanent deletion is
  available for archived sessions and requires confirmation.

Creating and resuming sessions use tmux. If startup needs login, permission, or
trust confirmation, use **tmux access** or the attach command shown by the hub to
finish in the terminal. Before resuming a session started elsewhere, make sure
its original process has exited.

## Interacting with Codex

A green **Live** badge indicates a connected terminal. Send prompts from the
message input and expand **Terminal Preview** to inspect the CLI. Use
**Interrupt**, or press **Esc** in the preview, to interrupt.
**Working** and **Idle** reflect terminal output, not whether a task is complete.

If Codex switches sessions in the same terminal after `/clear`, `/resume`, or
running a plan, click **Handoff** on the previous session's connected page.
When it shows **Superseded**, follow **Go to bound session**. Your unsent draft
stays on the old page.

### File uploads

Paste images or drop files into the message input, then review and send the
inserted paths. Multiple files are supported; folders are not.

Uploads use temporary storage by default. To keep them in a known location:

```sh
codex-hub --upload-dir ~/codex-hub-uploads
```

The directory must be accessible to the Codex process. Uploaded files are not
removed when the hub stops or is uninstalled; delete them manually when no longer
needed. See the [technical reference](technical-reference.md#file-uploads) for
upload limits.

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

## Server options

Pass options to `codex-hub`; restart after changing them. Run `codex-hub --help`
for the full command-line help.

| Option                         | Default             | Purpose                                             |
| ------------------------------ | ------------------- | --------------------------------------------------- |
| `--codex-home <nickname=path>` | `default=~/.codex`  | Choose one or more Codex homes                      |
| `--host <host>`                | `127.0.0.1`         | Listen address                                      |
| `--port <port>`                | `4173`              | Listen port; `0` selects a free port                |
| `--upload-dir <path>`          | Temporary directory | Store uploaded files                                |
| `--tmux-socket <path>`         | tmux default        | Use a custom tmux socket                            |
| `--ssl`                        | Disabled            | Enable HTTPS; requires `--ssl-cert` and `--ssl-key` |
| `--ssl-cert <path>`            | None                | PEM server certificate or chain                     |
| `--ssl-key <path>`             | None                | PEM private key                                     |
| `--ssl-ca <path>`              | None                | Require client certificates signed by this CA       |

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

An `npx` run needs no global uninstall. Sessions, worktrees, running tmux sessions,
and uploaded files remain; clean them up separately as needed.

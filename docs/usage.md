# Usage and configuration

## Server options

Pass options after `npm start --`. Restart the server after configuration changes.

| Option                 | Default      | Description                                                          |
| ---------------------- | ------------ | -------------------------------------------------------------------- |
| `--codex-home <path>`  | `~/.codex`   | Directory containing `sessions/` and optionally `archived_sessions/` |
| `--host <host>`        | `127.0.0.1`  | Listen address                                                       |
| `--port <port>`        | `4173`       | Listen port; `0` selects a free port                                 |
| `--ssl`                | disabled     | Accept HTTPS only                                                    |
| `--ssl-cert <path>`    | none         | PEM server certificate or chain; required with `--ssl`               |
| `--ssl-key <path>`     | none         | PEM private key; required with `--ssl`                               |
| `--ssl-ca <path>`      | none         | Trusted client CA bundle; requires client certificates               |
| `--tmux-socket <path>` | tmux default | Socket path, resolved to an absolute path                            |
| `--help`               | —            | Print command-line help                                              |

The server prints its URL at startup and detects session changes without a restart.

## Reading and managing sessions

Select a project and session in the sidebar. Unarchived main sessions appear by
default; **Include archived** also reveals archived sessions. Direct child sessions
are available from the conversation. A child session links back to its immediate
parent, even when the parent's catalog entry is unavailable. Project counts include
only visible main sessions.
The browser tab remembers the archive filter, project expansion, and sidebar scroll position.

Wide screens show navigation and the conversation together. Below 768px, the
hub switches between them. Session URLs support direct access, refresh,
and browser back/forward navigation; the home page does not select a session automatically.

Unarchived conversations receive Live updates automatically. Archived conversations
remain readable. History can load while Live is active without losing the reading position.
Technical event filters are optional; see [JSONL filtering](session-jsonl-filtering.md).

Use the project **+** to prefill its directory, or the global **+** to choose an
existing project or enter an absolute local directory. Creation optionally uses
a native Codex worktree. The session **…** menu offers archive and, for archived
sessions, permanent deletion with confirmation.

Creation starts Codex in a dedicated tmux session and waits for its recorded binding.
Handle login, permission, and trust prompts directly in tmux; the hub does
not confirm them. If binding takes more than 30 seconds, an attach command appears.
If copying fails, select the command and copy it manually.

Management continues when the page closes. Refreshing can resume progress polling,
but server restarts lose operation records. An `unknown` result ends tracking; it
does not cancel an external command. After an uncertain create, attach to tmux or
refresh the catalog before submitting again, since another request may create another session.

The hub does not restore archived sessions, manage worktree cleanup, or
report process activity.

## Binding an existing tmux session

In Codex running inside tmux, execute:

```sh
! printf 'CODEX_HUB_TMUX_BIND_V3\n%s\n%s\n' "$(tmux display-message -p '#{socket_path}')" "$TMUX_PANE"
```

Session names are unrestricted for manual bindings. A valid, connected binding
reveals the interaction panel. The terminal preview starts collapsed unless an
automatic expansion rule below applies, and refreshes while expanded and visible.
Collapsing or hiding it preserves its last frame;
disconnection clears it. Switching sessions resets the preview.
Sending a slash command consisting of a single English word (for example, `/plan`)
automatically expands the preview after successful delivery. Leading and trailing
whitespace is ignored for command detection. The preview also expands when the
latest message is User input or a final Plan, once the latest timeline page is
loaded and the session is connected. Each qualifying message triggers this expansion
only once per session visit. Manually collapsing it keeps it folded until a new
qualifying message arrives or another slash command is successfully delivered.

Use **Rebind** in a connected interaction panel to resend the basic binding command
to its current tmux pane. It preserves the hub draft and preview state.
It requires an existing live connection; bind an unbound session manually.

Without `--tmux-socket`, creation follows tmux's default socket selection. With it,
creation uses the resolved absolute path. Later interaction uses the actual socket
recorded in the binding. See [binding details](technical-reference.md#tmux-interaction).

## TLS and mTLS

Enable HTTPS with a server certificate and matching private key:

```sh
npm start -- \
  --host 0.0.0.0 \
  --ssl \
  --ssl-cert /path/to/server-fullchain.pem \
  --ssl-key /path/to/server-key.pem
```

That port accepts HTTPS only; there is no separate HTTP listener or redirect.
Add `--ssl-ca /path/to/client-ca.pem` to require a client certificate signed by a
configured CA. Certificates, keys, and CA bundles are read at startup; restart
after replacing them.

## Security

Interaction and management endpoints are enabled by default and share the read
API's network trust boundary. There is no application authentication. Loopback
limits network access but does not isolate other users or processes on the machine.
For a non-loopback listener or reverse proxy, add authentication and restrict access.

The server rejects path traversal and symlink escapes, avoids permissive CORS,
and does not expose rollout paths or raw records in public session responses.
Explicitly requested internal-event details expose bounded JSON for that event.
Rendered Markdown disables raw HTML, replaces remote images with text, and blocks
unsafe links. File reads and responses are bounded.

## Troubleshooting

**No sessions appear:** point `--codex-home` at the directory containing `sessions/`,
not at `sessions/` itself. Rollouts must be regular files named `rollout-*.jsonl`.
Check server stderr for skipped or unreadable data.

**Port already in use:** select another port with `npm start -- --port 4180`.

**No interaction panel:** confirm Codex is running in tmux and has recorded a valid
V3 binding. Complete any CLI prompts in tmux. The hub does not infer a
connection from the presence of rollout files.

**Management progress is unavailable:** retry the progress query after a network
error. A missing operation or server restart cannot recover execution tracking;
check the session catalog and tmux before repeating an uncertain action.

## Uninstall

Stop the server, then remove the repository. Codex owns created sessions and
worktrees. Existing tmux sessions continue running when the hub stops;
clean up those resources separately as needed.

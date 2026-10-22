# Usage and configuration

## Server options

Pass options to `codex-hub`. Restart the server after configuration changes.

| Option                         | Default                     | Description                                                          |
| ------------------------------ | --------------------------- | -------------------------------------------------------------------- |
| `--codex-home <nickname=path>` | `default=~/.codex`          | Directory containing `sessions/` and optionally `archived_sessions/` |
| `--host <host>`                | `127.0.0.1`                 | Listen address                                                       |
| `--port <port>`                | `4173`                      | Listen port; `0` selects a free port                                 |
| `--ssl`                        | disabled                    | Accept HTTPS only                                                    |
| `--ssl-cert <path>`            | none                        | PEM server certificate or chain; required with `--ssl`               |
| `--ssl-key <path>`             | none                        | PEM private key; required with `--ssl`                               |
| `--ssl-ca <path>`              | none                        | Trusted client CA bundle; requires client certificates               |
| `--tmux-socket <path>`         | tmux default                | Socket path, resolved to an absolute path                            |
| `--upload-dir <path>`          | process temporary directory | Upload storage; see [file uploads](#file-uploads)                    |
| `--help`                       | —                           | Print command-line help                                              |

The server prints its URL at startup and detects session changes without a restart.

## Multiple homes

A home is one independent `CODEX_HOME`, containing `sessions/` and optionally
`archived_sessions/`. Repeat the option to configure multiple homes:

```sh
codex-hub \
  --codex-home 'personal=~/.codex' \
  --codex-home 'work=/path/to/codex-work'
```

Values require `nickname=path`, split at the first `=`, and trim surrounding
whitespace; internal spaces and additional `=` characters are preserved. Nicknames must be nonempty, unique,
and case-sensitive; paths must be nonempty. Quote spaces and `~/` as shown above.
Relative paths resolve from the server's working directory, and `~/` expands to
the user's home. Duplicate paths, including symlink aliases, prevent startup.
Explicit homes replace `default=~/.codex` and retain their supplied order.

The sidebar remembers its home filter within the tab, defaulting to **All homes**
when unset or removed. Counts and archive filtering use visible sessions.
Filtering keeps the current reader open and allows cross-home navigation. Multi-home lists and readers show the home nickname,
separate from the session nickname.

The create dialog preselects the filtered home, otherwise the home nicknamed
`default`, or the sole configured home. With multiple homes and no `default` in
aggregate view, select one explicitly, including an empty home.
See [home identity and routing](technical-reference.md#home-identity-and-routing)
for session identity, source isolation, and management routing rules.

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

Unarchived conversations receive automatic updates. Archived conversations
remain readable. Restart the server to see external edits to cached archive content;
archive, deletion, and restoration are detected normally.
History can load while automatic updates are active without losing the reading position.
Technical event filters are optional; see [JSONL filtering](session-jsonl-filtering.md).

Use the project **+** to prefill its directory, or the global **+** to choose an
existing project or enter an absolute local directory. Creation optionally uses
a native Codex worktree through **Enable worktree** and YOLO mode through **Enable YOLO mode**.
Both options reset to off whenever the creation dialog opens. The session **…** menu offers archive and, for archived
sessions, permanent deletion with confirmation.

Creation starts Codex in a dedicated tmux session and waits for its recorded binding.
Handle login, permission, and trust prompts directly in tmux; the hub does
not confirm them. If binding takes more than 30 seconds, an attach command appears.
If copying fails, select the command and copy it manually.

Management continues when the page closes. Refreshing can resume progress polling,
but server restarts lose operation records. An `unknown` result ends tracking; it
does not cancel an external command. After an uncertain create, attach to tmux or
refresh the catalog before submitting again, since another request may create another session.

Sessions show a green **Live** badge when their owned tmux pane is alive, and
**Archived** for archives. Other sessions have no badge. The interaction panel is
visible immediately for unarchived sessions. When connected it shows messaging,
terminal preview, Handoff, **tmux access** on the left and **Exit** on the right.
Exit stops the pane without archiving the conversation.

Disconnected panels hide input and terminal controls while preserving unsent drafts.
They show **Resume** when the server can establish safe recovery, or explain why it
is unavailable. Resume opens a dialog with only an **Enable YOLO mode** switch, reset to off whenever it opens;
it uses the original home and working directory and preserves session identity.
No binding, invalid bindings, uncertain checks and archived sessions cannot resume.
After an unknown launch result, inspect the attach target before trying again.
The hub does not restore archived sessions or manage worktree cleanup.

## Binding an existing tmux session

In Codex running inside tmux, execute:

```sh
! printf 'CODEX_HUB_TMUX_BIND_V4\n%s\n%s\n%s\n%s\n' "$(tmux display-message -p '#{socket_path}')" "$TMUX_PANE" '' '/absolute/path/to/project'
```

Replace `/absolute/path/to/project` with the project directory; for worktree
sessions, use the original project directory. The preceding `''` leaves the
operation ID empty for manual binding.

Manual bindings allow any session name; a valid, connected binding enables the
full interaction panel. Terminal Preview updates while expanded and visible.
Collapsing or hiding it preserves the last frame; disconnection clears it, and
switching sessions resets it.

The preview heading shows **Working** when the pane produced output in the past
five seconds, including redraws, spinners, and input echoes. It shows **Idle**
after five seconds of silence. This measures terminal output, not agent task
completion. Activity continues updating while preview is collapsed; no badge is
shown while observation is starting or unavailable. **Interrupt** sits beside
**Handoff**, with **Send** on the right.

Preview starts collapsed. These conversation events expand it automatically:

- Successful delivery of a single-word English slash command, such as `/plan`
  (surrounding whitespace is ignored).
- Loading the latest timeline page while connected, when its latest message is
  User input or a final Plan. Each qualifying message expands it once per visit.

Manually collapsing it suppresses repeated expansion for the same message. A new
qualifying message or another successfully delivered slash command can expand it
again. Successful **Handoff** delivery and pressing **Interrupt** also expand the
preview so you can inspect the terminal.

If another session binds the same tmux pane, the former session shows that its
pane was taken over. Input, Handoff, and terminal preview become unavailable there;
follow the replacement-session link when shown. The former session cannot stop
the taken-over pane when archived. This state remains after the replacement is
archived or deleted; the link disappears if that session is no longer readable.
An explicit later binding can reclaim the pane.

If Codex changes sessions after `/clear`, `/resume`, or running a plan after
clearing context, click **Handoff** on the **previous session's connected page**.
It sends a binding command to the active Codex session through the shared pane;
an unbound new page cannot initiate it. Delivery opens the preview and preserves
your draft, but handoff completes only when the new binding is recognized and the
old page links to the replacement session.

Without `--tmux-socket`, creation follows tmux's default socket selection. With it,
creation uses the resolved absolute path. Later interaction uses the actual socket
recorded in the binding. See [binding details](technical-reference.md#tmux-interaction).

## File uploads

Paste images or drop files into the message input, then review and send the inserted
paths. Multiple files are supported; folders are not. Uploads freeze editing, Send,
and Handoff. A failure stops the batch and retains earlier paths; switching sessions
cancels pending uploads. Finder paste works when the browser supplies files;
text-only paths remain text.

Use `--upload-dir <path>` to choose storage. Missing directories are created,
relative paths resolve from the startup directory, and `~/` is supported.
Otherwise the process creates and reuses a `codex-hub-uploads-*` directory under
the operating system's temporary directory. The directory must be visible to the
Codex process. Uploads remain after shutdown and uninstall; remove unneeded files
manually. The OS may clear temporary storage, so use an explicit directory when
files must remain available. See the [upload API](technical-reference.md#file-uploads)
for size limits and error responses.

## TLS and mTLS

Enable HTTPS with a server certificate and matching private key:

```sh
codex-hub \
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
For a non-loopback listener or reverse proxy, authenticate clients and restrict access.
Built-in [mTLS](#tls-and-mtls) is an option for personal access from a small number
of devices: install a client certificate and its private key on each device, trust
the server certificate, and configure `--ssl-ca` to require trusted client certificates.
Once configured, clients authenticate with their certificates without a separate
application login or authentication proxy. HTTPS without `--ssl-ca` encrypts traffic
but does not authenticate clients.

Treat client private keys as access credentials. Every accepted client has full
access to the read, interaction, and management endpoints; mTLS does not add
per-user permissions. Certificate installation, renewal, and trust configuration
require maintenance. The server does not configure certificate revocation checks;
if a client key is lost or compromised, replace the affected trust configuration
and restart the server to reject that certificate.

The server rejects path traversal and symlink escapes, avoids permissive CORS,
and does not expose rollout paths or raw records in public session responses.
Explicitly requested internal-event details expose bounded JSON for that event.
Rendered Markdown disables raw HTML, replaces remote images with text, and blocks
unsafe links. File reads and responses are bounded.

## Troubleshooting

**No sessions appear:** use `--codex-home 'personal=/path/to/codex-home'` with the directory containing `sessions/`,
not at `sessions/` itself. Rollouts must be regular files named `rollout-*.jsonl`.
Check server stderr for skipped or unreadable data.

**Port already in use:** select another port with `codex-hub --port 4180`.

**Interaction controls are unavailable:** archived sessions have no interaction panel.
Unarchived sessions show the panel immediately, but messaging and terminal controls
require a live, owned pane with a valid binding. See the
[current binding format](technical-reference.md#tmux-interaction), and complete any
CLI prompts in tmux.
Rollout files alone do not establish a connection. Resume is available only when
the server can confirm safe recovery; see [session management](#reading-and-managing-sessions).

**Management progress is unavailable:** retry the progress query after a network
error. A missing operation or server restart cannot recover execution tracking;
check the session catalog and tmux before repeating an uncertain action.

## Uninstall

Stop the server. For a global npm installation, run:

```sh
npm uninstall -g @someonegg/codex-hub
```

For a source checkout, remove the checkout when it is no longer needed. An `npx`
run requires no global uninstall.

Codex owns created sessions and worktrees. Existing tmux sessions continue running
when the hub stops; clean up those resources separately as needed. Uploaded files
also remain; see [upload storage and cleanup](#file-uploads).

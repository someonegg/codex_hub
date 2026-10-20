# Codex Hub

A local web hub for Codex that pairs readable conversations with live CLI interaction.
Browse sessions by project, follow responses in near real time, and keep working with
Codex from desktop or mobile.

![Codex Hub: create a session, send a prompt, and review an answered User input card](docs/images/codex-hub-intro.gif)

<details>
<summary>Mobile screenshots</summary>

<img src="docs/images/codex-hub-mobile-catalog.png" alt="Mobile project navigation" width="260">
<img src="docs/images/codex-hub-mobile-reader.png" alt="Mobile conversation with an answered User input question, options, and selected answer" width="260">

</details>

## Quick start

Requirements:

- Node.js 22.13 or newer and npm
- A local Codex home (usually `~/.codex`)
- Codex CLI with `resume`, `--no-daemon`, `--no-alt-screen`, `--worktree`, `archive`, and `delete --force` support
- tmux for creating and interacting with sessions

```sh
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4173>. Press `Ctrl-C` to stop the server.
To use a different Codex home or port:

```sh
npm start -- --codex-home 'personal=/path/to/codex-home' --port 4180
```

To use multiple Codex homes:

```sh
npm start -- \
  --codex-home 'personal=~/.codex' \
  --codex-home 'work=/path/to/codex-work'
```

See [home configuration and usage](docs/usage.md#multiple-homes) for detailed rules.

## Features

- Navigate projects, main sessions, and child conversations.
- Read Markdown, code, tables, and math with optional technical events.
- Follow conversation updates while browsing their history.
- Create sessions with optional worktrees, send input, and preview their terminals.
- See live sessions, safely resume exited sessions, exit without archiving, and manage archives.

## Session interaction

Send prompts and control the live terminal from the session page.

<details>
<summary>Show session interaction screenshot</summary>

<img src="docs/images/codex-hub-session-interaction.png" alt="Session conversation with answered User input, live terminal preview, controls, message input, and Handoff" width="900">

</details>

### Continue with Handoff

If Codex switches sessions in the same terminal after `/clear`, `/resume`, or
running a plan, click **Handoff** on the previous session's page. Once it shows
**Superseded**, follow **Go to bound session**. Your draft stays on the old page.
See [tmux interaction](docs/usage.md#binding-an-existing-tmux-session) for details.

## Security

Codex Hub reads local session logs and the session index, interacts with Codex
through tmux, and manages sessions through native CLI commands. Authentication
stays with Codex; the hub does not read or manage tokens, API keys, or credential files.

The server binds to loopback by default. Interaction and management are enabled
without application authentication. Before exposing it to a network, add
authentication and restrict access. See the [security guidance](docs/usage.md#security).

## Documentation

- [Usage and configuration](docs/usage.md)
- [Technical reference](docs/technical-reference.md)
- [Development and screenshots](docs/development.md)
- [All documentation and architecture decisions](docs/README.md)

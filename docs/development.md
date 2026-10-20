# Development

## Local workflow

```sh
npm ci
npm run build
npm start
```

`npm run dev` starts the client-only Vite server without the local session API.
Use a built server when testing real or synthetic rollout data.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run format:check
```

Use `npm run format` to format maintained files, and `npm run lint -- --fix` to
fix import ordering and type imports. Prettier owns formatting: double quotes,
semicolons, two-space indentation, 100 columns, trailing commas, and LF.
Markdown preserves paragraph line breaks. `.prettierignore` excludes generated
files, fixtures, images, lockfiles, and ADRs.

ESLint checks client, server, shared code, tests, and TypeScript scripts. See the
[isolated lint toolchain](../tools/client-lint/README.md) for import rules, React
Hooks coverage, and its separate TypeScript API dependency.

GitHub Actions runs `npm ci` and `npm test` on Ubuntu with Node.js 22 for pushes to
`main` and pull requests. The **Tests** workflow also supports manual runs. Native tmux
and Codex CLI integration suites remain separate from this workflow.

## Integration tests and benchmarks

Install tmux and Codex CLI, then run:

```sh
npm run test:all
```

Individual suites and the optional scale benchmark:

```sh
npm run test:integration:tmux
npm run test:integration:codex
npm run benchmark:scale
```

Native lifecycle tests use temporary projects, an isolated Codex home, dummy
credentials, and a separate tmux socket. They do not call a model or use existing
user sessions.

## Documentation screenshots

Use `playwright-cli` with its browser installed. Capture the rendered UI without
DOM or style overrides; inspect for page errors, clipping, and horizontal overflow.
Close dedicated browser sessions and stop demo servers after capture.

### README introduction animation

The README GIF shows the real client with fabricated API responses: create a
session with the `default` home preselected among multiple homes, type and send
a prompt, then read a preset reply. It does not start Codex,
call a model, or access the user's sessions. The browser intercepts all API requests.

The animation additionally requires Python 3 with Pillow.
Start the client in one terminal:

```sh
npm run dev -- --port 4187 --strictPort
```

In another terminal, from the repository root:

```sh
node scripts/record-docs-intro.mjs
```

An optional URL argument selects a different client server. The script uses a
dedicated browser session and a 1440 × 1000 viewport with English locale and UTC.
It saves PNG frames in a new temporary directory, closes its browser, and combines
the frames into `docs/images/codex-hub-intro.gif` using a shared palette. The GIF
loops automatically, pauses on the reply, and must stay under 5 MiB. Source frames
remain in the printed temporary directory for inspection. Stop the client server
after recording. Inspect the GIF at README display width before committing.

### Static screenshots

Screenshots use synthetic English rollouts served by the real application.
Generate the demo outside the repository and start a built server:

```sh
node scripts/create-docs-demo.mjs /tmp/codex-hub-docs-demo
npm run build
npm start -- \
  --codex-home 'default=/tmp/codex-hub-docs-demo' \
  --port 4187
```

Open the server in a dedicated browser session:

```sh
playwright-cli -s=docs open http://127.0.0.1:4187
```

Use `playwright-cli -s=docs run-code` to create a browser context with
`locale: "en-US"`, `timezoneId: "UTC"`, `deviceScaleFactor: 1`, and a
390 × 844 viewport. Wait for the conversation, `document.fonts.ready`, and stable layout
before capturing each screenshot.
Capture the home page to `docs/images/codex-hub-mobile-catalog.png`, then
select **Design the project dashboard** and capture `docs/images/codex-hub-mobile-reader.png`.
Keep default event filters and the archive filter off.

Close the dedicated browser session and stop the demo server after capture.
The generator refuses an existing destination to avoid overwriting other data.
It uses only fabricated project paths and conversations, never the user's Codex home.

### Session interaction screenshot

With a running client:

```sh
npm run dev -- --port 4187 --strictPort
node scripts/capture-docs-interaction.mjs
```

Both capture scripts accept optional URL and output path arguments:

```sh
node scripts/capture-docs-interaction.mjs http://127.0.0.1:4187 /tmp/codex-hub-interaction.png
node scripts/record-docs-intro.mjs http://127.0.0.1:4187 /tmp/codex-hub-intro.gif
```

The interaction capture defaults to `docs/images/codex-hub-session-interaction.png`.
Both scripts intercept API requests with shared fabricated fixtures. Confirm terminal
output, terminal controls, the message input and Handoff are visible in the interaction
screenshot. Use temporary output paths for verification.

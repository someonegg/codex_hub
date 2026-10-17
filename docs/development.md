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
files, fixtures, images, lockfiles, historical ADRs, and benchmark records.

ESLint checks client, server, shared, tests, and TypeScript scripts. React Hooks
rules apply only to client code and tests. Imports stay at the top; server imports
group Node, third-party, and project modules. The [isolated lint toolchain](../tools/client-lint/README.md)
uses a compatible TypeScript API separately from the project compiler.

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

Screenshots use synthetic English rollouts served by the real application.
Generate the demo outside the repository and start a built server:

```sh
node scripts/create-docs-demo.mjs /tmp/codex-hub-docs-demo
npm run build
npm start -- --codex-home /tmp/codex-hub-docs-demo --port 4187
```

With `playwright-cli` installed, open the server in a dedicated browser session:

```sh
playwright-cli -s=docs open http://127.0.0.1:4187
```

Use `playwright-cli -s=docs run-code` to create a browser context with
`locale: "en-US"`, `timezoneId: "UTC"`, `deviceScaleFactor: 1`, and a
1440 × 1000 desktop viewport. Select **Design the project dashboard** from the
sidebar. Wait for the conversation, `document.fonts.ready`, and stable layout,
then capture the viewport to `docs/images/codex-hub-desktop.png`.

In a fresh context with the same locale and time zone, use a 390 × 844 viewport.
Capture the home page to `docs/images/codex-hub-mobile-catalog.png`, then
select the same session and capture `docs/images/codex-hub-mobile-reader.png`.
Keep default event filters and the archive filter off. Capture the rendered UI
without DOM or style overrides; inspect for clipping and horizontal overflow.

Close the dedicated browser session and stop the demo server after capture.
The generator refuses an existing destination to avoid overwriting other data.
It uses only fabricated project paths and conversations, never the user's Codex home.

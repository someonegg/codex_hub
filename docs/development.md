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

Install `playwright-cli` and its browser; the GIF also requires Python 3 with Pillow.
Start the client, then run the capture scripts in another terminal:

```sh
npm run dev -- --port 4187 --strictPort
```

```sh
node scripts/record-docs-intro.mjs
node scripts/capture-docs-interaction.mjs
```

The scripts capture the real UI without DOM or style overrides, using shared
fabricated English data and intercepted API requests, including terminal WebSocket
snapshots. They do not start Codex or access the user's sessions.

Outputs in `docs/images/`:

- `codex-hub-intro.gif`: session creation, prompt submission, reply, and an answered
  **User input** card at 1440 × 1000. It loops with a 6.5-second final pause.
- `codex-hub-session-interaction.png`: the answered card and full interaction panel,
  including terminal output, at 1440 × 1500.
- `codex-hub-mobile-catalog.png` and `codex-hub-mobile-reader.png`: project navigation
  and the same answered card at 390 × 844.

Both scripts accept optional URL and output path arguments:

```sh
node scripts/record-docs-intro.mjs http://127.0.0.1:4187 /tmp/codex-hub-intro.gif
node scripts/capture-docs-interaction.mjs http://127.0.0.1:4187 /tmp/codex-hub-interaction.png
```

The static script writes the mobile PNGs beside its output. GIF source frames remain
in the printed temporary directory. Scripts check page errors and horizontal overflow
and close their browsers. Inspect readability and clipping at README display widths,
confirm the answered card and terminal output, and keep the GIF below 5 MiB.
Stop the client server after capture.

For manual exploration with synthetic rollouts, create a new isolated demo home
and serve it with a built application:

```sh
node scripts/create-docs-demo.mjs /tmp/codex-hub-docs-demo
npm run build
npm start -- --codex-home 'default=/tmp/codex-hub-docs-demo' --port 4187
```

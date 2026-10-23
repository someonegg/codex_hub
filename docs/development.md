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

GitHub Actions runs tests, type checking, linting, formatting, and an installed-package
smoke test on Ubuntu with Node.js 22.13 and 24. Native tmux and Codex CLI integration
suites remain separate from this workflow.

## Releases

The public npm package is `@someonegg/codex-hub`; its executable is `codex-hub`.
Run `npm run test:package` to build, pack, install into a temporary directory, and
verify help, server startup, and web assets outside the repository.

For a release, update the package and lockfile versions in a PR, run the checks,
and merge it. Tag that commit as `v<package-version>` and push the tag. The
`publish.yml` workflow validates the tag, runs the checks, and publishes to npm
using trusted publishing, skipping versions already published during a workflow retry.
Create a matching GitHub Release with English release notes after verifying
installation from the registry. Never reuse a published
version; fix release defects in a new patch version.

### One-time publishing setup

The initial package bootstrap uses a local authenticated `npm publish`. After that,
configure npm trusted publishing for GitHub user `someonegg`, repository `codex_hub`,
workflow `publish.yml`, without an environment, allowing direct publishing. This is
one-time setup; routine releases use the workflow above without an npm token.

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
- `codex-hub-session-interaction-unbound.png`: unbound session with Resume and its
  reminder beside Unbound; the capture also checks mobile overflow and the resume dialog.
- `codex-hub-session-interaction-warm.png`: the same desktop view in Paper,
  captured after verifying that the theme survives a reload.
- `codex-hub-mobile-catalog.png` and `codex-hub-mobile-reader.png`: project navigation
  and the same answered card at 390 × 844.
- `codex-hub-mobile-composer.png`: focused mobile input with page jump controls hidden.
  The capture also checks blur restoration, a smaller viewport, and desktop focus behavior.

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

## Application icons

Run `python3 scripts/generate-icons.py` (requires Pillow) to regenerate the SVG,
ICO, Apple touch icon, and PNG icons in `public/`. The terminal prompt and session
branches use the application's teal palette. Keep the artwork inside the central
maskable safe circle; mobile platforms apply their own icon masks.

`index.html` links the browser and Apple icons and `manifest.webmanifest`. The
manifest launches the project catalog in a standalone window, including when
installed from a session page. For mobile installation, serve the app over HTTPS
(localhost also works for development), then use the browser's install or Add to
Home Screen action. This does not add offline session access.

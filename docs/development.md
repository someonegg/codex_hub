# Development

## Run locally

Use Node.js `^22.22.2 || ^24.15.0 || >=26.0.0` and npm for development and checks.
The published package supports Node.js >=22.13.

```sh
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4173>. Rebuild and restart after changing application code.
See [Usage](usage.md#server-options) for server options and the
[README](../README.md#quick-start) for tmux and Codex CLI requirements.

For frontend hot reload, run `npm run dev`. It starts Vite without the session
API; use the built server for real sessions and end-to-end checks.

To browse isolated demo conversations after building, create a new demo directory:

```sh
node scripts/create-docs-demo.mjs /tmp/ahub-docs-demo
npm start -- --codex-home 'default=/tmp/ahub-docs-demo' --port 4187
```

### Find the code

- `src/client/`: UI and browser state.
- `src/server/`: HTTP services, session repository, and source adapters.
- `src/shared/`: public API contracts and shared types.
- `tests/` and `scripts/`: checks, fixtures, and maintenance tools.

For behavior and contracts, see the [technical reference](technical-reference.md)
and [JSONL filtering](session-jsonl-filtering.md).

## Validate changes

Before submitting a change:

```sh
npm run typecheck
npm run lint
npm test
npm run format:check
```

Use `npm run format` to format files and `npm run lint -- --fix` to fix supported
lint issues. See the [lint toolchain](../tools/client-lint/README.md) for rules.

Run additional checks for the affected area:

| Command                          | When to use                                              |
| -------------------------------- | -------------------------------------------------------- |
| `npm run test:package`           | Packaging or release validation                          |
| `npm run test:integration:tmux`  | Native tmux interaction changes                          |
| `npm run test:integration:codex` | Native Codex lifecycle changes                           |
| `npm run test:hosting`           | Hosting/diff changes and desktop/mobile diff screenshots |
| `npm run benchmark:scale`        | Scale or performance changes                             |

With tmux and Codex CLI installed, `npm run test:all` runs unit tests and both
native integration suites. Native lifecycle tests use temporary projects, an
isolated Codex home, dummy credentials, and a separate tmux socket; they do not
call a model or use existing user sessions. Hosting checks require `playwright-cli`
and its browser.

`test:package` builds, packs, installs, and smoke-tests outside the repository.
Use `npm run test:package -- --skip-build` to reuse a current build, or
`node scripts/test-package.mjs /path/to/package.tgz` to test an existing tarball.

CI runs the standard checks and package tests, including a Node.js 22.13.0 runtime
smoke test. Native integration suites run separately; see
[test.yml](../.github/workflows/test.yml) for the matrix.

## Update documentation images

UI changes must regenerate affected README screenshots and animations in all
three languages. Install `playwright-cli` and its browser; GIF generation also
requires Python 3 with Pillow.

Start the frontend:

```sh
npm run dev -- --port 4187 --strictPort
```

In another terminal, generate the English assets:

```sh
node scripts/record-docs-intro.mjs
node scripts/capture-docs-interaction.mjs
npm run test:hosting
```

The first two scripts capture the real UI with fabricated sessions and mocked
requests, without starting Codex or reading user sessions. Outputs go to
`docs/images/`; the hosting check generates the diff screenshots.

Repeat for `zh-CN` and `zh-TW`, for example:

```sh
node scripts/record-docs-intro.mjs --language zh-CN
node scripts/capture-docs-interaction.mjs --language zh-CN
node --import tsx scripts/test-hosting.mjs --language zh-CN
```

Chinese assets use matching filenames under `docs/images/zh-CN/` and
`docs/images/zh-TW/`. The hosting script requires the build generated above.

Both capture scripts accept a server URL and output path. To check CSP
compatibility, start the built server with `npm start`, then run:

```sh
node scripts/capture-docs-interaction.mjs http://127.0.0.1:4173 /tmp/interaction.png
```

Related screenshots are saved beside the selected output; GIF source frames stay
in the printed temporary directory. The scripts check page errors and horizontal
overflow. Also inspect readability and clipping at README display widths,
including the answered **User input** card and terminal output. Keep each GIF
below 5 MiB and stop the frontend server after capture.

When changing camera or attachment behavior, also check confirmation, cancellation,
and repeat shots on real iOS Safari and Android Chrome devices, including
standalone modes.

## Update application icons

With Pillow installed, run `python3 scripts/generate-icons.py` to regenerate the
icons in `public/`. Keep artwork within the central maskable safe circle.

For icon or installation changes, serve over HTTPS (or localhost), then use the
browser's install or Add to Home Screen action. Check that the installed app opens
the catalog. Offline session access is not supported.

## Release

The npm package is `@someonegg/codex-hub`; it provides `codex-hub` (server) and
`ahub-cli` (management commands).

1. Update package and lockfile versions in a PR, run the standard checks and
   `npm run test:package`, then merge.
2. Tag the merged commit as `v<package-version>` and push the tag.
3. Confirm [publish.yml](../.github/workflows/publish.yml) succeeds and verify
   installation from npm.
4. Create the matching GitHub Release with English release notes.

The workflow validates the tag, runs checks, and uses npm trusted publishing;
routine releases need no npm token. Retries skip versions already published.
Never reuse a published version; release fixes as a new patch version.

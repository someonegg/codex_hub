# Development

## Local workflow

Use Node.js `^22.22.2 || ^24.15.0 || >=26.0.0` and npm. Development tools require
these versions; the published package supports Node.js >=22.13.

```sh
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4173>. Rebuild and restart after changing application code.
Server options are listed in [Usage](usage.md#server-options).

For frontend work with hot reload, use `npm run dev`. It starts only Vite,
without the session API. Use the built server for end-to-end behavior and real
sessions. To explore with isolated demo data after building:

```sh
node scripts/create-docs-demo.mjs /tmp/codex-hub-docs-demo
npm start -- --codex-home 'default=/tmp/codex-hub-docs-demo' --port 4187
```

Use a new demo directory. Session creation and interaction require
[tmux and Codex CLI](../README.md#quick-start).

### Code map

- `src/client/`: UI and browser state.
- `src/server/`: HTTP services, session repository, and source adapters.
- `src/shared/`: public API contracts and shared types.
- `tests/` and `scripts/`: automated checks, fixtures, and documentation tools.

See the [technical reference](technical-reference.md) for runtime contracts and
[JSONL filtering](session-jsonl-filtering.md) for record processing rules.

## Checks

Before submitting a change:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run format:check
```

Use `npm run format` for formatting and `npm run lint -- --fix` for fixable lint
issues. Prettier owns formatting; ESLint covers application code, tests, and
TypeScript scripts. See the [lint toolchain](../tools/client-lint/README.md) for
rule details.

CI runs checks and package smoke tests, including Node.js 22.13.0 runtime coverage.
Native integration suites run separately. See [test.yml](../.github/workflows/test.yml)
for the exact matrix.

## Integration tests and benchmarks

With tmux and Codex CLI installed, run `npm run test:all` for unit and native
integration suites. Run individual checks as needed:

| Command                          | Purpose                                                     |
| -------------------------------- | ----------------------------------------------------------- |
| `npm run test:integration:tmux`  | Native tmux interaction                                     |
| `npm run test:integration:codex` | Native Codex lifecycle                                      |
| `npm run benchmark:scale`        | Optional scale benchmark                                    |
| `npm run test:package`           | Build, pack, install, and smoke-test outside the repository |

Native lifecycle tests use temporary projects, an isolated Codex home, dummy
credentials, and a separate tmux socket. They do not call a model or use existing
user sessions.

To test an existing tarball without rebuilding:

```sh
node scripts/test-package.mjs /path/to/package.tgz
```

## Documentation screenshots

UI changes must regenerate affected README screenshots and animations. Install
`playwright-cli` and its browser; GIF generation also requires Python 3 with Pillow.

Start the client:

```sh
npm run dev -- --port 4187 --strictPort
```

In another terminal:

```sh
node scripts/record-docs-intro.mjs
node scripts/capture-docs-interaction.mjs
```

The scripts use the real UI with shared fabricated data and intercepted HTTP and
WebSocket requests. They do not start Codex or read user sessions.

Outputs go to `docs/images/`: the intro GIF, desktop screenshots in both themes,
and mobile catalog, reader, and composer screenshots.

Both accept optional URL and output-path arguments, for example:

```sh
node scripts/capture-docs-interaction.mjs http://127.0.0.1:4187 /tmp/interaction.png
```

Related screenshots are saved beside the specified output. GIF source frames stay
in the printed temporary directory. Scripts check page errors and horizontal
overflow; also inspect readability and clipping at README display widths, the
answered **User input** card, and terminal output. Keep the GIF below 5 MiB.
Stop the client server after capture.

Attachment checks use mocked uploads at desktop and narrow widths. Real-device
camera checks remain pending: test photo confirmation, cancellation, repeat shots,
and returning to the page in iOS Safari, Android Chrome, and available standalone
home screen modes.

## Application icons

Run `python3 scripts/generate-icons.py` with Pillow installed to regenerate SVG,
ICO, Apple touch, and PNG icons in `public/`. Keep artwork within the central
maskable safe circle. Geometry and color stops are shared by the SVG and raster
renderers. Only the mint frame has subtle shading; the prompt, endpoints, and
background retain their flat colors.

To check mobile installation, serve over HTTPS (or localhost) and use the browser's
install or Add to Home Screen action. The installed app opens the catalog; it does
not provide offline session access.

## Releases

The npm package is `@someonegg/codex-hub`; the executable is `codex-hub`.

1. Update package and lockfile versions in a PR, run the checks and
   `npm run test:package`, then merge.
2. Tag the merged commit as `v<package-version>` and push the tag.
3. Confirm [publish.yml](../.github/workflows/publish.yml) succeeds and verify
   installation from npm.
4. Create the matching GitHub Release with English release notes.

The workflow validates the tag, runs checks, and uses npm trusted publishing.
Retries skip versions already published. Never reuse a published version; release
fixes as a new patch version.

Routine releases require no npm token.

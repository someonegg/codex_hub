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

### README introduction animation

The README GIF shows the real client with fabricated API responses: create a
session with the `default` home preselected among multiple homes, type and send
a prompt, then read a preset reply. It does not start Codex,
call a model, or access the user's sessions. The browser intercepts all API requests.

Requirements: `playwright-cli` with its browser installed, and Python 3 with Pillow.
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
mkdir -p /tmp/codex-hub-docs-work/sessions
npm start -- \
  --codex-home 'default=/tmp/codex-hub-docs-demo' \
  --codex-home 'work=/tmp/codex-hub-docs-work' \
  --port 4187
```

With `playwright-cli` installed, open the server in a dedicated browser session:

```sh
playwright-cli -s=docs open http://127.0.0.1:4187
```

Use `playwright-cli -s=docs run-code` to create a browser context with
`locale: "en-US"`, `timezoneId: "UTC"`, `deviceScaleFactor: 1`, and a
390 × 844 viewport. Wait for the conversation, `document.fonts.ready`, and stable layout
before capturing each screenshot.
Capture the home page to `docs/images/codex-hub-mobile-catalog.png`, then
select **Design the project dashboard** and capture `docs/images/codex-hub-mobile-reader.png`.
Keep default event filters and the archive filter off. Capture the rendered UI
without DOM or style overrides; inspect for clipping and horizontal overflow.

Close the dedicated browser session and stop the demo server after capture.
The generator refuses an existing destination to avoid overwriting other data.
It uses only fabricated project paths and conversations, never the user's Codex home.

### Live pane screenshot

The Live pane uses the real client with fabricated API responses, independently
of the rollout demo above. Start the client with
`npm run dev -- --port 4187 --strictPort`. Save the following function to
`/tmp/codex-hub-live-pane.js`:

<!-- prettier-ignore -->
```js
async (page) => {
  const context = await page
    .context()
    .browser()
    .newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "en-US",
      timezoneId: "UTC",
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
  const demo = await context.newPage();
  const timestamp = "2026-10-16T14:00:00.000Z";
  const session = {
    id: "docs-demo-session-00000001",
    title: "Design the project dashboard",
    origin: {
      sourceType: "codex",
      sourceInstanceId: "docs-demo",
      agentName: "Codex",
      agentVersion: null,
      formatVersion: null,
    },
    nickname: null,
    workingDirectory: "/projects/atlas-dashboard",
    projectDirectory: "/projects/atlas-dashboard",
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: false,
    parentId: null,
    childIds: [],
    agent: null,
    messageCount: 0,
    toolCount: 0,
    sourceId: null,
    itemCount: 0,
  };
  const snapshot = {
    session,
    interaction: {
      supported: true,
      state: "connected",
      supersededBySessionId: null,
      attachCommand: "tmux attach -t docs-demo",
    },
    cursor: "demo-cursor",
    liveRevision: "demo-revision",
    hasMore: false,
  };
  await context.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (route.request().method() !== "GET") return route.abort();
    if (path.endsWith("/live") || url.searchParams.has("after")) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/v1/sessions") {
      return route.fulfill({
        json: {
          revision: "demo-catalog",
          homes: [{ sourceInstanceId: "docs-demo", nickname: "default" }],
          projects: [{ id: "atlas", directory: session.projectDirectory }],
          sessions: [{ ...session, sourceInstanceId: "docs-demo", projectId: "atlas", isChild: false }],
        },
      });
    }
    if (path.endsWith("/terminal-preview")) {
      return route.fulfill({
        json: {
          content: "Codex ready\n\n› Design the project dashboard.\n\nWaiting for input…",
          truncated: false,
          capturedAt: timestamp,
        },
      });
    }
    if (path.endsWith("/items")) {
      return route.fulfill({ json: { ...snapshot, items: [] } });
    }
    if (path === "/api/v1/sessions/docs-demo-session-00000001") {
      return route.fulfill({ json: snapshot });
    }
    return route.abort();
  });
  try {
    await demo.goto("http://127.0.0.1:4187/sessions/docs-demo-session-00000001");
    await demo.getByRole("button", { name: "Terminal preview", exact: true }).click();
    await demo.getByLabel("Terminal preview content", { exact: true }).waitFor();
    await demo.getByRole("textbox", { name: "Message to agent" }).fill("Suggest the next step.");
    await demo.evaluate(() => document.fonts.ready);
    await demo.locator(".interaction-panel").screenshot({
      path: "docs/images/codex-hub-live-pane.png",
      animations: "disabled",
    });
  } finally {
    await context.close();
  }
}
```

Run it from the repository root in a dedicated browser session:

```sh
playwright-cli -s=docs-live open about:blank
playwright-cli -s=docs-live run-code --filename /tmp/codex-hub-live-pane.js
playwright-cli -s=docs-live close
```

All API requests are intercepted; the fixture does not start Codex, connect to tmux,
or access user sessions. Inspect the image for clipping and confirm terminal output,
terminal controls, the message input, and Handoff are visible. Use a temporary output
path in the function when validating without replacing the maintained image.
Stop the client server after capture.

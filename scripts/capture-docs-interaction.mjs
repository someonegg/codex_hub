import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { connectedInteraction, docsSession, docsTimestamp } from "./docs-fixtures.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:4187";
const output = resolve(process.argv[3] ?? "docs/images/codex-hub-session-interaction.png");
const directory = await mkdtemp(join(tmpdir(), "codex-hub-interaction-"));
const browserSession = `interaction-${Date.now()}`;

async function capture(page, origin, output, session, interaction, timestamp) {
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
  const errors = [];
  demo.on("pageerror", (error) => errors.push(error.message));
  const snapshot = {
    session,
    interaction,
    cursor: "demo-cursor",
    updateRevision: "demo-revision",
    hasMore: false,
  };
  await context.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (route.request().method() !== "GET") return route.abort();
    if (path.endsWith("/updates") || url.searchParams.has("after")) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/v1/sessions") {
      return route.fulfill({
        json: {
          revision: "demo-catalog",
          homes: [{ sourceInstanceId: "docs-demo", nickname: "default" }],
          projects: [{ id: "atlas", directory: session.projectDirectory }],
          sessions: [
            { ...session, sourceInstanceId: "docs-demo", projectId: "atlas", isChild: false },
          ],
        },
      });
    }
    if (path.endsWith("/terminal-preview")) {
      return route.fulfill({
        json: {
          revision: "d".repeat(43),
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
    await demo.goto(`${origin}/sessions/${session.id}`);
    await demo.getByRole("button", { name: "Terminal preview", exact: true }).click();
    await demo.getByLabel("Terminal preview content", { exact: true }).waitFor();
    await demo.getByRole("textbox", { name: "Message to agent" }).fill("Suggest the next step.");
    await demo.evaluate(() => document.fonts.ready);
    for (const name of ["Message to agent", "Terminal preview content"]) {
      if (!(await demo.getByLabel(name, { exact: true }).isVisible()))
        throw new Error(`${name} is hidden`);
    }
    if (!(await demo.getByRole("button", { name: "Handoff", exact: true }).isVisible()))
      throw new Error("Handoff is hidden");
    if (errors.length) throw new Error(errors.join("\n"));
    if (await demo.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("Horizontal overflow");
    await demo.locator(".interaction-panel").screenshot({
      path: output,
      animations: "disabled",
    });
  } finally {
    await context.close();
  }
}

const recording = join(directory, "capture.js");
await writeFile(
  recording,
  `(page) => (${capture.toString()})(page, ${[origin, output, docsSession, connectedInteraction, docsTimestamp].map((value) => JSON.stringify(value)).join(", ")})`,
);
const cli = (...args) =>
  execFileSync("playwright-cli", [`-s=${browserSession}`, ...args], { stdio: "inherit" });
try {
  cli("open", "about:blank");
  cli("run-code", "--filename", recording);
} finally {
  cli("close");
}
console.log(`Saved ${output}`);

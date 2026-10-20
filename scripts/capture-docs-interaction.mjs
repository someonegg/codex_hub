import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  connectedInteraction,
  docsSession,
  docsTimestamp,
  docsItems,
  mockDocsTerminal,
} from "./docs-fixtures.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:4187";
const output = resolve(process.argv[3] ?? "docs/images/codex-hub-session-interaction.png");
const directory = await mkdtemp(join(tmpdir(), "codex-hub-interaction-"));
const browserSession = `interaction-${Date.now()}`;

async function capture(
  page,
  origin,
  output,
  session,
  interaction,
  timestamp,
  items,
  mockDocsTerminal,
) {
  const resolveMobile = (view) => output.replace(/[^/]+$/, `codex-hub-mobile-${view}.png`);
  const context = await page
    .context()
    .browser()
    .newContext({
      viewport: { width: 1440, height: 1500 },
      locale: "en-US",
      timezoneId: "UTC",
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
  const demo = await context.newPage();
  const errors = [];
  demo.on("pageerror", (error) => errors.push(error.message));
  session = { ...session, messageCount: 2, itemCount: items.length };
  demo.setDefaultTimeout(10000);
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
          projects: [
            { id: "atlas", directory: session.projectDirectory },
            { id: "harbor", directory: "/projects/harbor-api" },
            { id: "notes", directory: "/projects/field-notes" },
          ],
          sessions: [
            { ...session, sourceInstanceId: "docs-demo", projectId: "atlas", isChild: false },
            ...[
              ["keyboard", "Add keyboard navigation", "atlas"],
              ["release", "Review the release checklist", "harbor"],
              ["api", "Document the API endpoints", "harbor"],
              ["guide", "Outline the getting started guide", "notes"],
            ].map(([id, title, projectId]) => ({
              ...session,
              id,
              title,
              projectId,
              sourceInstanceId: "docs-demo",
              isChild: false,
              status: "normal",
            })),
          ],
        },
      });
    }
    if (path.endsWith("/items")) {
      return route.fulfill({ json: { ...snapshot, items } });
    }
    if (path === "/api/v1/sessions/docs-demo-session-00000001") {
      return route.fulfill({ json: snapshot });
    }
    return route.abort();
  });
  await mockDocsTerminal(context, timestamp);
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
    await demo.locator(".user-input-status.answered").waitFor();
    await demo
      .getByText("Project health selected. Ready for the next step.", { exact: false })
      .waitFor();
    if (await demo.getByRole("alert").count()) throw new Error("Desktop error alert");
    await demo.evaluate(() => window.scrollTo(0, 0));
    for (const selector of [".user-input-card", ".interaction-panel"]) {
      const bounds = await demo.locator(selector).boundingBox();
      if (!bounds || bounds.y < 0 || bounds.y + bounds.height > 1500)
        throw new Error(`${selector} is clipped`);
    }
    await demo.screenshot({
      path: output,
      animations: "disabled",
    });
    await demo.setViewportSize({ width: 390, height: 844 });
    await demo.goto(origin);
    await demo.getByRole("button", { name: /atlas-dashboard, .* main sessions/ }).click();
    await demo.getByText(session.title, { exact: true }).waitFor();
    await demo.getByRole("button", { name: /harbor-api, .* main sessions/ }).click();
    await demo.getByRole("button", { name: /field-notes, .* main sessions/ }).click();
    if (await demo.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("Catalog horizontal overflow");
    await demo.evaluate(() => document.fonts.ready);
    await demo.screenshot({ path: resolveMobile("catalog"), animations: "disabled" });
    await demo.getByText(session.title, { exact: true }).click();
    await demo.locator(".user-input-status.answered").waitFor();
    await demo
      .locator(".user-input-card")
      .evaluate((card) => card.scrollIntoView({ block: "center" }));
    if (await demo.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("Mobile horizontal overflow");
    if (errors.length || (await demo.getByRole("alert").count()))
      throw new Error(errors.join("\n") || "Mobile error alert");
    await demo.screenshot({ path: resolveMobile("reader"), animations: "disabled" });
  } finally {
    await context.close();
  }
}

const recording = join(directory, "capture.js");
await writeFile(
  recording,
  `(page) => (${capture.toString()})(page, ${[origin, output, docsSession, connectedInteraction, docsTimestamp, docsItems].map((value) => JSON.stringify(value)).join(", ")}, ${mockDocsTerminal.toString()})`,
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

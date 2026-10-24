import {
  connectedInteraction,
  docsSession,
  docsTimestamp,
  docsUserInput,
  mockDocsTerminal,
} from "./docs-fixtures.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Requires a running client server, playwright-cli, and Python with Pillow.
const origin = process.argv[2] ?? "http://127.0.0.1:4187";
const output = resolve(process.argv[3] ?? "docs/images/codex-hub-intro.gif");
const frames = await mkdtemp(join(tmpdir(), "codex-hub-intro-"));
const browserSession = `intro-${Date.now()}`;

async function record(
  page,
  frames,
  origin,
  docsSession,
  connectedInteraction,
  timestamp,
  docsUserInput,
  mockDocsTerminal,
  mobileOutput,
) {
  const context = await page
    .context()
    .browser()
    .newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "en-US",
      timezoneId: "UTC",
      deviceScaleFactor: 1,
      hasTouch: true,
      colorScheme: "light",
    });
  const demo = await context.newPage();
  demo.setDefaultTimeout(10000);
  const errors = [];
  demo.on("pageerror", (error) => errors.push(error.message));
  const prompt = "Suggest three improvements for this project dashboard.";
  const reply =
    "### Three focused improvements\n\n1. **Show project health.** Put status and open tasks at the top.\n2. **Highlight recent activity.** Surface the latest changes and decisions.\n3. **Keep navigation clear.** Group sessions by project for quick access.";
  let created = false;
  let stage = 0;
  const session = () => ({
    ...docsSession,
    id: "demo-session",
    title: "Improve the project dashboard",
    messageCount: stage,
    itemCount: stage === 2 ? 4 : stage,
  });
  const interaction = connectedInteraction;
  const items = () =>
    [
      {
        id: "prompt",
        ordinal: 0,
        timestamp,
        kind: "message",
        role: "user",
        phase: null,
        itemType: null,
        markdown: prompt,
      },
      {
        id: "reply",
        ordinal: 3,
        timestamp,
        kind: "message",
        role: "assistant",
        phase: "final",
        itemType: null,
        markdown: reply,
      },
    ]
      .slice(0, stage)
      .flatMap((item) => (item.id === "reply" ? [...docsUserInput, item] : [item]));
  const snapshot = () => ({
    session: session(),
    interaction,
    cursor: "demo-cursor",
    updateRevision: String(stage),
    hasMore: false,
  });
  await context.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body) => route.fulfill({ json: body });
    if (path === "/api/v1/sessions") {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        if (
          body.sourceInstanceId !== "docs-demo" ||
          body.directory !== "/projects/atlas-dashboard" ||
          body.worktree
        ) {
          throw new Error("Unexpected create request");
        }
        created = true;
        return json({
          operationId: "demo-create",
          type: "create",
          status: "succeeded",
          sessionId: "demo-session",
          phase: null,
          attachCommand: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          error: null,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      return json({
        revision: String(created),
        homes: [
          { sourceInstanceId: "docs-work", nickname: "work" },
          { sourceInstanceId: "docs-demo", nickname: "default" },
        ],
        projects: [{ id: "atlas", directory: "/projects/atlas-dashboard" }],
        sessions: created
          ? [{ ...session(), sourceInstanceId: "docs-demo", projectId: "atlas", isChild: false }]
          : [],
      });
    }
    if (path.endsWith("/items")) return json({ ...snapshot(), items: items() });
    if (path.endsWith("/updates")) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (url.searchParams.get("after") === String(stage)) {
        return route.fulfill({ status: 204 });
      }
      return json({ ...snapshot(), hasMore: true });
    }
    if (path.endsWith("/messages") && route.request().method() === "POST") {
      if (route.request().postDataJSON().message !== prompt) throw new Error("Unexpected prompt");
      stage = 1;
      return route.fulfill({ status: 204 });
    }
    throw new Error(`Unexpected demo API: ${route.request().method()} ${path}`);
  });
  await mockDocsTerminal(context, timestamp);
  let frame = 0;
  const capture = async (duration) => {
    await demo.evaluate(() => document.fonts.ready);
    await demo.screenshot({
      path: `${frames}/${String(frame++).padStart(3, "0")}-${duration}.png`,
    });
  };
  try {
    await demo.goto(origin);
    await demo.getByRole("heading", { name: "Select a session from the sidebar" }).waitFor();
    await demo.getByText(/Loading sessions/).waitFor({ state: "hidden" });
    await capture(1100);
    await demo.getByRole("button", { name: "New session", exact: true }).first().click();
    await demo.waitForFunction(
      () => document.querySelector('select[aria-label="Session home"]')?.value === "docs-demo",
    );
    await demo.setViewportSize({ width: 390, height: 844 });
    const projectInput = demo.getByRole("combobox", { name: "Project directory" });
    const projectOption = demo.getByRole("option", { name: "/projects/atlas-dashboard" });
    await projectInput.tap();
    await projectOption.waitFor({ state: "visible" });
    await demo.screenshot({ path: mobileOutput });
    // A reduced viewport approximates the space left above a mobile keyboard.
    await demo.setViewportSize({ width: 390, height: 430 });
    await projectInput.tap();
    const optionBounds = await projectOption.boundingBox();
    if (!optionBounds || optionBounds.y < 0 || optionBounds.y + optionBounds.height > 430) {
      throw new Error("Mobile project suggestion is outside the reduced viewport");
    }
    await projectOption.tap();
    if ((await projectInput.inputValue()) !== "/projects/atlas-dashboard") {
      throw new Error("Mobile project selection failed");
    }
    await projectInput.fill("/new/custom-project");
    if (await demo.getByRole("listbox").count()) {
      throw new Error("Unmatched project suggestions remain visible");
    }
    await projectInput.fill("");
    await demo.setViewportSize({ width: 1440, height: 1000 });
    await capture(900);
    await projectInput.fill("/projects/atlas-dashboard");
    await capture(1100);
    await demo.getByRole("button", { name: "Create session", exact: true }).click();
    const composer = demo.getByRole("textbox", { name: "Message to agent" });
    await composer.waitFor();
    await capture(1200);
    await composer.click();
    for (const character of prompt) {
      await composer.pressSequentially(character);
      await capture(60);
    }
    await capture(1000);
    if (await demo.getByText("Three focused improvements", { exact: true }).count()) {
      throw new Error("Reply appeared before send");
    }
    await demo.getByRole("button", { name: "Send", exact: true }).click();
    await demo.waitForFunction(
      () => document.querySelector('textarea[aria-label="Message to agent"]')?.value === "",
    );
    await demo.getByText(prompt, { exact: true }).waitFor();
    await capture(1100);
    stage = 2;
    await demo.getByRole("heading", { name: "Three focused improvements" }).waitFor();
    await demo.locator(".interaction-panel").scrollIntoViewIfNeeded();
    await demo.locator(".user-input-status.answered").waitFor();
    await demo.locator(".user-input-card").scrollIntoViewIfNeeded();
    await demo.evaluate(() => window.scrollBy(0, -40));
    await capture(6500);
    if (await demo.getByRole("alert").count()) throw new Error("Demo contains an error alert");
    if (errors.length) throw new Error(errors.join("\n"));
    const overflow = await demo.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error("Horizontal overflow in demo");
    console.log(`Captured ${frame} frames to ${frames}`);
  } finally {
    await context.close();
  }
}

const recording = join(frames, "record.js");
await writeFile(
  recording,
  `(page) => (${record.toString()})(page, ${JSON.stringify(frames)}, ${JSON.stringify(origin)}, ${JSON.stringify(docsSession)}, ${JSON.stringify(connectedInteraction)}, ${JSON.stringify(docsTimestamp)}, ${JSON.stringify(docsUserInput)}, ${mockDocsTerminal.toString()}, ${JSON.stringify(resolve("docs/images/codex-hub-mobile-create.png"))})`,
);
const cli = (...args) =>
  execFileSync("playwright-cli", [`-s=${browserSession}`, ...args], { stdio: "inherit" });
try {
  cli("open", "about:blank");
  cli("run-code", "--filename", recording);
} finally {
  cli("close");
}
execFileSync(
  "python3",
  [
    "-c",
    `
import sys
from pathlib import Path
from PIL import Image
paths = sorted(Path(sys.argv[1]).glob('*.png'))
if not paths:
    raise SystemExit('No captured frames')
images = [Image.open(p).convert('RGB') for p in paths]
# One shared palette prevents color shimmer between typing frames.
palette = images[-1].quantize(colors=256, method=Image.Quantize.MEDIANCUT)
frames = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in images]
durations = [int(p.stem.split('-')[-1]) for p in paths]
frames[0].save(sys.argv[2], save_all=True, append_images=frames[1:],
               duration=durations, loop=0, optimize=True, disposal=1)
size = Path(sys.argv[2]).stat().st_size
print(f'GIF: {sum(durations) / 1000:.2f}s, {size / 1024:.0f} KiB')
if size > 5 * 1024 * 1024:
    raise SystemExit('GIF exceeds 5 MiB budget')
`,
    frames,
    output,
  ],
  { stdio: "inherit" },
);
console.log(`Saved ${output}; source frames retained in ${frames}`);

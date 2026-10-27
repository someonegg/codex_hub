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
  await demo.route("**/api/v1/capabilities", (route) => route.fulfill({ json: { hosting: true } }));
  const verifyPageJumps = async () => {
    await demo.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const valid = await demo.evaluate(() => {
      const controls = document.querySelector(".page-jump-controls");
      const panel = document.querySelector(".interaction-panel");
      return (
        getComputedStyle(controls).display !== "none" &&
        controls.getBoundingClientRect().bottom <= panel.getBoundingClientRect().top - 11
      );
    });
    if (!valid) throw new Error("Page jumps hide or overlap the interaction panel");
  };
  const verifyCompactInteraction = async () => {
    const composer = demo.getByRole("textbox", { name: "Message to agent" });
    const original = await composer.inputValue();
    await composer.fill("One\nTwo\nThree\nFour");
    const metrics = await composer.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        rows: element.rows,
        textHeight:
          element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        lineHeight: parseFloat(style.lineHeight),
        fits: element.scrollHeight <= element.clientHeight,
        resize: style.resize,
      };
    });
    if (
      metrics.rows !== 4 ||
      Math.abs(metrics.textHeight - 4 * metrics.lineHeight) > 1 ||
      !metrics.fits ||
      metrics.resize !== "vertical"
    )
      throw new Error("Composer must fit four visible text lines and allow vertical resize");
    await composer.fill("One\nTwo\nThree\nFour\nFive");
    if (!(await composer.evaluate((element) => element.scrollHeight > element.clientHeight)))
      throw new Error("Fifth composer line must scroll");
    await composer.scrollIntoViewIfNeeded();
    const box = await composer.boundingBox();
    await demo.mouse.move(box.x + box.width - 3, box.y + box.height - 3);
    await demo.mouse.down();
    await demo.mouse.move(box.x + box.width - 3, box.y + box.height + 45, { steps: 5 });
    await demo.mouse.up();
    if ((await composer.boundingBox()).height <= box.height)
      throw new Error("Composer resize handle did not increase height");
    await composer.evaluate((element) => element.style.removeProperty("height"));
    await composer.fill(original);
    if (await demo.locator(".interaction-heading").count())
      throw new Error("Empty interaction heading");
    await demo.getByRole("button", { name: "Session management", exact: true }).click();
    const menu = demo.locator(".session-action-menu");
    const labels = await menu.locator("button").allTextContents();
    if (labels.join("|") !== "Tmux access|Archive session|Exit session")
      throw new Error("Unexpected session menu order");
    const bounds = await menu.boundingBox();
    const viewport = demo.viewportSize();
    if (
      bounds.x < 0 ||
      bounds.x + bounds.width > viewport.width ||
      bounds.y < 0 ||
      bounds.y + bounds.height > viewport.height
    )
      throw new Error("Session menu clipped");
    await demo.getByRole("button", { name: "Tmux access", exact: true }).click();
    await demo.getByRole("dialog", { name: "tmux access", exact: true }).waitFor();
    await demo.getByRole("button", { name: "Close tmux access", exact: true }).click();
  };
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
  const sentMessages = [];
  const uploadedNames = [];
  let historyDeleted = false;
  let deletionAttempts = 0;
  const historyAttachment = {
    id: "docs-upload-1",
    sessionId: session.id,
    filename: "dashboard.png",
    size: 68,
    type: "image/png",
    uploadedAt: timestamp,
    path: "/tmp/camera uploads/photo.png",
  };
  let imageBuffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
    "base64",
  );
  await context.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/uploads/docs-upload-1/content"))
      return route.fulfill({ contentType: "image/png", body: imageBuffer });
    if (path.endsWith("/uploads/docs-upload-1") && route.request().method() === "DELETE") {
      if (++deletionAttempts === 1)
        return route.fulfill({
          status: 500,
          json: { error: { message: "Deletion failed; retry" } },
        });
      historyDeleted = true;
      return route.fulfill({ json: { deleted: true } });
    }
    if (path.endsWith("/uploads") && route.request().method() === "GET")
      return route.fulfill({
        json: { items: historyDeleted ? [] : [historyAttachment] },
      });
    if (path === "/api/v1/uploads" && route.request().method() === "POST") {
      uploadedNames.push(url.searchParams.get("filename"));
      return route.fulfill({
        json: historyAttachment,
      });
    }
    if (path.endsWith("/messages") && route.request().method() === "POST") {
      sentMessages.push(route.request().postDataJSON().message);
      return route.fulfill({ status: 204 });
    }
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
              ["docs-demo-session-keyboard", "Add keyboard navigation", "atlas"],
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
      return route.fulfill({
        json: {
          ...snapshot,
          session: path.includes("/docs-demo-session-keyboard/")
            ? { ...session, id: "docs-demo-session-keyboard", title: "Add keyboard navigation" }
            : session,
          items,
        },
      });
    }
    if (path === "/api/v1/sessions/docs-demo-session-keyboard") {
      return route.fulfill({
        json: {
          ...snapshot,
          session: {
            ...session,
            id: "docs-demo-session-keyboard",
            title: "Add keyboard navigation",
          },
        },
      });
    }
    if (path === "/api/v1/sessions/docs-demo-session-00000001") {
      return route.fulfill({ json: snapshot });
    }
    return route.abort();
  });
  async function prepareDesktopPreview() {
    const previewToggle = demo.getByRole("button", { name: "Terminal Preview", exact: true });
    if ((await previewToggle.getAttribute("aria-expanded")) !== "true") await previewToggle.click();
    await demo.getByLabel("Terminal Preview content", { exact: true }).waitFor();
    await demo.getByRole("textbox", { name: "Message to agent" }).fill("Suggest the next step.");
    await demo.evaluate(() => document.fonts.ready);
  }

  async function verifyAttachments() {
    const trigger = demo.getByRole("button", { name: "Attach files", exact: true });
    const composer = demo.getByRole("textbox", { name: "Message to agent" });
    await trigger.click();
    const menu = demo.getByRole("menu", { name: "Attach files" });
    const bounds = await menu.boundingBox();
    const viewport = demo.viewportSize();
    if (
      !bounds ||
      bounds.x < 0 ||
      bounds.y < 0 ||
      bounds.x + bounds.width > viewport.width ||
      bounds.y + bounds.height > viewport.height
    )
      throw new Error("Attachment menu exceeds viewport");
    await demo.keyboard.press("Escape");
    await composer.fill("before replace after");
    await composer.evaluate((input) => input.setSelectionRange(7, 14));
    await trigger.click();
    const chooserPromise = demo.waitForEvent("filechooser");
    await demo.getByRole("menuitem", { name: "Choose images" }).click();
    const chooser = await chooserPromise;
    if (!chooser.isMultiple()) throw new Error("Gallery does not support multiple images");
    await chooser.setFiles({
      name: "photo.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    const expected = '"/tmp/camera uploads/photo.png"\n\nbefore replace after';
    try {
      await demo.waitForFunction(
        (value) => document.querySelector("textarea")?.value === value,
        "before replace after",
      );
    } catch {
      throw new Error(
        `Upload insertion at ${viewport.width}px: ${await composer.inputValue()}; alerts: ${await demo.getByRole("alert").allTextContents()}`,
      );
    }
    await demo.waitForFunction(() => document.activeElement === document.querySelector("textarea"));
    const thumbnail = demo.getByRole("button", { name: "Preview photo.png", exact: true });
    await thumbnail.click();
    await demo.getByRole("dialog", { name: "Preview photo.png", exact: true }).waitFor();
    await demo.keyboard.press("Escape");
    if (!(await thumbnail.evaluate((element) => document.activeElement === element)))
      throw new Error("Image preview did not restore thumbnail focus");
    if (sentMessages.length) throw new Error("Upload sent without user confirmation");
    await demo.waitForFunction(
      () => document.querySelector(".interaction-send")?.getAttribute("aria-disabled") !== "true",
    );
    await demo.getByRole("button", { name: "Send", exact: true }).click();
    try {
      await demo.waitForFunction(() => document.querySelector("textarea")?.value === "");
    } catch {
      throw new Error(
        `Send failed at ${viewport.width}px: ${await composer.inputValue()}; sent: ${JSON.stringify(sentMessages)}; alerts: ${await demo.getByRole("alert").allTextContents()}`,
      );
    }
    if (sentMessages.pop() !== expected || uploadedNames.pop() !== "photo.png")
      throw new Error("Unexpected upload or message payload");
    await trigger.click();
    const cameraPromise = demo.waitForEvent("filechooser");
    await demo.getByRole("menuitem", { name: "Take photo" }).click();
    const camera = await cameraPromise;
    if (camera.isMultiple()) throw new Error("Camera accepts multiple files");
    await camera.setFiles([]);
    if (await composer.inputValue()) throw new Error("Cancelled camera changed the draft");
    for (const kind of ["paste", "drop"]) {
      await composer.evaluate((input, kind) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(["browser upload"], `${kind}.txt`, { type: "text/plain" }));
        const event =
          kind === "paste"
            ? new ClipboardEvent("paste", {
                clipboardData: transfer,
                bubbles: true,
                cancelable: true,
              })
            : new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
      }, kind);
      const remove = demo.getByRole("button", { name: `Remove ${kind}.txt`, exact: true });
      await remove.waitFor();
      await remove.click();
      if (uploadedNames.pop() !== `${kind}.txt`) throw new Error(`Unexpected ${kind} filename`);
    }
    const previewToggle = demo.getByRole("button", { name: "Terminal Preview", exact: true });
    const previewWasExpanded = (await previewToggle.getAttribute("aria-expanded")) === "true";
    await composer.fill("Draft survives switching sessions");
    await demo.evaluate(() => {
      history.pushState(null, "", "/sessions/docs-demo-session-keyboard");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await demo.getByRole("textbox", { name: "Message to agent" }).waitFor();
    if (await composer.inputValue()) throw new Error("Draft leaked into another session");
    await demo.evaluate((id) => {
      history.pushState(null, "", `/sessions/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, session.id);
    await demo.waitForFunction(
      () => document.querySelector("textarea")?.value === "Draft survives switching sessions",
    );
    if (previewWasExpanded) {
      if ((await previewToggle.getAttribute("aria-expanded")) !== "true")
        await previewToggle.click();
      await demo.getByLabel("Terminal Preview content", { exact: true }).waitFor();
    }
    await composer.fill("Suggest the next step.");
  }

  async function stageAttachment() {
    const buffer = await demo.locator(".user-input-card").screenshot();
    imageBuffer = buffer;
    await demo.getByLabel("Choose files", { exact: true }).setInputFiles({
      name: "dashboard.png",
      mimeType: "image/png",
      buffer,
    });
    const image = demo.getByRole("img", { name: "dashboard.png", exact: true });
    await image.waitFor();
    await image.evaluate((element) => element.decode());
  }

  async function verifyUploadHistory() {
    const composer = demo.getByRole("textbox", { name: "Message to agent" });
    await composer.fill("Keep this draft while browsing uploads");
    await stageAttachment();
    await demo.getByRole("link", { name: "Upload history", exact: true }).click();
    await demo.getByRole("heading", { name: "Upload history", exact: true }).waitFor();
    await demo.getByRole("button", { name: "Expand dashboard.png", exact: true }).click();
    await demo.getByRole("button", { name: "Collapse dashboard.png", exact: true }).waitFor();
    if (await demo.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("Upload history horizontal overflow");
    await demo.screenshot({
      path: output.replace(
        /[^/]+$/,
        demo.viewportSize().width > 600 ? "codex-hub-uploads.png" : "codex-hub-uploads-mobile.png",
      ),
      animations: "disabled",
    });
    await demo.goBack();
    await composer.waitFor();
    if ((await composer.inputValue()) !== "Keep this draft while browsing uploads")
      throw new Error("History lost draft text");
    await demo.getByRole("button", { name: "Remove dashboard.png", exact: true }).waitFor();
    await demo.goForward();
    await demo.getByRole("heading", { name: "Upload history", exact: true }).waitFor();
    await demo.reload();
    await demo.getByRole("button", { name: "Delete", exact: true }).click();
    await demo.getByRole("button", { name: "Cancel", exact: true }).click();
    await demo.getByRole("button", { name: "Delete", exact: true }).click();
    await demo.getByRole("button", { name: "Confirm delete", exact: true }).click();
    await demo.getByRole("alert").waitFor();
    await demo.getByRole("button", { name: "Confirm delete", exact: true }).click();
    await demo.getByText("No uploads yet.", { exact: true }).waitFor();
    await demo.getByRole("link", { name: "← Back to session", exact: true }).click();
    await composer.waitFor();
    historyDeleted = false;
    await prepareDesktopPreview();
  }

  async function assertDesktopCardsVisible(prefix = "") {
    for (const selector of [".user-input-card", ".interaction-panel"]) {
      const bounds = await demo.locator(selector).boundingBox();
      if (!bounds || bounds.y < 0 || bounds.y + bounds.height > 1500)
        throw new Error(`${prefix}${selector} is clipped`);
    }
  }

  await mockDocsTerminal(context, timestamp);
  try {
    await demo.goto(`${origin}/sessions/${session.id}`);
    await prepareDesktopPreview();
    await verifyCompactInteraction();
    await verifyAttachments();
    for (const name of ["Message to agent", "Terminal Preview content"]) {
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
    await verifyUploadHistory();
    await stageAttachment();
    await demo.evaluate(() => window.scrollTo(0, 0));
    await assertDesktopCardsVisible();
    await demo.screenshot({
      path: output,
      animations: "disabled",
    });
    await demo.getByRole("combobox", { name: "Theme", exact: true }).selectOption("warm");
    await demo.reload();
    await demo.locator(".user-input-status.answered").waitFor();
    if ((await demo.locator("html").getAttribute("data-theme")) !== "warm")
      throw new Error("Theme was not restored after reload");
    await prepareDesktopPreview();
    await stageAttachment();
    await demo.evaluate(() => window.scrollTo(0, 0));
    await assertDesktopCardsVisible("Paper ");
    if (await demo.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("Paper horizontal overflow");
    if (errors.length || (await demo.getByRole("alert").count()))
      throw new Error(errors.join("\n") || "Paper error alert");
    await demo.screenshot({
      path: output.replace(/\.png$/, "-warm.png"),
      animations: "disabled",
    });
    await demo.getByRole("combobox", { name: "Theme", exact: true }).selectOption("mist");
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
    await demo.getByRole("button", { name: "Terminal Preview", exact: true }).click();
    const composer = demo.getByRole("textbox", { name: "Message to agent" });
    await verifyCompactInteraction();
    await composer.fill("Suggest the next step.");
    await stageAttachment();
    await demo.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await demo
      .locator(".interaction-panel")
      .evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
    const panelBounds = await demo.locator(".interaction-panel").boundingBox();
    if (panelBounds.y < 0 || panelBounds.y + panelBounds.height > 845)
      throw new Error(`Mobile attachment composer is clipped: ${JSON.stringify(panelBounds)}`);
    await verifyPageJumps();
    await demo.screenshot({ path: resolveMobile("composer"), animations: "disabled" });
    await demo.getByRole("button", { name: "Remove dashboard.png", exact: true }).click();
    await verifyAttachments();
    await demo.setViewportSize({ width: 320, height: 568 });
    await verifyCompactInteraction();
    deletionAttempts = 0;
    await verifyUploadHistory();
    await verifyAttachments();
    await verifyPageJumps();
    if (await demo.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("Narrow composer horizontal overflow");
    await demo.setViewportSize({ width: 390, height: 400 });
    await verifyPageJumps();
    await composer.blur();
    await verifyPageJumps();
    await composer.focus();
    await demo.setViewportSize({ width: 1440, height: 1000 });
    await verifyPageJumps();
    await demo.getByRole("button", { name: "Terminal Preview", exact: true }).click();
    await verifyPageJumps();
    await demo.setViewportSize({ width: 1440, height: 400 });
    await demo.evaluate(() => window.scrollTo(0, 0));
    await verifyPageJumps();
    const clearance = await demo
      .locator(".page-jump-controls")
      .evaluate((controls) =>
        Number.parseFloat(controls.style.getPropertyValue("--panel-clearance")),
      );
    if (clearance !== 0) throw new Error("Page jumps do not return to the viewport corner");
    items = [1, 2].map((ordinal) => ({
      kind: "message",
      id: `plan-${ordinal}`,
      ordinal,
      timestamp,
      role: "assistant",
      phase: "final",
      itemType: "Plan",
      markdown: `# Plan ${ordinal}`,
    }));
    await demo.reload();
    const plans = demo.locator(".plan-toggle");
    await plans.nth(1).waitFor();
    if (
      (await plans.nth(0).getAttribute("aria-expanded")) !== "false" ||
      (await plans.nth(1).getAttribute("aria-expanded")) !== "true"
    )
      throw new Error("Latest plan must be the only plan initially expanded");
    await demo.getByRole("heading", { name: "Plan 2", exact: true }).waitFor();
    await plans.nth(0).click();
    await demo.getByRole("heading", { name: "Plan 1", exact: true }).waitFor();
    if ((await plans.nth(1).getAttribute("aria-expanded")) !== "true")
      throw new Error("Manually opening an older plan closed the latest plan");
    await plans.nth(1).click();
    if ((await plans.nth(1).getAttribute("aria-expanded")) !== "false")
      throw new Error("Latest plan cannot be manually hidden");
    if (errors.length) throw new Error(errors.join("\n"));
  } catch (error) {
    await demo.screenshot({ path: "/tmp/codex-hub-capture-failure.png" });
    throw new Error(
      `${error.message}\nPage: ${demo.url()}\n${await demo.locator("body").innerText()}\n${errors.join("\n")}`,
    );
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

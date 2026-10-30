import { docsOptions, captureSource, translateFixture } from "./docs-language.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  connectedInteraction,
  docsSession,
  docsTimestamp,
  docsItems,
  mockDocsTerminal,
} from "./docs-fixtures.mjs";

const { origin, output, language } = docsOptions("docs/images/ahub-session-interaction.png");
const directory = await mkdtemp(join(tmpdir(), "ahub-interaction-"));
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
  const resolveMobile = (view) => output.replace(/[^/]+$/, `ahub-mobile-${view}.png`);
  const context = await page
    .context()
    .browser()
    .newContext({
      viewport: { width: 1440, height: 1500 },
      locale: language === "en" ? "en-US" : language,
      timezoneId: "UTC",
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
  await context.addInitScript((value) => {
    if (!localStorage.getItem("ahub.preferences.v1"))
      localStorage.setItem("ahub.preferences.v1", JSON.stringify({ language: value }));
  }, language);
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
    const composer = demo.getByRole("textbox", { name: label("Message to agent") });
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
    await demo.getByRole("button", { name: label("Session management"), exact: true }).click();
    const menu = demo.locator(".session-action-menu");
    const labels = await menu.locator("button").allTextContents();
    if (
      labels.join("|") !== ["Tmux access", "Archive session", "Exit session"].map(label).join("|")
    )
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
    await demo.getByRole("button", { name: label("Tmux access"), exact: true }).click();
    await demo.getByRole("dialog", { name: label("tmux access"), exact: true }).waitFor();
    await demo.getByRole("button", { name: label("Close tmux access"), exact: true }).click();
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
          homes: [{ nickname: "default" }],
          projects: [
            { directory: session.projectDirectory },
            { directory: "/projects/harbor-api" },
            { directory: "/projects/field-notes" },
          ],
          sessions: [
            {
              ...session,
              home: "default",
              projectDirectory: session.projectDirectory,
              isChild: false,
            },
            ...[
              ["docs-demo-session-keyboard", "Add keyboard navigation", session.projectDirectory],
              ["release", "Review the release checklist", "/projects/harbor-api"],
              ["api", "Document the API endpoints", "/projects/harbor-api"],
              ["guide", "Outline the getting started guide", "/projects/field-notes"],
            ].map(([id, title, projectDirectory]) => ({
              ...session,
              id,
              title,
              projectDirectory,
              home: "default",
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
    const previewToggle = demo.getByRole("button", {
      name: label("Terminal Preview"),
      exact: true,
    });
    if ((await previewToggle.getAttribute("aria-expanded")) !== "true") await previewToggle.click();
    await demo.getByLabel(label("Terminal Preview content"), { exact: true }).waitFor();
    await demo
      .getByRole("textbox", { name: label("Message to agent") })
      .fill("Suggest the next step.");
    await demo.evaluate(() => document.fonts.ready);
  }

  async function verifyAttachments() {
    const trigger = demo.getByRole("button", { name: label("Attach files"), exact: true });
    const composer = demo.getByRole("textbox", { name: label("Message to agent") });
    await trigger.click();
    const menu = demo.getByRole("menu", { name: label("Attach files") });
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
    await demo.getByRole("menuitem", { name: label("Choose images") }).click();
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
    const thumbnail = demo.getByRole("button", { name: label("Preview photo.png"), exact: true });
    await thumbnail.click();
    await demo.getByRole("dialog", { name: label("Preview photo.png"), exact: true }).waitFor();
    await demo.keyboard.press("Escape");
    if (!(await thumbnail.evaluate((element) => document.activeElement === element)))
      throw new Error("Image preview did not restore thumbnail focus");
    if (sentMessages.length) throw new Error("Upload sent without user confirmation");
    await demo.waitForFunction(
      () => document.querySelector(".interaction-send")?.getAttribute("aria-disabled") !== "true",
    );
    await demo.getByRole("button", { name: label("Send"), exact: true }).click();
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
    await demo.getByRole("menuitem", { name: label("Take photo") }).click();
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
      const remove = demo.getByRole("button", { name: label(`Remove ${kind}.txt`), exact: true });
      await remove.waitFor();
      await remove.click();
      if (uploadedNames.pop() !== `${kind}.txt`) throw new Error(`Unexpected ${kind} filename`);
    }
    const previewToggle = demo.getByRole("button", {
      name: label("Terminal Preview"),
      exact: true,
    });
    const previewWasExpanded = (await previewToggle.getAttribute("aria-expanded")) === "true";
    await composer.fill("Draft survives switching sessions");
    await demo.evaluate(() => {
      history.pushState(null, "", "/sessions/docs-demo-session-keyboard");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await demo.getByRole("textbox", { name: label("Message to agent") }).waitFor();
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
      await demo.getByLabel(label("Terminal Preview content"), { exact: true }).waitFor();
    }
    await composer.fill("Suggest the next step.");
  }

  async function stageAttachment() {
    const buffer = await demo.locator(".user-input-card").screenshot();
    imageBuffer = buffer;
    await demo.getByLabel(label("Choose files"), { exact: true }).setInputFiles({
      name: "dashboard.png",
      mimeType: "image/png",
      buffer,
    });
    const image = demo.getByRole("img", { name: label("dashboard.png"), exact: true });
    await image.waitFor();
    await image.evaluate((element) => element.decode());
  }

  async function verifyUploadHistory() {
    const composer = demo.getByRole("textbox", { name: label("Message to agent") });
    await composer.fill("Keep this draft while browsing uploads");
    await stageAttachment();
    await demo.getByRole("link", { name: label("Upload history"), exact: true }).click();
    await demo.getByRole("heading", { name: label("Upload history"), exact: true }).waitFor();
    await demo.getByRole("button", { name: label("Expand dashboard.png"), exact: true }).click();
    await demo
      .getByRole("button", { name: label("Collapse dashboard.png"), exact: true })
      .waitFor();
    if (await demo.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("Upload history horizontal overflow");
    if (demo.viewportSize().width > 600) {
      await demo.screenshot({
        path: output.replace(/[^/]+$/, "ahub-uploads.png"),
        animations: "disabled",
      });
    }
    await demo.goBack();
    await composer.waitFor();
    if ((await composer.inputValue()) !== "Keep this draft while browsing uploads")
      throw new Error("History lost draft text");
    await demo.getByRole("button", { name: label("Remove dashboard.png"), exact: true }).waitFor();
    await demo.goForward();
    await demo.getByRole("heading", { name: label("Upload history"), exact: true }).waitFor();
    await demo.reload();
    await demo.getByRole("button", { name: label("Delete"), exact: true }).click();
    await demo.getByRole("button", { name: label("Cancel"), exact: true }).click();
    await demo.getByRole("button", { name: label("Delete"), exact: true }).click();
    await demo.getByRole("button", { name: label("Confirm delete"), exact: true }).click();
    await demo.getByRole("alert").waitFor();
    await demo.getByRole("button", { name: label("Confirm delete"), exact: true }).click();
    await demo.getByText(label("No uploads yet."), { exact: true }).waitFor();
    await demo.getByRole("link", { name: label("← Back to session"), exact: true }).click();
    await composer.waitFor();
    historyDeleted = false;
    await prepareDesktopPreview();
  }

  async function assertDesktopCardsVisible() {
    for (const selector of [".user-input-card", ".interaction-panel"]) {
      const bounds = await demo.locator(selector).boundingBox();
      if (!bounds || bounds.y < 0 || bounds.y + bounds.height > 1500)
        throw new Error(`${selector} is clipped`);
    }
  }

  await mockDocsTerminal(context, timestamp);
  try {
    await demo.goto(`${origin}/sessions/${session.id}`);
    await prepareDesktopPreview();
    const selectedProject = demo.getByRole("button", {
      name: new RegExp(
        label("{{project}}, {{count, number}} main sessions", {
          project: "atlas-dashboard",
          count: ".*",
        }),
      ),
    });
    await selectedProject.waitFor();
    if ((await selectedProject.getAttribute("aria-expanded")) !== "true")
      throw new Error("Opening a session must expand its project");
    await verifyCompactInteraction();
    await verifyAttachments();
    await prepareDesktopPreview();
    for (const name of ["Message to agent", "Terminal Preview content"]) {
      if (!(await demo.getByLabel(label(name), { exact: true }).isVisible()))
        throw new Error(`${name} is hidden`);
    }
    if (!(await demo.getByRole("button", { name: label("Handoff"), exact: true }).isVisible()))
      throw new Error("Handoff is hidden");
    if (errors.length) throw new Error(errors.join("\n"));
    if (await demo.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("Horizontal overflow");
    await demo.locator(".user-input-status.answered").waitFor();
    await demo
      .getByText(label("Project health selected. Ready for the next step."), { exact: false })
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
    await demo.getByRole("button", { name: label("Settings"), exact: true }).click();
    const enterToSend = demo.getByRole("checkbox", {
      name: label("Enter to send (Shift+Enter for newline)"),
      exact: true,
    });
    await enterToSend.check();
    await demo.getByRole("button", { name: label("Close settings"), exact: true }).click();
    await demo.reload();
    const shortcutComposer = demo.getByRole("textbox", { name: label("Message to agent") });
    await shortcutComposer.waitFor();
    if (
      !(await shortcutComposer.getAttribute("placeholder")).includes(
        label("Shift+Enter for newline"),
      )
    )
      throw new Error("Send shortcut was not restored after reload");
    await shortcutComposer.fill("/help");
    await shortcutComposer.press("Shift+Enter");
    if ((await shortcutComposer.inputValue()) !== "/help\n")
      throw new Error("Shift+Enter did not insert a newline");
    await shortcutComposer.fill("");
    await demo.getByRole("button", { name: label("Settings"), exact: true }).click();
    await enterToSend.uncheck();
    await demo.getByRole("button", { name: label("Close settings"), exact: true }).click();
    await demo.setViewportSize({ width: 390, height: 844 });
    await demo.goto(origin);
    for (const project of ["atlas-dashboard", "harbor-api", "field-notes"]) {
      const toggle = demo.getByRole("button", {
        name: new RegExp(
          label("{{project}}, {{count, number}} main sessions", { project, count: ".*" }),
        ),
      });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    }
    await demo.getByText(session.title, { exact: true }).waitFor();
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
    await demo.getByRole("button", { name: label("Terminal Preview"), exact: true }).click();
    const composer = demo.getByRole("textbox", { name: label("Message to agent") });
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
    await demo.getByRole("button", { name: label("Remove dashboard.png"), exact: true }).click();
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
    await demo.getByRole("button", { name: label("Terminal Preview"), exact: true }).click();
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
      phase: "response",
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
    await demo.getByRole("heading", { name: label("Plan 2"), exact: true }).waitFor();
    await plans.nth(0).click();
    await demo.getByRole("heading", { name: label("Plan 1"), exact: true }).waitFor();
    if ((await plans.nth(1).getAttribute("aria-expanded")) !== "true")
      throw new Error("Manually opening an older plan closed the latest plan");
    await plans.nth(1).click();
    if ((await plans.nth(1).getAttribute("aria-expanded")) !== "false")
      throw new Error("Latest plan cannot be manually hidden");
    // Exercise the actual setting, rather than only seeding localized screenshots.
    const draft = demo.locator("textarea");
    await draft.fill("Preserve this draft /original/path");
    const originalInput = await draft.elementHandle();
    const nextLanguage = language === "en" ? "zh-CN" : "en";
    await demo.getByRole("button", { name: label("Settings"), exact: true }).click();
    await demo
      .getByRole("combobox", {
        name: label("Language"),
        exact: true,
      })
      .selectOption(nextLanguage);
    await demo.waitForFunction((value) => document.documentElement.lang === value, nextLanguage);
    await demo
      .getByRole("button", {
        name: nextLanguage === "en" ? "Close settings" : "关闭设置",
        exact: true,
      })
      .click();
    await demo
      .getByRole("textbox", {
        name: nextLanguage === "en" ? "Message to agent" : "发送给智能体的消息",
        exact: true,
      })
      .waitFor();
    if (
      !(await draft.evaluate((element, original) => element === original, originalInput)) ||
      (await draft.inputValue()) !== "Preserve this draft /original/path"
    )
      throw new Error("Language switching remounted or cleared the draft");
    await demo.reload();
    await demo.waitForFunction((value) => document.documentElement.lang === value, nextLanguage);
    const otherTab = await context.newPage();
    await otherTab.goto(origin);
    await otherTab.waitForFunction(
      (value) => document.documentElement.lang === value,
      nextLanguage,
    );
    await otherTab.evaluate((value) => {
      const settings = JSON.parse(localStorage.getItem("ahub.preferences.v1"));
      localStorage.setItem("ahub.preferences.v1", JSON.stringify({ ...settings, language: value }));
    }, language);
    await demo.waitForFunction((value) => document.documentElement.lang === value, language);
    await otherTab.close();
    if (errors.length) throw new Error(errors.join("\n"));
  } catch (error) {
    await demo.screenshot({ path: "/tmp/ahub-capture-failure.png" });
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
  `(page) => (${captureSource(capture, language)})(page, ${[origin, output, translateFixture(docsSession, language), connectedInteraction, docsTimestamp, translateFixture(docsItems, language)].map((value) => JSON.stringify(value)).join(", ")}, ${mockDocsTerminal.toString()})`,
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

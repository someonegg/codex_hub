import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer as createProxy, request } from "node:http";
import { copyFile, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { DiffStore } from "../dist/server/server/hosting/diff-store.js";
import { HostingStore } from "../dist/server/server/hosting/store.js";
import { createServer, listenServer } from "../dist/server/server/http/create-server.js";
import {
  TEST_CA,
  TEST_CLIENT_CERTIFICATE,
  TEST_CLIENT_KEY,
  TEST_SERVER_CERTIFICATE,
  TEST_SERVER_KEY,
} from "../tests/server/tls-fixtures.ts";
import { docsSession, docsTimestamp } from "./docs-fixtures.mjs";

// Run after npm run build. Exercises real files over HTTP, mTLS and a cookie-gated proxy.
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "hub-hosting-browser-"));
const servers = [];
const session = `hosting-${Date.now()}`;
const cli = (...args) =>
  exec("playwright-cli", [`-s=${session}`, ...args], { maxBuffer: 1024 * 1024 });
try {
  const source = join(directory, "source");
  await mkdir(source);
  const assets = resolve("dist/client/assets");
  const font = (await readdir(assets)).find((name) => name.endsWith(".woff2"));
  await copyFile(join(assets, font), join(source, "font.woff2"));
  await writeFile(
    join(source, "index.html"),
    `<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><h1>Hosted demo</h1><img src="./image.svg" alt="Test image"><script>window.inlineLoaded = true</script><script src="./classic.js"></script><script type="module" src="./main.js"></script><script src="https://cdn.example.test/demo.js"></script></body></html>`,
  );
  await writeFile(
    join(source, "style.css"),
    '@font-face{font-family:Demo;src:url("./font.woff2")}h1{font-family:Demo;color:rgb(12,34,56)}',
  );
  await writeFile(join(source, "classic.js"), "window.classicLoaded = true");
  await writeFile(join(source, "module.js"), 'export const value = "module-ok"');
  await writeFile(
    join(source, "main.js"),
    'import { value } from "./module.js"; const data = await (await fetch("./data.json")).json(); window.moduleLoaded = value; window.jsonLoaded = data.ok;',
  );
  await writeFile(join(source, "data.json"), '{"ok":true}');
  await writeFile(
    join(source, "image.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>',
  );
  const hosting = join(directory, "hosting");
  const store = new HostingStore(hosting);
  const artifact = await store.publish(source, directory, "demo", "Design comparison");
  const diffFile = join(directory, "review.diff");
  await writeFile(
    diffFile,
    `diff --git a/src/greeting.ts b/src/greeting.ts
--- a/src/greeting.ts
+++ b/src/greeting.ts
@@ -1,3 +1,4 @@
 export function greeting(name: string) {
-  return "Hello " + name;
+  const label = name.trim() || "world";
+  return \`Hello \${label}!\`;
 }
 diff --git a/README.md b/README.md
`.replace(" diff --git", "diff --git") +
      `--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Greetings
+Safe text: <script>window.diffUnsafe = true</script>
`,
  );
  const diff = await new DiffStore(hosting).publish(diffFile, "Review · Friendlier greetings");
  const config = {
    homes: [],
    host: "127.0.0.1",
    port: 0,
    clientDirectory: resolve("dist/client"),
    tls: { enabled: false },
    interactionEnabled: false,
    hostingDirectory: hosting,
  };
  const server = createServer(config);
  await listenServer(server, 0, config.host);
  servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cookieProxy = createProxy((incoming, outgoing) => {
    if (!incoming.headers.cookie?.includes("hub-test=allowed")) {
      outgoing.writeHead(401);
      outgoing.end();
      return;
    }
    const forwarded = request(
      origin + incoming.url,
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      },
    );
    forwarded.on("error", () => outgoing.destroy());
    incoming.pipe(forwarded);
  });
  await listenServer(cookieProxy, 0, config.host);
  servers.push(cookieProxy);
  const proxyOrigin = `http://127.0.0.1:${cookieProxy.address().port}`;
  assert.equal((await fetch(proxyOrigin + artifact.url)).status, 401);
  assert.equal((await fetch(proxyOrigin + diff.url)).status, 401);
  assert.equal((await fetch(proxyOrigin + "/api/v1/diffs/" + diff.id)).status, 401);
  for (const [name, content] of Object.entries({
    "ca.crt": TEST_CA,
    "server.crt": TEST_SERVER_CERTIFICATE,
    "server.key": TEST_SERVER_KEY,
    "client.crt": TEST_CLIENT_CERTIFICATE,
    "client.key": TEST_CLIENT_KEY,
  }))
    await writeFile(join(directory, name), content);
  const secureHosting = join(directory, "secure-hosting");
  const secureArtifact = await new HostingStore(secureHosting).publish(source, directory);
  const secureDiff = await new DiffStore(secureHosting).publish(diffFile, "Secure review");
  const secure = createServer({
    ...config,
    hostingDirectory: secureHosting,
    tls: {
      enabled: true,
      certificatePath: join(directory, "server.crt"),
      privateKeyPath: join(directory, "server.key"),
      certificateAuthorityPath: join(directory, "ca.crt"),
    },
  });
  await listenServer(secure, 0, config.host);
  servers.push(secure);
  const secureOrigin = `https://127.0.0.1:${secure.address().port}`;
  const browserCode = async (page, settings, docsSession, timestamp) => {
    const browser = page.context().browser();
    const verifyAssets = async (context, origin, url) => {
      await context.route("https://cdn.example.test/demo.js", (route) =>
        route.fulfill({ contentType: "text/javascript", body: "window.cdnLoaded = true" }),
      );
      const demo = await context.newPage();
      await demo.goto(origin + url);
      await demo.waitForFunction(
        () =>
          window.inlineLoaded &&
          window.classicLoaded &&
          window.moduleLoaded === "module-ok" &&
          window.jsonLoaded &&
          window.cdnLoaded,
      );
      await demo.evaluate(() => document.fonts.ready);
      const state = await demo.evaluate(() => ({
        color: getComputedStyle(document.querySelector("h1")).color,
        font: document.fonts.check("16px Demo"),
        image: document.querySelector("img").naturalWidth,
      }));
      if (state.color !== "rgb(12, 34, 56)" || !state.font || state.image !== 16)
        throw new Error("Resource loading failed: " + JSON.stringify(state));
      await demo.close();
    };
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "UTC",
      permissions: ["clipboard-read", "clipboard-write"],
      viewport: { width: 1280, height: 900 },
    });
    await context.route("**/api/v1/artifacts", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      for (const project of data.projects) {
        project.directory = "/projects/atlas-dashboard";
        for (const artifact of project.artifacts) artifact.updatedAt = timestamp;
      }
      await route.fulfill({ response, json: data });
    });
    await verifyAssets(context, settings.origin, settings.url);
    const review = await context.newPage();
    await review.goto(settings.origin + settings.diffUrl);
    await review.getByRole("heading", { name: "Review · Friendlier greetings" }).waitFor();
    if (
      (await review.getByRole("link", { name: "Codex Hub", exact: true }).count()) ||
      (await review.getByRole("combobox").count())
    )
      throw new Error("Diff should not show Hub navigation or theme controls");
    const lightBackground = await review
      .locator(".diff-page")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await review.evaluate(() => (document.documentElement.dataset.theme = "warm"));
    if (
      (await review
        .locator(".diff-page")
        .evaluate((element) => getComputedStyle(element).backgroundColor)) !== lightBackground
    )
      throw new Error("Hub theme leaked into diff styling");
    if (await review.locator('[role="status"]').count())
      throw new Error("Valid diff was not parsed");
    if (await review.evaluate(() => window.diffUnsafe)) throw new Error("Diff HTML executed");
    await review.getByRole("link", { name: "README.md", exact: true }).click();
    if (!review.url().endsWith("#file-1")) throw new Error("File navigation failed");
    await review.locator("#file-1 summary").click();
    if ((await review.locator("#file-1").getAttribute("open")) !== null)
      throw new Error("Collapse failed");
    await review.locator("#file-1 summary").click();
    await review.screenshot({ path: settings.diffScreenshot, fullPage: true });
    await review.setViewportSize({ width: 390, height: 844 });
    if (await review.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("Diff mobile overflow");
    await review.screenshot({ path: settings.diffMobileScreenshot, fullPage: true });
    if (await review.getByText("View original diff", { exact: true }).count())
      throw new Error("Valid diff should hide raw text controls");
    const folder = review
      .locator(".diff-tree details")
      .filter({ has: review.getByText("src", { exact: true }) });
    await folder.locator("summary").first().click();
    if (await review.getByRole("link", { name: "greeting.ts", exact: true }).isVisible())
      throw new Error("Directory did not collapse");
    await folder.locator("summary").first().click();
    await review.getByRole("link", { name: "greeting.ts", exact: true }).click();
    if (!review.url().endsWith("#file-0")) throw new Error("Tree file navigation failed");
    const hub = await context.newPage();
    await hub.goto(settings.origin + "/");
    const originalUrl = hub.url();
    const [demo] = await Promise.all([
      context.waitForEvent("page"),
      hub.getByRole("link", { name: "Pages", exact: true }).click(),
    ]);
    await demo.waitForURL(settings.origin + "/artifacts");
    if (hub.url() !== originalUrl) throw new Error("Pages replaced the original tab");
    const design = demo.locator("article").filter({ hasText: "Design comparison" });
    await demo.getByRole("heading", { name: "Design comparison" }).waitFor();
    await design.getByRole("button", { name: "Copy link" }).click();
    if (
      (await demo.evaluate(() => navigator.clipboard.readText())) !==
      settings.origin + settings.url
    )
      throw new Error("Copied link does not use current origin");
    await demo.getByRole("button", { name: "Refresh" }).click();
    await demo.waitForFunction(() => !document.querySelector(".artifacts-heading button").disabled);
    await demo.getByText("Loading pages…", { exact: true }).waitFor({ state: "hidden" });
    await demo.screenshot({ path: settings.screenshot });
    await demo.setViewportSize({ width: 390, height: 844 });
    if (await demo.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("Mobile horizontal overflow");
    await design.getByRole("button", { name: "Copy link" }).click();
    demo.once("dialog", (dialog) => dialog.dismiss());
    await design.getByRole("button", { name: "Delete" }).click();
    await demo.getByRole("heading", { name: "Design comparison" }).waitFor();
    await demo.screenshot({ path: settings.mobileScreenshot });
    // Read a hosted-page Markdown link through the actual session reader.
    await context.route("**/api/v1/sessions**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const session = { ...docsSession, itemCount: 1, messageCount: 1 };
      if (path === "/api/v1/sessions")
        return route.fulfill({ json: { revision: "demo", homes: [], projects: [], sessions: [] } });
      if (path.endsWith("/updates")) return route.fulfill({ status: 204 });
      const snapshot = {
        session,
        interaction: { supported: false },
        cursor: "demo",
        updateRevision: "demo",
        hasMore: false,
      };
      return route.fulfill({
        json: path.endsWith("/items")
          ? {
              ...snapshot,
              items: [
                {
                  id: "hosted-link",
                  ordinal: 0,
                  timestamp,
                  kind: "message",
                  role: "assistant",
                  phase: "final",
                  itemType: null,
                  markdown: `[Published page](${settings.url})\n[Review diff](${settings.diffUrl})`,
                },
              ],
            }
          : snapshot,
      });
    });
    await demo.goto(settings.origin + "/sessions/" + docsSession.id);
    const link = demo.getByRole("link", { name: "Published page" });
    await link.waitFor();
    if ((await link.getAttribute("href")) !== settings.url)
      throw new Error("Markdown link was filtered");
    const diffLink = demo.getByRole("link", { name: "Review diff", exact: true });
    if (
      (await diffLink.getAttribute("target")) !== "_blank" ||
      (await diffLink.getAttribute("href")) !== settings.diffUrl
    )
      throw new Error("Diff session link was filtered");
    await demo.goto(settings.origin + "/artifacts");
    demo.once("dialog", (dialog) => dialog.accept());
    await design.getByRole("button", { name: "Delete" }).click();
    await demo.getByRole("heading", { name: "Design comparison" }).waitFor({ state: "detached" });
    if ((await context.request.get(settings.origin + settings.url)).status() !== 404)
      throw new Error("Deleted page is still available");
    const proxy = await browser.newContext();
    await proxy.addCookies([{ name: "hub-test", value: "allowed", url: settings.proxyOrigin }]);
    // The proxy artifact remains available after management deletes the first artifact.
    await verifyAssets(proxy, settings.proxyOrigin, settings.proxyUrl);
    const proxyReview = await proxy.newPage();
    await proxyReview.goto(settings.proxyOrigin + settings.diffUrl);
    await proxyReview.getByRole("heading", { name: "Review · Friendlier greetings" }).waitFor();
    await proxy.close();
    const mtls = await browser.newContext({
      ignoreHTTPSErrors: true,
      clientCertificates: [
        {
          origin: settings.secureOrigin,
          certPath: settings.clientCert,
          keyPath: settings.clientKey,
        },
      ],
    });
    await verifyAssets(mtls, settings.secureOrigin, settings.secureUrl);
    const secureReview = await mtls.newPage();
    await secureReview.goto(settings.secureOrigin + settings.secureDiffUrl);
    await secureReview.getByRole("heading", { name: "Secure review" }).waitFor();
    await mtls.close();
    if (
      (await review.request.delete(settings.origin + "/api/v1" + settings.diffUrl)).status() !== 204
    )
      throw new Error("Diff delete failed");
    const refreshed = await review.reload();
    if (refreshed.status() !== 404) throw new Error("Deleted diff page should return 404");
    await review
      .getByRole("alert")
      .filter({ hasText: "Diff not found or already cleaned up." })
      .waitFor();
    await context.close();
  };
  // Keep a separate artifact for the proxy after the management deletion.
  const proxyArtifact = await store.publish(source, directory, "proxy-demo", "Proxy demo");
  const code = join(directory, "browser.js");
  const settings = {
    origin,
    diffUrl: diff.url,
    secureDiffUrl: secureDiff.url,
    diffScreenshot: resolve("docs/images/codex-hub-diff.png"),
    diffMobileScreenshot: resolve("docs/images/codex-hub-diff-mobile.png"),
    proxyOrigin,
    secureOrigin,
    url: artifact.url,
    proxyUrl: proxyArtifact.url,
    secureUrl: secureArtifact.url,
    clientCert: join(directory, "client.crt"),
    clientKey: join(directory, "client.key"),
    screenshot: resolve("docs/images/codex-hub-web-pages.png"),
    mobileScreenshot: resolve("docs/images/codex-hub-web-pages-mobile.png"),
  };
  await writeFile(
    code,
    `(page) => (${browserCode.toString()})(page, ${JSON.stringify(settings)}, ${JSON.stringify(docsSession)}, ${JSON.stringify(docsTimestamp)})`,
  );
  await cli("open", "about:blank");
  const result = await cli("run-code", "--filename", code);
  if (/### Error/.test(result.stdout)) throw new Error(result.stdout);
  console.log(
    "Hosting browser checks passed: desktop/mobile management, Markdown, resources, cookie proxy and mTLS",
  );
} finally {
  await cli("close").catch(() => {});
  for (const server of servers.reverse())
    await new Promise((done) => {
      server.close(done);
      server.closeAllConnections();
    });
  await rm(directory, { recursive: true, force: true });
}

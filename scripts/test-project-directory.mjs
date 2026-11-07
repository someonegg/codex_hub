import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "ahub-project-directory-"));
const session = `project-directory-${Date.now()}`;
async function verify(page, output) {
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/capabilities") return route.fulfill({ json: { hosting: true } });
    if (path !== "/api/v1/sessions") throw new Error(`Unexpected API: ${path}`);
    return route.fulfill({
      json: {
        revision: "1",
        agents: [
          { nickname: "default", runtimeName: "Codex" },
          { nickname: "work", runtimeName: "Claude Code" },
        ],
        projects: Array.from({ length: 24 }, (_, index) => ({
          directory: `/projects/project-${String(index).padStart(2, "0")}/${"long-path-".repeat(8)}`,
        })),
        sessions: [],
      },
    });
  });
  await page.goto("http://127.0.0.1:4187");
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 492, height: 410 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "New session", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "New session", exact: true });
    const baseline = await dialog.evaluate((element) => element.scrollHeight);
    const field = page.getByRole("combobox", { name: "Project directory", exact: true });
    await field.click();
    const list = page.getByRole("listbox");
    await list.waitFor();
    const check = async () => {
      const metrics = await list.evaluate((element) => {
        const dialog = element.closest("dialog");
        const rect = element.getBoundingClientRect();
        return {
          topLayer: element.matches(":popover-open"),
          dialogHeight: dialog.scrollHeight,
          fits:
            rect.top >= 0 &&
            rect.bottom <= innerHeight &&
            rect.left >= 0 &&
            rect.right <= innerWidth,
          scrolls: element.scrollHeight > element.clientHeight,
          horizontalOverflow: dialog.scrollWidth > dialog.clientWidth,
        };
      });
      if (
        !metrics.topLayer ||
        metrics.dialogHeight !== baseline ||
        !metrics.fits ||
        metrics.horizontalOverflow
      )
        throw new Error(JSON.stringify({ viewport, baseline, ...metrics }));
      return metrics;
    };
    if (!(await check()).scrolls) throw new Error("Long project list should scroll internally");
    for (let index = 0; index < 24; index++) await field.press("ArrowDown");
    await check();
    await page.screenshot({ path: `${output}/${viewport.width}x${viewport.height}.png` });
    const selected = list.getByRole("option", { selected: true });
    await selected.click();
    if (!(await field.inputValue()).includes("project-23")) throw new Error("Selection failed");
    await field.click();
    await field.press("Escape");
    await list.waitFor({ state: "hidden" });
    if (!(await dialog.isVisible()))
      throw new Error("Escape closed the dialog instead of the list");
    await page.getByRole("button", { name: "Close new session" }).click();
  }
  return "Project directory overflow, viewport bounds, keyboard, click and Escape checks passed";
}
const source = join(directory, "verify.js");
await writeFile(source, `(page) => (${verify.toString()})(page, ${JSON.stringify(directory)})`);
const cli = (...args) => {
  const result = execFileSync("playwright-cli", [`-s=${session}`, ...args], { encoding: "utf8" });
  if (result.includes("### Error")) throw new Error(result);
  return result;
};
try {
  cli("open", "about:blank");
  const result = cli("run-code", "--filename", source);
  if (!result.includes("### Result")) throw new Error(result);
  console.log(`Project directory browser checks passed; screenshots: ${directory}`);
} finally {
  cli("close");
}

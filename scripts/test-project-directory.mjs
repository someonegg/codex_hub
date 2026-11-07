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
    const field = page.getByRole("combobox", { name: "Project directory", exact: true });
    if (!(await field.evaluate((element) => element.tagName === "SELECT")))
      throw new Error("Existing projects must use a native select");
    await field.selectOption({ index: 24 });
    if (await dialog.getByRole("textbox").count())
      throw new Error("Selecting a project exposed a keyboard input");
    await field.focus();
    await dialog.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    if (await page.getByRole("listbox").count()) throw new Error("Floating suggestions remain");
    await field.selectOption("custom");
    const custom = dialog.getByRole("textbox", { name: "Custom directory" });
    if (await custom.evaluate((element) => element === document.activeElement))
      throw new Error("Custom mode must not automatically open the keyboard");
    await custom.fill("/new/project");
    if (!(await custom.inputValue()).includes("/new/project"))
      throw new Error("Custom entry failed");
    await field.selectOption({ index: 1 });
    if (await custom.count()) throw new Error("Custom input remains after selecting a project");
    if (await dialog.evaluate((element) => element.scrollWidth > element.clientWidth))
      throw new Error("Horizontal overflow");
    await page.screenshot({ path: `${output}/${viewport.width}x${viewport.height}.png` });
    await page.getByRole("button", { name: "Close new session" }).click();
  }
  return "Native project selection and explicit custom entry checks passed";
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

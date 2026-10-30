import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const exec = promisify(execFile);
it.each([
  ["unknown"],
  ["page", "list", "--unknown"],
  ["page", "list", "--home-dir"],
  ["diff", "delete", "not-a-uuid"],
  ["diff", "publish", "."],
  ["page", "publish", ".", "--project", ".", "--name", " "],
  ["page", "nonsense"],
  ["page", "delete"],
  ["page", "publish", "."],
  ["diff", "nonsense"],
  ["diff", "delete"],
  ["diff", "list", "extra"],
])("reports invalid resource arguments: %j", async (...args) => {
  const result = await exec(process.execPath, [
    "--import",
    "tsx",
    "src/server/cli/main.ts",
    ...args,
    "--json",
  ]).catch((error) => error);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).error.code).toBe("invalid_arguments");
});

const invalidOptionCases = [
  { resource: "page", action: "list", options: ["project", "name", "title"] },
  { resource: "page", action: "delete", options: ["project", "name", "title"] },
  { resource: "diff", action: "publish", options: ["project", "name"] },
  { resource: "diff", action: "list", options: ["project", "name", "title"] },
  { resource: "diff", action: "delete", options: ["project", "name", "title"] },
];
const invalidOptions = invalidOptionCases.flatMap(({ resource, action, options }) =>
  options.flatMap((option) => [false, true].map((json) => ({ resource, action, option, json }))),
);
it.each(invalidOptions)(
  "rejects inapplicable options: %j",
  async ({ resource, action, option, json }) => {
    const result = await exec(process.execPath, [
      "--import",
      "tsx",
      "src/server/cli/main.ts",
      resource,
      action,
      ...(action === "list" ? [] : ["/missing-source"]),
      `--${option}`,
      "value",
      ...(json ? ["--json"] : []),
    ]).catch((error) => error);
    expect(result.code).toBe(1);
    const message = json ? JSON.parse(result.stdout).error.message : result.stderr;
    expect(message).toContain(`--${option}`);
    expect(message).toContain(`${resource} ${action}`);
    if (json) {
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).error.code).toBe("invalid_arguments");
    } else expect(result.stdout).toBe("");
  },
);

it.each(["page", "diff"])(
  "accepts legal %s options through publish, list and delete",
  async (resource) => {
    const root = await mkdtemp(join(tmpdir(), "resource-cli-"));
    const home = join(root, "home");
    const source = join(root, "source");
    const run = async (...args: string[]) => {
      const result = await exec(process.execPath, [
        "--import",
        "tsx",
        "src/server/cli/main.ts",
        resource,
        ...args,
        "--home-dir",
        home,
        "--json",
      ]);
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout);
    };
    try {
      await mkdir(source);
      await writeFile(join(source, "index.html"), "<h1>Test</h1>");
      const file = join(root, "test.diff");
      await writeFile(file, "diff --git a/test b/test\n");
      const published = await run(
        "publish",
        resource === "page" ? source : file,
        ...(resource === "page" ? ["--project", root, "--name", "example"] : []),
        "--title",
        "Example",
      );
      expect(published.title).toBe("Example");
      if (resource === "page") expect(published.name).toBe("example");
      expect(await run("list")).toEqual([published]);
      expect(await run("delete", published.id)).toEqual({ id: published.id, deleted: true });
      expect(await run("list")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("preserves help before checking inapplicable options", async () => {
  const result = await exec(process.execPath, [
    "--import",
    "tsx",
    "src/server/cli/main.ts",
    "diff",
    "list",
    "--project",
    "unused",
    "--help",
    "--json",
  ]);
  expect(result.stdout).toContain("Usage: ahub-cli diff");
  expect(result.stderr).toBe("");
});

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import stringWidth from "string-width";
import { expect, it } from "vitest";

import { CommandError } from "../../src/server/cli/command-error.js";
import { parseResourceArguments, validateResourcePublish } from "../../src/server/cli/resource.js";

const exec = promisify(execFile);
it.each([
  ["page", "list", ["--unknown"]],
  ["page", "list", ["--home-dir"]],
  ["diff", "publish", []],
  ["page", "nonsense", []],
  ["page", "delete", []],
  ["diff", "list", ["extra"]],
] as const)("rejects invalid resource arguments: %s %s %j", (resource, action, args) => {
  expect(() => parseResourceArguments(resource, action, [...args])).toThrow(CommandError);
  expect(() => parseResourceArguments(resource, action, [...args])).toThrow(
    expect.objectContaining({ code: "invalid_arguments" }),
  );
});

it.each([true, false])("wires resource errors to the correct stream (json=%s)", async (json) => {
  const result = await exec(process.execPath, [
    "--import",
    "tsx",
    "src/server/cli/main.ts",
    "page",
    "list",
    "--unknown",
    ...(json ? ["--json"] : []),
  ]).catch((error) => error);
  expect(result.code).toBe(1);
  if (json) {
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).error.code).toBe("invalid_arguments");
  } else {
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--unknown");
  }
});

// Cover each resource/action policy and restricted option directly.
// Process tests above own output stream selection.
const invalidOptions = [
  { resource: "page", action: "list", option: "project" },
  { resource: "page", action: "delete", option: "name" },
  { resource: "diff", action: "publish", option: "project" },
  { resource: "diff", action: "publish", option: "name" },
  { resource: "diff", action: "list", option: "title" },
  { resource: "diff", action: "delete", option: "title" },
];
it.each(invalidOptions)("rejects inapplicable options: %j", ({ resource, action, option }) => {
  const args = [...(action === "list" ? [] : ["/missing-source"]), `--${option}`, "value"];
  expect(() => parseResourceArguments(resource, action, args)).toThrow(
    `Option --${option} is not supported for ${resource} ${action}`,
  );
  expect(() => parseResourceArguments(resource, action, args)).toThrow(CommandError);
});

it.each(["page", "diff"])(
  "accepts legal %s options through publish, list and delete",
  async (resource) => {
    const root = await mkdtemp(join(tmpdir(), "resource-cli-"));
    const home = join(root, "home");
    const source = join(root, "source");
    const runText = async (...args: string[]) => {
      const result = await exec(process.execPath, [
        "--import",
        "tsx",
        "src/server/cli/main.ts",
        resource,
        ...args,
        "--home-dir",
        home,
      ]);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    const run = async (...args: string[]) => JSON.parse(await runText(...args, "--json"));
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
      const unicode = await run(
        "publish",
        resource === "page" ? source : file,
        ...(resource === "page" ? ["--project", root, "--name", "unicode"] : []),
        "--title",
        "© / ©️ / ™ / ™️\n中文👩🏽‍💻",
      );
      const human = await runText("list");
      expect(human).not.toContain("\t");
      const lines = human.trimEnd().split("\n");
      expect(lines).toHaveLength(3);
      const header = lines[0]!;
      for (const entry of [published, unicode]) {
        const line = lines.find((value) => value.startsWith(entry.id))!;
        const title = entry.title.replace(/[\r\n\t]/g, " ");
        expect(line).toContain(title);
        expect(line.endsWith(entry.url)).toBe(true);
        expect(stringWidth(line.slice(0, line.indexOf(title)))).toBe(header.indexOf("TITLE"));
        expect(stringWidth(line.slice(0, line.indexOf(entry.url)))).toBe(header.indexOf("URL"));
        if (resource === "page") expect(line).toContain(root);
      }
      // JSON retains the original multiline title, rather than the table's sanitized cell.
      expect(await run("list")).toEqual(expect.arrayContaining([published, unicode]));
      expect(unicode.title).toBe("© / ©️ / ™ / ™️\n中文👩🏽‍💻");
      await run("delete", unicode.id);
      expect(await run("delete", published.id)).toEqual({ id: published.id, deleted: true });
      expect(await run("list")).toEqual([]);
      expect(await runText("list")).toBe(
        resource === "page"
          ? "ID  PROJECT  TITLE  URL\nNo pages.\n"
          : "ID  TITLE  URL\nNo diffs.\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("preserves help before checking inapplicable options", () => {
  expect(
    parseResourceArguments("diff", "list", ["--project", "unused", "--help", "--json"]).help,
  ).toBe(true);
});

it("parses publication options and requires a project for pages", () => {
  expect(
    parseResourceArguments("page", "publish", [
      "source",
      "--project",
      "project",
      "--title",
      "Title",
      "--json",
    ]),
  ).toMatchObject({
    help: false,
    positionals: ["source"],
    values: { project: "project", title: "Title", json: true },
  });
  expect(() => validateResourcePublish("page", undefined)).toThrow(
    "page publish requires --project",
  );
  expect(validateResourcePublish("page", ".")).toBeUndefined();
  expect(validateResourcePublish("diff", undefined)).toBeUndefined();
});
it("rejects unknown top-level commands", async () => {
  const result = await exec(process.execPath, [
    "--import",
    "tsx",
    "src/server/cli/main.ts",
    "unknown",
    "--json",
  ]).catch((error) => error);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).error).toMatchObject({
    code: "invalid_arguments",
    message: expect.stringContaining("Unknown command: unknown"),
  });
});

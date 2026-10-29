import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
it.each([
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

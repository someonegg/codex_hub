import { join } from "node:path";
import { parseArgs } from "node:util";

import { resolveHomeDirectory } from "../config.js";
import { DiffStore } from "../hosting/diff-store.js";
import { HostingStore } from "../hosting/store.js";

function resourceHelp(resource: string): string {
  const publishUsage =
    resource === "page"
      ? "page publish <directory> --project <directory> [--name <name>]"
      : `${resource} publish <file>`;
  return `Usage: ahub-cli ${resource} <command> [options]
  ${publishUsage} [--title <title>]
  ${resource} list
  ${resource} delete <id>
Options: --home-dir <directory> --json --help
Commands operate on local Hub storage (default: ~/.codex-hub).`;
}

export async function runResourceCommand(
  resource: string,
  action: string | undefined,
  args: string[],
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      name: { type: "string" },
      title: { type: "string" },
      "home-dir": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help || action === "--help" || action === undefined) {
    console.log(resourceHelp(resource));
    return;
  }
  if (
    !["publish", "list", "delete"].includes(action) ||
    positionals.length !== (action === "list" ? 0 : 1)
  )
    throw new Error("Expected page/diff publish <source>, list, or delete <id>");
  const directory = join(resolveHomeDirectory(values["home-dir"]), "hosting");
  const pages = new HostingStore(directory);
  const diffs = new DiffStore(directory);
  let result: object;
  if (action === "publish") {
    if (resource === "page" && !values.project) throw new Error("page publish requires --project");
    const entry =
      resource === "page"
        ? await pages.publish(positionals[0], values.project!, values.name, values.title)
        : await diffs.publish(positionals[0], values.title);
    const title = entry.title.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
    console.log(values.json ? JSON.stringify(entry) : `${entry.url}\n[${title}](${entry.url})`);
    return;
  }
  if (action === "list") {
    result =
      resource === "page"
        ? (await pages.entries()).map(({ artifact }) => artifact)
        : await diffs.list();
  } else {
    if (resource === "page") await pages.delete(positionals[0]);
    else await diffs.delete(positionals[0]);
    result = { id: positionals[0], deleted: true };
  }
  console.log(JSON.stringify(result, null, values.json ? undefined : 2));
}

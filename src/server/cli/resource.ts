import { join } from "node:path";
import { parseArgs } from "node:util";

import { resolveHomeDirectory } from "../config.js";
import { DiffStore } from "../hosting/diff-store.js";
import { HostingStore } from "../hosting/store.js";
import { CommandError } from "./command-error.js";
import { output, singleLine } from "./output.js";

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
  const { values, positionals } = parseResourceArgs(args);
  if (values.help || action === "--help" || action === undefined) {
    console.log(resourceHelp(resource));
    return;
  }
  if (
    !["publish", "list", "delete"].includes(action) ||
    positionals.length !== (action === "list" ? 0 : 1)
  )
    throw new CommandError(
      "invalid_arguments",
      "Expected page/diff publish <source>, list, or delete <id>",
    );
  const allowed = new Set(["home-dir", "json", "help"]);
  if (action === "publish") {
    allowed.add("title");
    if (resource === "page") {
      allowed.add("project");
      allowed.add("name");
    }
  }
  for (const option of Object.keys(values)) {
    if (!allowed.has(option))
      throw new CommandError(
        "invalid_arguments",
        `Option --${option} is not supported for ${resource} ${action}`,
      );
  }
  const directory = join(resolveHomeDirectory(values["home-dir"]), "hosting");
  const pages = new HostingStore(directory);
  const diffs = new DiffStore(directory);
  if (action === "publish") {
    if (resource === "page" && !values.project)
      throw new CommandError("invalid_arguments", "page publish requires --project");
    const entry =
      resource === "page"
        ? await pages.publish(positionals[0], values.project!, values.name, values.title)
        : await diffs.publish(positionals[0], values.title);
    const title = entry.title.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
    console.log(values.json ? JSON.stringify(entry) : `${entry.url}\n[${title}](${entry.url})`);
    return;
  }
  if (action === "list") {
    const entries =
      resource === "page"
        ? (await pages.entries()).map(({ artifact }) => artifact)
        : await diffs.list();
    output(entries, values.json ?? false, formatResourceList(resource, entries));
    return;
  }
  if (resource === "page") await pages.delete(positionals[0]);
  else await diffs.delete(positionals[0]);
  output(
    { id: positionals[0], deleted: true },
    values.json ?? false,
    `Deleted ${resource} ${positionals[0]}`,
  );
}

function formatResourceList(
  resource: string,
  entries: Array<{ id: string; project?: string; title: string; url: string }>,
): string {
  const lines = [resource === "page" ? "ID\tPROJECT\tTITLE\tURL" : "ID\tTITLE\tURL"];
  for (const entry of entries) {
    const fields = [entry.id];
    if (resource === "page") fields.push(entry.project ?? "");
    fields.push(entry.title, entry.url);
    lines.push(fields.map(singleLine).join("\t"));
  }
  if (entries.length === 0) lines.push(`No ${resource === "page" ? "pages" : "diffs"}.`);
  return lines.join("\n");
}

function parseResourceArgs(args: string[]) {
  try {
    return parseArgs({
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
  } catch (error) {
    throw new CommandError(
      "invalid_arguments",
      error instanceof Error ? error.message : "Invalid arguments",
    );
  }
}

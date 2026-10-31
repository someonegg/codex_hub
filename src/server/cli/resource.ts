import { join } from "node:path";
import { parseArgs } from "node:util";

import { resolveHomeDirectory } from "../config.js";
import { DiffStore } from "../hosting/diff-store.js";
import { HostingStore } from "../hosting/store.js";
import { CommandError } from "./command-error.js";
import { formatTable, output } from "./output.js";

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
  const { values, positionals, help } = parseResourceArguments(resource, action, args);
  if (help) {
    console.log(resourceHelp(resource));
    return;
  }
  const directory = join(resolveHomeDirectory(values["home-dir"]), "hosting");
  const pages = new HostingStore(directory);
  const diffs = new DiffStore(directory);
  if (action === "publish") {
    validateResourcePublish(resource, values.project);
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
  const table = formatTable(
    resource === "page" ? ["ID", "PROJECT", "TITLE", "URL"] : ["ID", "TITLE", "URL"],
    entries.map((entry) => [
      entry.id,
      ...(resource === "page" ? [entry.project ?? ""] : []),
      entry.title,
      entry.url,
    ]),
  );
  return table + (entries.length ? "" : `\nNo ${resource === "page" ? "pages" : "diffs"}.`);
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

export function parseResourceArguments(
  resource: string,
  action: string | undefined,
  args: string[],
) {
  const { values, positionals } = parseResourceArgs(args);
  if (values.help || action === "--help" || action === undefined) {
    return { values, positionals, help: true as const };
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
  return { values, positionals, help: false as const };
}

export function validateResourcePublish(resource: string, project: string | undefined): void {
  if (resource === "page" && !project)
    throw new CommandError("invalid_arguments", "page publish requires --project");
}

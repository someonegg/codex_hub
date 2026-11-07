import { parseArgs } from "node:util";

import type { SessionListResponse } from "../../shared/api-contract.js";
import { CommandError, commandFailure } from "./command-error.js";
import { formatTable, output, outputFailure } from "./output.js";
import { SessionClient } from "./session-client.js";

export function catalogHelp(kind: "project" | "agent"): string {
  return `Usage: ahub-cli ${kind} list [options]
  list      List known ${kind === "project" ? "project directories" : "agents"}
Options: --url <http(s)-url> --json --timeout <seconds> (default 15) --help
Address: --url, AGENT_HUB_URL, http://127.0.0.1:4173`;
}

export function parseCatalogArguments(args: string[], environmentUrl?: string) {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        url: { type: "string" },
        json: { type: "boolean" },
        timeout: { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help || positionals.length === 0) return { help: true as const, values };
    if (positionals[0] !== "list" || positionals.length !== 1)
      throw new Error("Expected list with no positional arguments");
    const seconds = values.timeout === undefined ? 15 : Number(values.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647)
      throw new Error("timeout must be a positive number of seconds within the supported range");
    const base = new URL(values.url ?? environmentUrl ?? "http://127.0.0.1:4173");
    if (base.protocol !== "http:" && base.protocol !== "https:")
      throw new Error("Only HTTP and HTTPS URLs are supported");
    if (base.username || base.password || base.search || base.hash || base.pathname !== "/")
      throw new Error("URL must contain only an HTTP or HTTPS origin");
    return { help: false as const, values, seconds, base };
  } catch (error) {
    throw new CommandError(
      "invalid_arguments",
      error instanceof Error ? error.message : String(error),
    );
  }
}

// Code-point ordering is independent of the host locale.
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export async function runCatalogCommand(kind: "project" | "agent", args: string[]): Promise<void> {
  let json = args.includes("--json");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const parsed = parseCatalogArguments(args, process.env.AGENT_HUB_URL);
    json = parsed.values.json ?? false;
    if (parsed.help) {
      console.log(catalogHelp(kind));
      return;
    }
    timer = setTimeout(interrupt, parsed.seconds * 1000);
    const client = new SessionClient(parsed.base, abort.signal);
    const list = await client.request<SessionListResponse>("/api/v1/sessions");
    if (kind === "project") {
      const projects = [...new Set(list.projects.map(({ directory }) => directory))]
        .sort(compare)
        .map((directory) => ({ directory }));
      output(
        projects,
        json,
        formatTable(
          ["DIRECTORY"],
          projects.map(({ directory }) => [directory]),
        ),
      );
    } else {
      const agents = [...list.agents].sort(
        (a, b) => compare(a.nickname, b.nickname) || compare(a.runtimeName, b.runtimeName),
      );
      output(
        agents,
        json,
        formatTable(
          ["NICKNAME", "RUNTIME", "ARCHIVE"],
          agents.map(({ nickname, runtimeName, management }) => [
            nickname,
            runtimeName,
            management === undefined ? "-" : String(management.archive),
          ]),
        ),
      );
    }
  } catch (error) {
    outputFailure(commandFailure(error, false), json);
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

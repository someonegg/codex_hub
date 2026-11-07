#!/usr/bin/env node
import { packageVersion } from "../version.js";
import { CommandError } from "./command-error.js";
import { outputFailure } from "./output.js";
const help = `Usage: ahub-cli <command> [options]
  page      Publish, list, or delete local hosted pages
  diff      Publish, list, or delete local review diffs
  skill     Locate bundled skills
  project   List known project directories
  agent     List known agents
  session   Manage sessions through an existing Hub HTTP server
  version   Show the current version (alias: --version)
Run ahub-cli <command> --help for details.`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help") {
    console.log(help);
    return;
  }
  if (command === "version" || command === "--version") {
    if (args.length > 0) throw new CommandError("invalid_arguments", "Usage: ahub-cli version");
    console.log(await packageVersion());
  } else if (command === "skill") {
    const { runSkillCommand } = await import("./skill.js");
    await runSkillCommand(args);
  } else if (command === "project" || command === "agent") {
    const { runCatalogCommand } = await import("./catalog.js");
    await runCatalogCommand(command, args);
  } else if (command === "session") {
    const { runSessionCommand } = await import("./session.js");
    await runSessionCommand(args);
  } else if (command === "page" || command === "diff") {
    const { runResourceCommand } = await import("./resource.js");
    await runResourceCommand(command, args[0], args.slice(1));
  } else {
    throw new CommandError("invalid_arguments", `Unknown command: ${command}\n${help}`);
  }
}
main().catch((error: unknown) => {
  outputFailure(error, process.argv.slice(2).includes("--json"));
});

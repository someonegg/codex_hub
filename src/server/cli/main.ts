#!/usr/bin/env node
import { outputFailure } from "./output.js";
const help = `Usage: ahub-cli <command> [options]
  page      Publish, list, or delete local hosted pages
  diff      Publish, list, or delete local review diffs
  session   Manage sessions through an existing Hub HTTP server
Run ahub-cli <command> --help for details.`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help") {
    console.log(help);
    return;
  }
  if (command === "session") {
    const { runSessionCommand } = await import("./session.js");
    await runSessionCommand(args);
  } else if (command === "page" || command === "diff") {
    const { runResourceCommand } = await import("./resource.js");
    await runResourceCommand(command, args[0], args.slice(1));
  } else {
    throw new Error(`Unknown command: ${command}\n${help}`);
  }
}
main().catch((error: unknown) => {
  outputFailure(error, process.argv.slice(2).includes("--json"));
});

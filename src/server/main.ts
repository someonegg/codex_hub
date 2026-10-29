#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";

import { commandLineHelp, loadConfig, resolveHomeDirectory } from "./config.js";
import { createCodexHub } from "./create-hub.js";
import { DiffStore } from "./hosting/diff-store.js";
import { HostingStore } from "./hosting/store.js";
import { createApiRouter } from "./http/api-router.js";
import { startServer } from "./http/create-server.js";
import { createTerminalPreviewWebSocket } from "./http/terminal-preview-websocket.js";
import { uploadDirectory } from "./http/upload-routes.js";
import { UploadStore } from "./uploads/store.js";

async function runResourceCommand(resource: string, action: string, args: string[]): Promise<void> {
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
  if (values.help || action === "--help") {
    console.log(commandLineHelp());
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

async function main(): Promise<void> {
  if (["page", "diff"].includes(process.argv[2])) {
    await runResourceCommand(process.argv[2], process.argv[3], process.argv.slice(4));
    return;
  }
  const command = loadConfig();
  if (command.kind === "help") {
    console.log(commandLineHelp());
    return;
  }

  const { config } = command;
  const uploads = new UploadStore(await uploadDirectory(config.uploadDirectory));
  await uploads.initialize();
  const hub = await createCodexHub(
    config.homes,
    config.tmuxSocket,
    config.interactionEnabled,
    uploads,
  );
  const server = await startServer(
    config,
    createApiRouter({ ...hub, uploads }),
    hub.close,
    createTerminalPreviewWebSocket(hub.interaction),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  const protocol = config.tls.enabled ? "https" : "http";
  const mutualTls =
    config.tls.enabled && config.tls.certificateAuthorityPath
      ? " (client certificates required)"
      : "";
  console.log(`Codex Hub listening on ${protocol}://${host}:${port}${mutualTls}`);

  function close(): void {
    server.close((error) => {
      if (error) {
        console.error("Failed to stop Codex Hub");
        process.exitCode = 1;
      }
    });
  }

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Failed to start Codex Hub");
  process.exitCode = 1;
});

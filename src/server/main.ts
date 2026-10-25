#!/usr/bin/env node
import { parseArgs } from "node:util";

import { commandLineHelp, loadConfig } from "./config.js";
import { createCodexHub } from "./create-hub.js";
import { HostingStore } from "./hosting/store.js";
import { createApiRouter } from "./http/api-router.js";
import { startServer } from "./http/create-server.js";
import { createTerminalPreviewWebSocket } from "./http/terminal-preview-websocket.js";
import { uploadDirectory } from "./http/upload-routes.js";

async function main(): Promise<void> {
  if (process.argv[2] === "publish") {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(3),
      allowPositionals: true,
      options: {
        project: { type: "string" },
        name: { type: "string" },
        title: { type: "string" },
        "hosting-dir": { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      console.log(commandLineHelp());
      return;
    }
    if (positionals.length !== 1 || !values.project)
      throw new Error("publish requires a source directory and --project");
    const artifact = await new HostingStore(values["hosting-dir"]).publish(
      positionals[0],
      values.project,
      values.name,
      values.title,
    );
    console.log(
      values.json
        ? JSON.stringify(artifact)
        : `${artifact.url}\n[${artifact.title.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ")}](${artifact.url})`,
    );
    return;
  }
  const command = loadConfig();
  if (command.kind === "help") {
    console.log(commandLineHelp());
    return;
  }

  const { config } = command;
  await uploadDirectory(config.uploadDirectory);
  const hub = await createCodexHub(config.homes, config.tmuxSocket, config.interactionEnabled);
  const server = await startServer(
    config,
    createApiRouter({ ...hub, uploadDirectory: config.uploadDirectory }),
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

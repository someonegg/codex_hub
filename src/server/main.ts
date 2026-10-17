import { commandLineHelp, loadConfig } from "./config.js";
import { createCodexHub } from "./create-hub.js";
import { createApiRouter } from "./http/api-router.js";
import { startServer } from "./http/create-server.js";

async function main(): Promise<void> {
  const command = loadConfig();
  if (command.kind === "help") {
    console.log(commandLineHelp());
    return;
  }

  const { config } = command;
  const hub = await createCodexHub(config.codexHome, config.tmuxSocket, config.interactionEnabled);
  const server = await startServer(config, createApiRouter(hub), hub.close);
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

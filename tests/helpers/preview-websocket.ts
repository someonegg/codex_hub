import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import WebSocket, { type ClientOptions } from "ws";

import type { TerminalPreviewMessage } from "../../src/shared/api-contract.js";

import type { ServerConfig } from "../../src/server/config.js";
import { createServer } from "../../src/server/http/create-server.js";
import { createTerminalPreviewWebSocket } from "../../src/server/http/terminal-preview-websocket.js";
import type { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import { createTempDirectory } from "./temp-directories.js";

export const PREVIEW_SESSION_ID = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
export async function startPreviewServer(
  interaction?: Pick<SessionInteractionService, "subscribePreview">,
  tls: ServerConfig["tls"] = { enabled: false },
) {
  const directory = await createTempDirectory("codex-preview-websocket-");
  await writeFile(join(directory, "index.html"), "hub");
  const upgrades = createTerminalPreviewWebSocket(interaction);
  const server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      homes: [],
      clientDirectory: directory,
      tls,
      interactionEnabled: true,
    },
    undefined,
    () => {},
    upgrades,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `${tls.enabled ? "https" : "http"}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = origin.replace(/^http/, "ws");
  const clients: WebSocket[] = [];
  return {
    server,
    origin,
    base,
    connect(session = PREVIEW_SESSION_ID, options?: ClientOptions) {
      const socket = new WebSocket(`${base}/api/v1/sessions/${session}/terminal-preview`, options);
      clients.push(socket);
      const messages: TerminalPreviewMessage[] = [];
      socket.on("message", (data) =>
        messages.push(JSON.parse(data.toString()) as TerminalPreviewMessage),
      );
      socket.on("error", () => {});
      return { socket, messages };
    },
    async close() {
      // Exercise the server's shutdown path before releasing test clients.
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const socket of clients) socket.terminate();
    },
  };
}

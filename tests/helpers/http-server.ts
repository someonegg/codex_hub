import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { LOOPBACK_HOST } from "../../src/server/config.js";
import { createServer, listenServer } from "../../src/server/http/create-server.js";
import type { ApiRouter } from "../../src/server/http/router.js";
import { cleanupAfterEach } from "./cleanup.js";
import { createTempDirectory } from "./temp-directories.js";

export async function startHttpServer(routes: ApiRouter, closeServices: () => void) {
  const clientDirectory = await createTempDirectory("codex-test-client-");
  await writeFile(join(clientDirectory, "index.html"), "<h1>hub</h1>");
  const server = createServer(
    {
      host: LOOPBACK_HOST,
      port: 0,
      homes: [],
      clientDirectory,
      tls: { enabled: false },
      interactionEnabled: false,
    },
    routes,
    closeServices,
  );
  cleanupAfterEach(async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await listenServer(server, 0, LOOPBACK_HOST);
  return { server, base: `http://${LOOPBACK_HOST}:${(server.address() as AddressInfo).port}` };
}

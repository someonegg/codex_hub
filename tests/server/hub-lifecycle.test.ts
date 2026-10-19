import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import type { ServerConfig } from "../../src/server/config.js";
import { createCodexHub } from "../../src/server/create-hub.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import type { createServer } from "../../src/server/http/create-server.js";
import { startServer } from "../../src/server/http/create-server.js";
import { emptyApiRouter } from "../../src/server/http/router.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

async function config(): Promise<ServerConfig> {
  const home = await createTempDirectory("codex-lifecycle-");
  const clientDirectory = join(home, "client");
  await mkdir(clientDirectory);
  await writeFile(join(clientDirectory, "index.html"), "hub");
  return {
    host: "127.0.0.1",
    port: 0,
    homes: [{ nickname: "default", path: home }],
    clientDirectory,
    tls: { enabled: false },
    interactionEnabled: false,
  };
}

it("closes the composed services once before waiting for HTTP connections", async () => {
  const settings = await config();
  const hub = await createCodexHub(settings.homes, undefined, false);
  const catalogClose = vi.spyOn(hub.catalog, "close");
  const updatesClose = vi.spyOn(hub.updates, "close");
  const operationsClose = vi.spyOn(hub.operations, "close");
  const interactionClose = vi.spyOn(hub.interaction, "close");
  let server: ReturnType<typeof createServer>;
  const close = vi.fn(() => {
    expect(server.listening).toBe(true);
    hub.close();
  });
  server = await startServer(settings, createApiRouter(hub), close);
  try {
    const catalog = await hub.catalog.wait();
    const waiting = hub.catalog.wait(catalog!.revision);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const released = expect(waiting).resolves.toBeNull();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await released;
    hub.close();
    hub.close();
    expect(close).toHaveBeenCalledOnce();
    expect(catalogClose).toHaveBeenCalledOnce();
    expect(updatesClose).toHaveBeenCalledOnce();
    expect(operationsClose).toHaveBeenCalledOnce();
    expect(interactionClose).toHaveBeenCalledOnce();
    await expect(hub.catalog.wait()).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    hub.close();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("releases services if server construction or listening fails", async () => {
  const settings = await config();
  const constructionCleanup = vi.fn();
  await expect(
    startServer(
      { ...settings, clientDirectory: join(settings.clientDirectory, "missing") },
      emptyApiRouter,
      constructionCleanup,
    ),
  ).rejects.toThrow();
  expect(constructionCleanup).toHaveBeenCalledOnce();
  const occupied = await startServer(settings, emptyApiRouter, () => {});
  const listenCleanup = vi.fn();
  try {
    await expect(
      startServer(
        { ...settings, port: (occupied.address() as AddressInfo).port },
        emptyApiRouter,
        listenCleanup,
      ),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(listenCleanup).toHaveBeenCalledOnce();
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

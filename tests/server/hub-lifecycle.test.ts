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
  const hub = await createCodexHub({ homes: settings.homes, interactionEnabled: false });
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
  const constructionUpgrades = { handle: vi.fn(), close: vi.fn() };
  await expect(
    startServer(
      { ...settings, clientDirectory: join(settings.clientDirectory, "missing") },
      emptyApiRouter,
      constructionCleanup,
      constructionUpgrades,
    ),
  ).rejects.toThrow();
  expect(constructionCleanup).toHaveBeenCalledOnce();
  expect(constructionUpgrades.close).toHaveBeenCalledOnce();
  const occupied = await startServer(settings, emptyApiRouter, () => {});
  const listenCleanup = vi.fn();
  const listenUpgrades = { handle: vi.fn(), close: vi.fn() };
  try {
    await expect(
      startServer(
        { ...settings, port: (occupied.address() as AddressInfo).port },
        emptyApiRouter,
        listenCleanup,
        listenUpgrades,
      ),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(listenCleanup).toHaveBeenCalledOnce();
    expect(listenUpgrades.close).toHaveBeenCalledOnce();
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

it("isolates pane bindings between hubs and after closing and recreating a hub", async () => {
  const settings = await config();
  const sessions = join(settings.homes[0]!.path, "sessions");
  await mkdir(sessions);
  const rollout = join(sessions, "rollout-isolation.jsonl");
  const metadata =
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z",
      type: "session_meta",
      payload: { id: "11111111-1111-4111-8111-111111111111", cwd: settings.clientDirectory },
    }) + "\n";
  const invalidBinding =
    JSON.stringify({
      timestamp: "2026-01-01T00:00:01Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<user_shell_command>\nAHUB_TMUX_BIND_V1\ninvalid\n%1\n\n</user_shell_command>",
          },
        ],
      },
    }) + "\n";
  await writeFile(rollout, metadata + invalidBinding);
  const first = await createCodexHub({ homes: settings.homes });
  let second: Awaited<ReturnType<typeof createCodexHub>> | undefined;
  try {
    const session = (await first.sessions.list()).sessions[0]!;
    expect(await first.interaction.describe(session.id)).toMatchObject({ state: "disconnected" });

    // The same source identity now has no binding. Only the first hub saw the old event.
    await writeFile(rollout, metadata);
    second = await createCodexHub({ homes: settings.homes });
    const nextSession = (await second.sessions.list()).sessions[0]!;
    expect(nextSession.id).toBe(session.id);
    expect(await second.interaction.describe(session.id)).toMatchObject({ state: "unbound" });
    expect(await first.interaction.describe(session.id)).toMatchObject({ state: "disconnected" });

    first.close();
    const recreated = await createCodexHub({ homes: settings.homes });
    try {
      expect(await recreated.interaction.describe(session.id)).toMatchObject({ state: "unbound" });
    } finally {
      recreated.close();
    }
  } finally {
    first.close();
    second?.close();
  }
});

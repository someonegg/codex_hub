import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionReader } from "../../src/server/application/session-reader.js";
import { SessionCatalogService } from "../../src/server/catalog/session-catalog-service.js";
import { LOOPBACK_HOST, type ServerConfig } from "../../src/server/config.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { createServer } from "../../src/server/http/create-server.js";
import { PreviewCapacityError } from "../../src/server/interaction/terminal-preview-service.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import type { SessionDetail } from "../../src/shared/domain.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const SESSION_ID = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
const SESSION: SessionDetail = {
  id: SESSION_ID,
  origin: {
    sourceType: "test",
    sourceInstanceId: "test",
    agentName: "Test",
    agentVersion: null,
    formatVersion: null,
  },
  title: "Session",
  nickname: null,
  workingDirectory: null,
  projectDirectory: null,
  createdAt: null,
  updatedAt: null,
  status: "normal",
  resume: { allowed: false, reason: "Unavailable" },
  parentId: null,
  childIds: [],
  agent: null,
  messageCount: 0,
  toolCount: 0,
  sourceId: "session",
  itemCount: 0,
};
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function start() {
  const clientDirectory = await createTempDirectory("codex-interaction-http-");
  await writeFile(join(clientDirectory, "index.html"), "hub");
  const unavailable = async () => null;
  const repository: SessionReader = {
    list: vi.fn(),
    getSession: vi.fn().mockResolvedValue({ session: SESSION }),
    getItems: unavailable,
    getSessionUpdates: unavailable,
    getToolDetail: unavailable,
    getDirectiveDetail: unavailable,
    getInternalDetail: unavailable,
    getInteractionSession: unavailable,
    refresh: vi.fn(),
  };
  const interaction = {
    describe: vi.fn().mockResolvedValue({
      supported: true,
      supersededBySessionId: null,
      attachCommand: null,
      state: "connected",
    }),
    handoffPaneBinding: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    preview: vi.fn().mockResolvedValue({
      content: "terminal output",
      truncated: false,
      capturedAt: "2026-08-08T12:00:00.000Z",
      revision: "a".repeat(43),
    }),
  };
  const config: ServerConfig = {
    host: LOOPBACK_HOST,
    port: 0,
    homes: [{ nickname: "default", path: "/unused" }],
    clientDirectory,
    tls: { enabled: false },
    interactionEnabled: true,
  };
  const updates = new SessionUpdatesService(repository);
  const catalog = new SessionCatalogService(repository);
  const server = createServer(
    config,
    createApiRouter({ sessions: repository, catalog, updates, interaction }),
    () => {
      catalog.close();
      updates.close();
    },
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://${LOOPBACK_HOST}:${port}`, interaction };
}

describe("interaction HTTP API", () => {
  it("accepts handoffPaneBinding with an empty object and rejects supplied commands", async () => {
    const { base, interaction } = await start();
    const post = (body: unknown) =>
      fetch(`${base}/api/v1/sessions/${SESSION_ID}/handoff-pane-binding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({})).status).toBe(204);
    expect(interaction.handoffPaneBinding).toHaveBeenCalledWith(SESSION_ID);
    expect((await post({ command: "arbitrary" })).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect(interaction.handoffPaneBinding).toHaveBeenCalledTimes(1);
  });

  it("includes connection state in session reads and accepts messages", async () => {
    const { base, interaction } = await start();
    const detail = await fetch(`${base}/api/v1/sessions/${SESSION_ID}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(
      expect.objectContaining({
        interaction: expect.objectContaining({
          supported: true,
          supersededBySessionId: null,
          attachCommand: null,
          state: "connected",
        }),
      }),
    );
    const message = "first\r\nsecond 🌊";
    const sent = await fetch(`${base}/api/v1/sessions/${SESSION_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    expect(sent.status).toBe(204);
    expect(interaction.sendMessage).toHaveBeenCalledWith(SESSION_ID, message);
  });

  it("validates message and key bodies including their boundaries", async () => {
    const { base, interaction } = await start();
    const postMessage = (message: string) =>
      fetch(`${base}/api/v1/sessions/${SESSION_ID}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
    expect((await postMessage(" \n ")).status).toBe(400);
    expect((await postMessage("a".repeat(65_536))).status).toBe(204);
    expect((await postMessage("a".repeat(65_537))).status).toBe(400);
    expect(interaction.sendMessage).toHaveBeenCalledTimes(1);

    const postKeys = (keys: unknown, extra?: Record<string, unknown>) =>
      fetch(`${base}/api/v1/sessions/${SESSION_ID}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys, ...extra }),
      });
    expect((await postKeys([])).status).toBe(400);
    expect((await postKeys(["unknown"])).status).toBe(400);
    expect((await postKeys(["escape"])).status).toBe(400);
    expect((await postKeys(["enter"], { extra: true })).status).toBe(400);
    expect((await postKeys(Array.from({ length: 65 }, () => "left"))).status).toBe(400);

    const representativeKeys = [
      "enter",
      "up",
      "down",
      "left",
      "right",
      "interrupt",
      "plan",
      "left",
    ];
    const boundaryKeys = [...representativeKeys, ...Array.from({ length: 56 }, () => "left")];
    expect(boundaryKeys).toHaveLength(64);
    const sentKeys = await postKeys(boundaryKeys);
    expect(sentKeys.status).toBe(204);
    expect(interaction.sendKeys).toHaveBeenCalledWith(SESSION_ID, boundaryKeys);
  });

  it("returns an uncached terminal preview and rejects query parameters", async () => {
    const { base, interaction } = await start();
    const response = await fetch(`${base}/api/v1/sessions/${SESSION_ID}/terminal-preview`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      content: "terminal output",
      truncated: false,
      capturedAt: "2026-08-08T12:00:00.000Z",
      revision: "a".repeat(43),
    });
    expect(interaction.preview).toHaveBeenCalledWith(
      SESSION_ID,
      undefined,
      expect.any(AbortSignal),
    );

    expect(
      (await fetch(`${base}/api/v1/sessions/${SESSION_ID}/terminal-preview?lines=all`)).status,
    ).toBe(400);
  });

  it("accepts opaque after, returns 204, and makes HEAD immediate", async () => {
    const { base, interaction } = await start();
    const revision = "a".repeat(43);
    interaction.preview.mockResolvedValueOnce(null);
    const response = await fetch(
      `${base}/api/v1/sessions/${SESSION_ID}/terminal-preview?after=${revision}`,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(interaction.preview).toHaveBeenLastCalledWith(
      SESSION_ID,
      revision,
      expect.any(AbortSignal),
    );
    const head = await fetch(
      `${base}/api/v1/sessions/${SESSION_ID}/terminal-preview?after=${revision}`,
      { method: "HEAD" },
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(interaction.preview).toHaveBeenLastCalledWith(
      SESSION_ID,
      undefined,
      expect.any(AbortSignal),
    );
    for (const query of ["after=bad", `after=${revision}&after=${revision}`, "unexpected=1"]) {
      expect(
        (await fetch(`${base}/api/v1/sessions/${SESSION_ID}/terminal-preview?${query}`)).status,
      ).toBe(400);
    }
  });

  it("returns retry hints for preview wait capacity", async () => {
    const { base, interaction } = await start();
    interaction.preview.mockRejectedValueOnce(new PreviewCapacityError("Too many requests"));
    const response = await fetch(
      `${base}/api/v1/sessions/${SESSION_ID}/terminal-preview?after=${"a".repeat(43)}`,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("allows POST only on the declared interaction routes", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/v1/sessions`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/v1/sessions/${SESSION_ID}`, { method: "POST" })).status).toBe(
      405,
    );
    expect(
      (await fetch(`${base}/api/v1/sessions/${SESSION_ID}/interrupt`, { method: "POST" })).status,
    ).toBe(405);
    expect((await fetch(`${base}/api/v1/unknown`, { method: "POST" })).status).toBe(405);
  });
});

import { describe, expect, it, vi } from "vitest";

import type { SessionReader } from "../../src/server/application/session-reader.js";
import { SessionCatalogService } from "../../src/server/catalog/session-catalog-service.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import { startHttpServer } from "../helpers/http-server.js";
import { sessionDetail } from "../helpers/session-fixtures.js";

const SESSION_ID = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
const SESSION = sessionDetail({ id: SESSION_ID });

async function start() {
  const unavailable = async () => null;
  const repository: SessionReader = {
    list: vi.fn(),
    getSession: vi.fn().mockResolvedValue({
      session: SESSION,
      interactionSession: { archived: false, interaction: null },
    }),
    inspect: async () => null,
    getItems: unavailable,
    readSessionUpdates: unavailable,
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
      activity: "unknown",
      supersededBySessionId: null,
      attachCommand: null,
      state: "connected",
    }),
    describeSnapshot: vi.fn().mockResolvedValue({
      supported: true,
      activity: "unknown",
      supersededBySessionId: null,
      attachCommand: null,
      state: "connected",
    }),
    handoffPaneBinding: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    captureTerminal: vi
      .fn()
      .mockResolvedValue({ content: "screen", capturedAt: "now", truncated: false }),
  };

  const updates = new SessionUpdatesService(repository);
  const catalog = new SessionCatalogService(repository);
  const { base } = await startHttpServer(
    createApiRouter({ sessions: repository, catalog, updates, interaction }),
    () => {
      catalog.close();
      updates.close();
    },
  );
  return { base, interaction };
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
          activity: "unknown",
          supersededBySessionId: null,
          attachCommand: null,
          state: "connected",
        }),
      }),
    );
    expect(interaction.describeSnapshot).toHaveBeenCalledWith(SESSION_ID, {
      archived: false,
      interaction: null,
    });
    expect(interaction.describe).not.toHaveBeenCalled();
    const message = "first\r\nsecond 🌊";
    const sent = await fetch(`${base}/api/v1/sessions/${SESSION_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    expect(sent.status).toBe(204);
    expect(interaction.sendMessage).toHaveBeenCalledWith(SESSION_ID, message);
  });

  it("maps body and message validation failures without invoking interaction", async () => {
    const { base, interaction } = await start();
    const post = (operation: string, body: unknown) =>
      fetch(`${base}/api/v1/sessions/${SESSION_ID}/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const invalidKeys = await post("keys", { keys: [] });
    expect(invalidKeys.status).toBe(400);
    expect(await invalidKeys.json()).toMatchObject({ error: { code: "invalid_json" } });
    const invalidMessage = await post("messages", { message: " " });
    expect(invalidMessage.status).toBe(400);
    expect(await invalidMessage.json()).toMatchObject({ error: { code: "invalid_message" } });
    expect(interaction.sendKeys).not.toHaveBeenCalled();
    expect(interaction.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["GET", "HEAD"])("requires WebSocket for terminal preview (%s)", async (method) => {
    const { base } = await start();
    const response = await fetch(`${base}/api/v1/sessions/${SESSION_ID}/terminal-preview`, {
      method,
    });
    expect(response.status).toBe(426);
    expect(response.headers.get("upgrade")).toBe("websocket");
    expect(response.headers.get("cache-control")).toBe("no-store");
    if (method === "HEAD") expect(await response.text()).toBe("");
    else expect(await response.json()).toMatchObject({ error: { code: "websocket_required" } });
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

it("exposes fresh terminal capture and validates idle input options", async () => {
  const { base, interaction } = await start();
  const root = `${base}/api/v1/sessions/${SESSION_ID}`;
  const terminal = await fetch(`${root}/terminal`);
  expect(terminal.status).toBe(200);
  expect(await terminal.json()).toEqual({ content: "screen", capturedAt: "now", truncated: false });
  expect(interaction.captureTerminal).toHaveBeenCalledWith(SESSION_ID);
  const post = (operation: string, body: unknown) =>
    fetch(`${root}/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  for (const requireIdle of [true, false]) {
    expect((await post("messages", { message: "hello", requireIdle })).status).toBe(204);
    expect(interaction.sendMessage).toHaveBeenLastCalledWith(SESSION_ID, "hello", requireIdle);
    expect((await post("keys", { keys: ["enter"], requireIdle })).status).toBe(204);
    expect(interaction.sendKeys).toHaveBeenLastCalledWith(SESSION_ID, ["enter"], requireIdle);
  }
});

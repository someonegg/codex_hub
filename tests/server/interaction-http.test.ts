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
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "left",
    ];
    const boundaryKeys = [...representativeKeys, ...Array.from({ length: 46 }, () => "left")];
    expect(boundaryKeys).toHaveLength(64);
    const sentKeys = await postKeys(boundaryKeys);
    expect(sentKeys.status).toBe(204);
    expect(interaction.sendKeys).toHaveBeenCalledWith(SESSION_ID, boundaryKeys);
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
  expect((await post("messages", { message: "hello", requireIdle: true })).status).toBe(204);
  expect(interaction.sendMessage).toHaveBeenCalledWith(SESSION_ID, "hello", true);
  expect((await post("keys", { keys: ["enter"], requireIdle: true })).status).toBe(204);
  expect(interaction.sendKeys).toHaveBeenCalledWith(SESSION_ID, ["enter"], true);
  expect((await post("keys", { keys: ["interrupt"], requireIdle: true })).status).toBe(400);
  expect((await post("messages", { message: "hello", requireIdle: "yes" })).status).toBe(400);
});

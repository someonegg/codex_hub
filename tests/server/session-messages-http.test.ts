import { resolve } from "node:path";

import { expect, it } from "vitest";

import { SessionCatalogService } from "../../src/server/catalog/session-catalog-service.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import { startHttpServer } from "../helpers/http-server.js";
import { createCodexSessionReadService } from "./codex-read-helper.js";

it("serves messages from the reader snapshot, with validated pagination and missing-session errors", async () => {
  const sessions = await createCodexSessionReadService(resolve("tests/fixtures/codex-home"));
  const catalog = new SessionCatalogService(sessions);
  const updates = new SessionUpdatesService(sessions);
  const { base } = await startHttpServer(createApiRouter({ sessions, catalog, updates }), () => {
    catalog.close();
    updates.close();
  });
  const session = (await sessions.list()).sessions.find(
    (item) => item.title === "Synthetic trace",
  )!;
  const root = `${base}/api/v1/sessions/${session.id}/messages`;
  const response = await fetch(`${root}?after=0&limit=1`);
  expect(response.status).toBe(200);
  const first = await response.json();
  expect(first.items).toHaveLength(1);
  expect(
    first.items.every((item: { kind: string }) => ["message", "user_input"].includes(item.kind)),
  ).toBe(true);
  expect(first.live).toBe(false);
  expect(first.interaction).toEqual({ supported: false, attachCommand: null });
  expect(first).not.toHaveProperty("interactionSession");
  expect(first.stateRevision).toMatch(/^[\w-]{43}$/);
  const tail = await (await fetch(`${root}?after=${first.nextAfter}`)).json();
  expect(tail.items.every((item: { ordinal: number }) => item.ordinal > first.nextAfter)).toBe(
    true,
  );
  expect((await fetch(`${root}?after=9007199254740991`)).status).toBe(400);
  expect((await fetch(`${root}?limit=0`)).status).toBe(400);
  expect((await fetch(`${root}?after=-1`)).status).toBe(400);
  expect((await fetch(`${root}?after=0&after=1`)).status).toBe(400);
  expect((await fetch(`${base}/api/v1/sessions/${"a".repeat(43)}/messages`)).status).toBe(404);
});

it("long-polls messages with baseline, timeout and disconnect cleanup", async () => {
  const sessions = await createCodexSessionReadService(resolve("tests/fixtures/codex-home"));
  const catalog = new SessionCatalogService(sessions);
  const updates = new SessionUpdatesService(sessions, {
    waitTimeoutMs: 30,
    probeIntervalMs: 5,
    maxWaitersPerSession: 1,
  });
  const { base } = await startHttpServer(createApiRouter({ sessions, catalog, updates }), () => {
    catalog.close();
    updates.close();
  });
  const id = (await sessions.list()).sessions[0]!.id;
  const root = `${base}/api/v1/sessions/${id}/messages`;
  const page = await (await fetch(`${root}?after=0&limit=300`)).json();
  const query = `after=${page.nextAfter}&wait=true`;
  const baseline = await (await fetch(`${root}?${query}`)).json();
  expect(baseline.items).toEqual([]);
  expect((await fetch(`${root}?${query}&stateRevision=${baseline.stateRevision}`)).status).toBe(
    204,
  );
  expect((await fetch(`${root}?wait=1`)).status).toBe(400);
  expect((await fetch(`${root}?stateRevision=invalid`)).status).toBe(400);
  for (const resource of [
    "items",
    "updates",
    "items/id/tool",
    "items/id/directive",
    "items/id/internal",
  ])
    expect((await fetch(`${base}/api/v1/sessions/${id}/${resource}`)).status).toBe(404);
  const abort = new AbortController();
  const pending = fetch(`${root}?${query}&stateRevision=${baseline.stateRevision}`, {
    signal: abort.signal,
  });
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

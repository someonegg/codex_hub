import { resolve } from "node:path";

import { expect, it } from "vitest";

import { SessionCatalogService } from "../../src/server/catalog/session-catalog-service.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import { startHttpServer } from "../helpers/http-server.js";
import { createCodexSessionReadService } from "./codex-read-helper.js";

it("serves inspect from the reader snapshot, with validated pagination and missing-session errors", async () => {
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
  const root = `${base}/api/v1/sessions/${session.id}/inspect`;
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
  expect(first).not.toHaveProperty("updateRevision");
  const tail = await (await fetch(`${root}?after=${first.nextAfter}`)).json();
  expect(tail.items.every((item: { ordinal: number }) => item.ordinal > first.nextAfter)).toBe(
    true,
  );
  expect((await fetch(`${root}?after=9007199254740991`)).status).toBe(400);
  expect((await fetch(`${root}?limit=0`)).status).toBe(400);
  expect((await fetch(`${root}?after=-1`)).status).toBe(400);
  expect((await fetch(`${root}?after=0&after=1`)).status).toBe(400);
  expect((await fetch(`${base}/api/v1/sessions/${"a".repeat(43)}/inspect`)).status).toBe(404);
});

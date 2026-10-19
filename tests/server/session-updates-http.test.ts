import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionReader } from "../../src/server/application/session-reader.js";
import { SessionCatalogService } from "../../src/server/catalog/session-catalog-service.js";
import { LOOPBACK_HOST, type ServerConfig } from "../../src/server/config.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { createServer } from "../../src/server/http/create-server.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import type { TimelineCursor, UpdateRevision } from "../../src/shared/api-contract.js";
import type { SessionDetail } from "../../src/shared/domain.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const SESSION_ID = "abcdefghijklmnopqrstuvwx";
const CURSOR = "opaque.timeline.cursor" as TimelineCursor;
const REVISION = "a".repeat(43) as UpdateRevision;
const OTHER_REVISION = "b".repeat(43) as UpdateRevision;
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("automatic update HTTP API", () => {
  it("does not take ownership of injected services", () => {
    const unavailable = async () => null;
    const sessions = {
      list: vi.fn(),
      getSession: unavailable,
      getItems: unavailable,
      getSessionUpdates: unavailable,
      getToolDetail: unavailable,
      getDirectiveDetail: unavailable,
      getInternalDetail: unavailable,
      getInteractionSession: unavailable,
      refresh: vi.fn(),
    } satisfies SessionReader;
    const updates = new SessionUpdatesService(sessions);
    const close = vi.spyOn(updates, "close");

    const catalog = new SessionCatalogService(sessions);
    createApiRouter({ sessions, catalog, updates });

    expect(close).not.toHaveBeenCalled();
    catalog.close();
    updates.close();
  });

  it("returns 200, 204, 400, and 404 with no-store semantics", async () => {
    const getSessionUpdates = vi
      .fn<SessionReader["getSessionUpdates"]>()
      .mockResolvedValue(snapshot(false));
    const { base } = await start(getSessionUpdates, { waitTimeoutMs: 12, probeIntervalMs: 4 });
    const changed = await fetch(url(base, OTHER_REVISION));
    expect(changed.status).toBe(200);
    expect(changed.headers.get("cache-control")).toBe("no-store");
    expect(await changed.json()).toEqual(
      expect.objectContaining({
        cursor: CURSOR,
        hasMore: false,
        updateRevision: REVISION,
      }),
    );

    const head = await fetch(url(base, OTHER_REVISION), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(await head.text()).toBe("");

    expect((await fetch(url(base, REVISION))).status).toBe(204);
    expect(
      (await fetch(`${base}/api/v1/sessions/${SESSION_ID}/updates?after=${REVISION}`)).status,
    ).toBe(400);
    expect(
      (await fetch(`${base}/api/v1/sessions/${SESSION_ID}/updates?cursor=x&after=bad`)).status,
    ).toBe(400);
    getSessionUpdates.mockResolvedValue(null);
    expect((await fetch(url(base, OTHER_REVISION))).status).toBe(404);
  });

  it.each([
    ["cursor=x&after=REV&unknown=x", "unknown is not supported"],
    ["cursor=x&cursor=y&after=REV", "cursor must appear once"],
    ["cursor=x&after=REV&after=REV", "after must appear once"],
    ["after=REV", "cursor is required for automatic updates"],
    ["cursor=x", "after is required for automatic updates"],
  ])("preserves query validation for %s", async (query, message) => {
    const getSessionUpdates = vi
      .fn<SessionReader["getSessionUpdates"]>()
      .mockResolvedValue(snapshot(false));
    const { base } = await start(getSessionUpdates, {});
    const response = await fetch(
      `${base}/api/v1/sessions/${SESSION_ID}/updates?${query.replaceAll("REV", REVISION)}`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_query", message } });
    expect(getSessionUpdates).not.toHaveBeenCalled();
  });

  it("returns 429 at capacity and releases the slot when the client disconnects", async () => {
    const getSessionUpdates = vi
      .fn<SessionReader["getSessionUpdates"]>()
      .mockResolvedValue(snapshot(false));
    const { base } = await start(getSessionUpdates, {
      waitTimeoutMs: 5_000,
      probeIntervalMs: 1_000,
      maxWaiters: 1,
      maxWaitersPerSession: 1,
    });
    const abort = new AbortController();
    const pending = fetch(url(base, REVISION), { signal: abort.signal });
    await vi.waitFor(() => expect(getSessionUpdates).toHaveBeenCalled());
    const limited = await fetch(url(base, REVISION));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      error: { code: "updates_capacity_exceeded" },
    });
    expect(limited.headers.get("retry-after")).toBe("2");
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    getSessionUpdates.mockResolvedValue(snapshot(true));
    await vi.waitFor(async () => {
      const recovered = await fetch(url(base, REVISION));
      expect(recovered.status).toBe(200);
    });
  });
});

async function start(
  getSessionUpdates: SessionReader["getSessionUpdates"],
  options: ConstructorParameters<typeof SessionUpdatesService>[1],
) {
  const clientDirectory = await createTempDirectory("codex-session-updates-http-");
  await writeFile(join(clientDirectory, "index.html"), "hub");
  const unavailable = async () => null;
  const repository = {
    list: vi.fn(),
    getSession: unavailable,
    getItems: unavailable,
    getSessionUpdates,
    getToolDetail: unavailable,
    getDirectiveDetail: unavailable,
    getInternalDetail: unavailable,
    getInteractionSession: unavailable,
    refresh: vi.fn(),
  } satisfies SessionReader;
  const updates = new SessionUpdatesService(repository, {
    createRevision: () => REVISION,
    ...options,
  });
  const config: ServerConfig = {
    host: LOOPBACK_HOST,
    port: 0,
    homes: [{ nickname: "default", path: "/unused" }],
    clientDirectory,
    tls: { enabled: false },
    interactionEnabled: false,
  };
  const catalog = new SessionCatalogService(repository);
  const server = createServer(
    config,
    createApiRouter({ sessions: repository, catalog, updates }),
    () => {
      catalog.close();
      updates.close();
    },
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://${LOOPBACK_HOST}:${port}` };
}

function url(base: string, after: UpdateRevision): string {
  return `${base}/api/v1/sessions/${SESSION_ID}/updates?cursor=${encodeURIComponent(CURSOR)}&after=${after}`;
}

function snapshot(hasMore: boolean) {
  return {
    session: SESSION,
    cursor: CURSOR,
    hasMore,
    interactionSession: { archived: false, interaction: null },
  };
}

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

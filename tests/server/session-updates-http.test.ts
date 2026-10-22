import { describe, expect, it, vi } from "vitest";

import type { SessionReader } from "../../src/server/application/session-reader.js";
import { SessionCatalogService } from "../../src/server/catalog/session-catalog-service.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import type { TimelineCursor, UpdateRevision } from "../../src/shared/api-contract.js";
import { startHttpServer } from "../helpers/http-server.js";
import { sessionDetail } from "../helpers/session-fixtures.js";

const SESSION_ID = "abcdefghijklmnopqrstuvwx";
const CURSOR = "opaque.timeline.cursor" as TimelineCursor;
const REVISION = "a".repeat(43) as UpdateRevision;
const OTHER_REVISION = "b".repeat(43) as UpdateRevision;

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
    const { base, updates } = await start(getSessionUpdates, {
      waitTimeoutMs: 5_000,
      probeIntervalMs: 1_000,
      maxWaiters: 1,
      maxWaitersPerSession: 1,
    });
    const wait = vi.spyOn(updates, "wait");
    const abort = new AbortController();
    const pending = fetch(url(base, REVISION), { signal: abort.signal });
    await vi.waitFor(() => expect(getSessionUpdates).toHaveBeenCalled());
    const limited = await fetch(url(base, REVISION));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      error: { code: "updates_capacity_exceeded" },
    });
    expect(limited.headers.get("retry-after")).toBe("2");
    const released = expect(wait.mock.results[0]!.value).rejects.toMatchObject({
      name: "AbortError",
    });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await released;

    // The replacement must enter the wait path before a later probe reports backlog.
    // An immediately changed snapshot would bypass capacity and hide a leaked slot.
    getSessionUpdates.mockResolvedValueOnce(snapshot(false)).mockResolvedValue(snapshot(true));
    const probes = getSessionUpdates.mock.calls.length;
    const recovered = await fetch(url(base, REVISION));
    expect(recovered.status).toBe(200);
    expect(getSessionUpdates.mock.calls.length - probes).toBe(2);
  });
});

async function start(
  getSessionUpdates: SessionReader["getSessionUpdates"],
  options: ConstructorParameters<typeof SessionUpdatesService>[1],
) {
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

  const catalog = new SessionCatalogService(repository);
  const { base } = await startHttpServer(
    createApiRouter({ sessions: repository, catalog, updates }),
    () => {
      catalog.close();
      updates.close();
    },
  );
  return { base, updates };
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

const SESSION = sessionDetail({ id: SESSION_ID });

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CATALOG_PROBE_INTERVAL_MS,
  CATALOG_WAIT_TIMEOUT_MS,
  MAX_CATALOG_WAITERS,
} from "../../src/server/catalog/config.js";
import {
  CatalogCapacityError,
  SessionCatalogService,
} from "../../src/server/catalog/session-catalog-service.js";
import type { SessionListResponse } from "../../src/shared/api-contract.js";

const initial: SessionListResponse = { revision: "a".repeat(43), projects: [], sessions: [] };
function setup() {
  vi.useFakeTimers();
  let snapshot = initial;
  const sessions = { refresh: vi.fn(async () => {}), list: vi.fn(async () => snapshot) };
  const service = new SessionCatalogService(sessions);
  return {
    service,
    sessions,
    change: () => {
      snapshot = { ...initial, revision: "b".repeat(43) };
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
describe("session catalog long polling", () => {
  it("returns the first or different revision immediately, without an idle timer", async () => {
    const { service } = setup();
    expect(await service.wait()).toEqual(initial);
    expect(await service.wait("different")).toEqual(initial);
    expect(vi.getTimerCount()).toBe(0);
    service.close();
  });
  it("shares probes, wakes all waiters on change, and stops when idle", async () => {
    const { service, sessions, change } = setup();
    const waits = Array.from({ length: 10 }, () => service.wait(initial.revision));
    await flush();
    sessions.refresh.mockClear();
    await vi.advanceTimersByTimeAsync(CATALOG_PROBE_INTERVAL_MS - 1);
    expect(sessions.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions.refresh).toHaveBeenCalledTimes(1);
    change();
    await vi.advanceTimersByTimeAsync(CATALOG_PROBE_INTERVAL_MS);
    expect((await Promise.all(waits)).every((value) => value?.revision === "b".repeat(43))).toBe(
      true,
    );
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CATALOG_WAIT_TIMEOUT_MS);
    expect(sessions.refresh).toHaveBeenCalledTimes(2);
    service.close();
  });
  it("times out at the configured boundary on updatedAt-only changes and carries updatedAt on the next snapshot", async () => {
    vi.useFakeTimers();
    let snapshot: SessionListResponse = {
      ...initial,
      sessions: [
        {
          id: "one",
          title: "One",
          projectId: null,
          archived: false,
          parentId: null,
          isChild: false,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const sessions = { refresh: vi.fn(async () => {}), list: async () => snapshot };
    const service = new SessionCatalogService(sessions);
    const first = (await service.wait())!;
    const completed = vi.fn();
    const pending = service.wait(first.revision).then(completed);
    await flush();
    snapshot = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({
        ...session,
        updatedAt: "2030-01-01T00:00:00Z",
      })),
    };
    await vi.advanceTimersByTimeAsync(CATALOG_WAIT_TIMEOUT_MS - 1);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(completed).toHaveBeenCalledWith(null);
    expect(vi.getTimerCount()).toBe(0);
    expect((await service.wait())?.sessions[0]?.updatedAt).toBe("2030-01-01T00:00:00Z");
    service.close();
  });
  it("enforces capacity, frees disconnected slots, and releases every waiter on close", async () => {
    const { service } = setup();
    const controller = new AbortController();
    const first = service.wait(initial.revision, controller.signal);
    const aborted = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const waits = Array.from({ length: MAX_CATALOG_WAITERS - 1 }, () =>
      service.wait(initial.revision),
    );
    await flush();
    await expect(service.wait(initial.revision)).rejects.toBeInstanceOf(CatalogCapacityError);
    controller.abort();
    await aborted;
    const replacement = service.wait(initial.revision);
    await flush();
    service.close();
    expect(await replacement).toBeNull();
    expect(await Promise.all(waits)).toEqual(Array(MAX_CATALOG_WAITERS - 1).fill(null));
    expect(vi.getTimerCount()).toBe(0);
    await expect(service.wait()).rejects.toMatchObject({ name: "AbortError" });
  });
  it("fails waiting requests cleanly when a shared probe fails", async () => {
    const { service, sessions } = setup();
    const pending = service.wait(initial.revision);
    const rejected = expect(pending).rejects.toThrow("source unavailable");
    await flush();
    sessions.refresh.mockRejectedValueOnce(new Error("source unavailable"));
    await vi.advanceTimersByTimeAsync(CATALOG_PROBE_INTERVAL_MS);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    service.close();
  });
});

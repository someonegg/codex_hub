import { afterEach, expect, it, vi } from "vitest";

import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import type { MessageItem } from "../../src/shared/domain.js";
import { sessionDetail } from "../helpers/session-fixtures.js";

const controllers: SessionUpdatesService[] = [];
afterEach(() => {
  controllers.forEach((service) => service.close());
  controllers.length = 0;
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers();
  let title = "Session";
  let items: MessageItem[] = [];
  const service = new SessionUpdatesService(
    {
      readMessages: async () => {
        const snapshot = {
          session: sessionDetail({ title }),
          interactionSession: { archived: false, interaction: null },
          items,
          nextAfter: items.at(-1)?.ordinal ?? 0,
          hasMore: false,
        };
        return Object.assign(
          (query: { after?: number }) => ({
            ...snapshot,
            items: snapshot.items.filter((item) => item.ordinal > (query.after ?? 0)),
          }),
          { state: snapshot },
        );
      },
    },
    { probeIntervalMs: 10, waitTimeoutMs: 50, maxWaiters: 2, maxWaitersPerSession: 1 },
  );
  controllers.push(service);
  return {
    service,
    change: () => {
      title = "Changed";
    },
    append: () => {
      items = [
        {
          kind: "message",
          id: "m",
          ordinal: 7,
          timestamp: null,
          role: "user",
          phase: null,
          itemType: null,
          markdown: "Hello",
        },
      ];
    },
  };
}
it("returns a baseline without a revision and returns backlog immediately", async () => {
  const f = fixture();
  const baseline = await f.service.wait("s", { after: 0, wait: true });
  expect(baseline?.stateRevision).toMatch(/^[\w-]{43}$/);
  f.append();
  const result = await f.service.wait("s", {
    after: 0,
    wait: true,
    stateRevision: baseline!.stateRevision,
  });
  expect(result?.items[0]?.ordinal).toBe(7);
});
it.each(["message", "state"])("wakes for %s changes from one observation", async (kind) => {
  const f = fixture();
  const baseline = await f.service.wait("s", { after: 0 });
  const pending = f.service.wait("s", {
    after: 0,
    wait: true,
    stateRevision: baseline!.stateRevision,
  });
  await vi.advanceTimersByTimeAsync(0);
  if (kind === "message") f.append();
  else f.change();
  await vi.advanceTimersByTimeAsync(10);
  const result = await pending;
  expect(kind === "message" ? result?.items.length : result?.session.title).toBe(
    kind === "message" ? 1 : "Changed",
  );
});
it("times out, limits waiting capacity, and releases it on cancellation", async () => {
  const f = fixture();
  const baseline = await f.service.wait("s", { after: 0 });
  const query = { after: 0, wait: true, stateRevision: baseline!.stateRevision };
  const abort = new AbortController();
  const pending = f.service.wait("s", query, abort.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await expect(f.service.wait("s", query)).rejects.toMatchObject({
    code: "updates_capacity_exceeded",
  });
  abort.abort();
  await rejected;
  const timeout = f.service.wait("s", query);
  await vi.advanceTimersByTimeAsync(50);
  expect(await timeout).toBeNull();
});

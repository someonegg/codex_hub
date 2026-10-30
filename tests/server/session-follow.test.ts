import { afterEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/cli/session-client.js", () => ({
  SessionClient: class {
    constructor(_base: URL, signal: AbortSignal) {
      this.request = (path: string) => request(path, signal);
    }
    request: (path: string) => Promise<unknown>;
  },
}));
import { followInspect } from "../../src/server/cli/session-follow.js";

const page = (nextAfter: number, extra = {}) => ({
  session: { id: "id", status: "live", origin: {}, resume: {} },
  interaction: { supported: true, state: "connected", activity: "idle" },
  items: [],
  nextAfter,
  hasMore: false,
  ...extra,
});
const options = (extra = {}) => ({
  path: "/session",
  query: new URLSearchParams(),
  base: new URL("http://localhost"),
  signal: new AbortController().signal,
  timeoutMs: 15000,
  intervalMs: 3000,
  count: 2,
  json: true,
  ...extra,
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  request.mockReset();
});

it("reads immediately, drains pages sequentially, waits between rounds and emits only changes", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  request
    .mockResolvedValueOnce(page(1, { hasMore: true }))
    .mockResolvedValueOnce(page(2))
    .mockResolvedValueOnce(page(3))
    .mockResolvedValueOnce(page(4, { interaction: { supported: false } }));
  const observing = followInspect(options({ count: 3 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]![0]).toContain("after=1");
  await vi.advanceTimersByTimeAsync(2999);
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(3000);
  await observing;
  expect(log).toHaveBeenCalledTimes(2);
  expect(log.mock.calls.map(([line]) => JSON.parse(line))).toMatchObject([
    { nextAfter: 1 },
    { nextAfter: 4 },
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it("continues after final replies and retains incremental metadata", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const item = {
    kind: "message",
    id: "m",
    ordinal: 1,
    timestamp: null,
    role: "assistant",
    phase: "response",
    itemType: "answer",
    markdown: "Done",
  };
  request.mockResolvedValueOnce(page(1, { items: [item] })).mockResolvedValueOnce(page(1));
  const observing = followInspect(options({ intervalMs: 20 }));
  await vi.advanceTimersByTimeAsync(20);
  await observing;
  expect(request).toHaveBeenCalledTimes(2);
  expect(JSON.parse(log.mock.calls[0]![0]).items).toEqual([item]);
  expect(log).toHaveBeenCalledTimes(1);
});

it("rejects pagination without progress", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  request.mockResolvedValue(page(5, { hasMore: true }));
  await expect(
    followInspect(options({ query: new URLSearchParams({ after: "5" }) })),
  ).rejects.toMatchObject({ code: "pagination_stalled", exitCode: 1 });
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(["request", "interval"])("cancels %s and removes timers", async (stage) => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const abort = new AbortController();
  if (stage === "request")
    request.mockImplementation(
      (_path, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        ),
    );
  else request.mockResolvedValue(page(1));
  const observing = followInspect(options({ signal: abort.signal }));
  const rejected = expect(observing).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  await rejected;
  expect(request).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("times out an individual read without retrying", async () => {
  vi.useFakeTimers();
  request.mockImplementation(
    (_path, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
      ),
  );
  const observing = followInspect(options({ timeoutMs: 50 }));
  const rejected = expect(observing).rejects.toThrow("timeout");
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  expect(request).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  "preserves placeholder text in titles and messages (hasItems=%s)",
  async (hasItems) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    request.mockResolvedValue(
      page(1, {
        session: { id: "id", title: "No visible items.", status: "live", origin: {}, resume: {} },
        items: hasItems
          ? [
              {
                kind: "message",
                id: "m",
                ordinal: 1,
                timestamp: null,
                role: "assistant",
                phase: "response",
                itemType: "answer",
                markdown: "Keep No visible items. unchanged.",
              },
            ]
          : [],
      }),
    );
    await followInspect(options({ count: 1, json: false }));
    const text = log.mock.calls[0]![0];
    expect(text).toContain("Title: No visible items.");
    if (hasItems) {
      expect(text).toContain("Keep No visible items. unchanged.");
      expect(text).not.toContain("No new messages.");
    } else {
      expect(text).toContain("\n\nNo new messages.\n\nNext after:");
    }
  },
);

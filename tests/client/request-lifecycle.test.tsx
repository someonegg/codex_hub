// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { api } from "../../src/client/api/client";
import { createRequestChannel } from "../../src/client/state/request-channel";
import { useLazyDetail } from "../../src/client/state/use-lazy-detail";
import { useSessionUpdates } from "../../src/client/state/use-session-updates";
import { TIMELINE_CURSOR, UPDATE_REVISION } from "./session.fixtures";

it("invalidates old tickets even when the transport ignores cancellation", () => {
  const channel = createRequestChannel();
  const old = channel.begin();
  const fresh = channel.begin();
  expect(old.signal.aborted).toBe(true);
  expect(old.isCurrent()).toBe(false);
  expect(fresh.isCurrent()).toBe(true);
  channel.cancel();
  expect(fresh.isCurrent()).toBe(false);
});

it("offers manual lazy retries and ignores an old detail after its scope changes", async () => {
  let resolve!: (value: string) => void;
  const old = vi.fn(
    (_cursor, _signal) =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const fresh = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce("fresh detail");
  const { result, rerender, unmount } = renderHook(
    ({ load }) =>
      useLazyDetail({
        enabled: true,
        cursor: TIMELINE_CURSOR,
        load,
        unavailableMessage: "Unavailable",
        onTimelineConflict: vi.fn(),
      }),
    { initialProps: { load: old } },
  );
  const signal = old.mock.calls[0]![1] as AbortSignal;
  rerender({ load: fresh });
  await act(async () => {
    resolve("stale detail");
  });
  expect(signal.aborted).toBe(true);
  expect(result.current.detail).toBeNull();
  expect(result.current.error).toBe("offline");
  expect(fresh).toHaveBeenCalledOnce();
  act(() => result.current.retry());
  await act(async () => {
    await Promise.resolve();
  });
  expect(result.current.detail).toBe("fresh detail");
  unmount();
});

it.each(["unmount", "switch", "hide"])(
  "cancels automatic updates backoff on %s without stale requests or errors",
  async (action) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const updates = vi
      .spyOn(api, "updates")
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(() => new Promise(() => {}));
    const onError = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ sessionId }) =>
        useSessionUpdates({
          sessionId,
          enabled: true,
          snapshot: { cursor: TIMELINE_CURSOR, updateRevision: UPDATE_REVISION },
          onUpdate: vi.fn(),
          onTimelineConflict: vi.fn(),
          onError,
        }),
      { initialProps: { sessionId: "first" } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    if (action === "unmount") unmount();
    if (action === "switch") rerender({ sessionId: "second" });
    if (action === "hide") {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
    }
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(updates).toHaveBeenCalledTimes(action === "switch" ? 2 : 1);
    if (action === "hide") {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await act(async () => {
        await Promise.resolve();
      });
      expect(updates).toHaveBeenCalledTimes(2);
    }
    expect(onError).toHaveBeenCalledTimes(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  },
);

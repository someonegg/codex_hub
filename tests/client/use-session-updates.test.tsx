// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { api, ApiClientError } from "../../src/client/api/client";
import { useSessionUpdates } from "../../src/client/state/use-session-updates";
import type { SessionUpdatesResponse } from "../../src/shared/api-contract";
import {
  baseSession,
  SESSION_ID,
  NEXT_TIMELINE_CURSOR,
  TIMELINE_CURSOR,
  UPDATE_REVISION,
} from "./session.fixtures";

const snapshot = { cursor: TIMELINE_CURSOR, updateRevision: UPDATE_REVISION };
const response: SessionUpdatesResponse = {
  ...snapshot,
  session: baseSession,
  hasMore: false,
  interaction: { supported: false, attachCommand: null },
};
function options() {
  return {
    sessionId: SESSION_ID,
    enabled: true,
    snapshot,
    onUpdate: vi.fn(),
    onTimelineConflict: vi.fn(),
    onError: vi.fn(),
    onSuccess: vi.fn(),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

it("reconnects immediately after consecutive empty updates", async () => {
  const request = vi
    .spyOn(api, "updates")
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockReturnValue(new Promise(() => {}));
  const props = options();
  renderHook(() => useSessionUpdates(props));
  await flush();
  expect(request).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenLastCalledWith(
    SESSION_ID,
    { cursor: TIMELINE_CURSOR, after: UPDATE_REVISION },
    expect.any(AbortSignal),
  );
  expect(props.onSuccess).toHaveBeenCalledTimes(2);
});

it("retries at the backoff boundary and stops on terminal errors", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const retry = new ApiClientError(503, "busy", "Busy");
  const terminal = new ApiClientError(400, "invalid_query", "Stop");
  const request = vi
    .spyOn(api, "updates")
    .mockRejectedValueOnce(retry)
    .mockRejectedValueOnce(terminal);
  const props = options();
  renderHook(() => useSessionUpdates(props));
  await flush();
  expect(props.onError).toHaveBeenLastCalledWith(retry, false);
  await act(() => vi.advanceTimersByTimeAsync(999));
  expect(request).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(request).toHaveBeenCalledTimes(2);
  expect(props.onError).toHaveBeenLastCalledWith(terminal, true);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(request).toHaveBeenCalledTimes(2);
});

it("pauses hidden requests and resumes when visible", async () => {
  const signals: AbortSignal[] = [];
  vi.spyOn(api, "updates").mockImplementation((_id, _query, signal) => {
    signals.push(signal!);
    return new Promise((_resolve, reject) =>
      signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
    );
  });
  renderHook(() => useSessionUpdates(options()));
  await flush();
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await flush();
  expect(signals[0]!.aborted).toBe(true);
  expect(signals).toHaveLength(1);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await flush();
  expect(signals).toHaveLength(2);
});

it.each(["success", "failure"])("ignores late %s after a snapshot replacement", async (outcome) => {
  const old = deferred<SessionUpdatesResponse | null>();
  const current = deferred<SessionUpdatesResponse | null>();
  const request = vi
    .spyOn(api, "updates")
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(current.promise);
  const props = options();
  const replacement = { ...snapshot, cursor: NEXT_TIMELINE_CURSOR };
  const { rerender } = renderHook(({ snapshot }) => useSessionUpdates({ ...props, snapshot }), {
    initialProps: { snapshot },
  });
  rerender({ snapshot: replacement });
  expect(request.mock.calls[0]![2]!.aborted).toBe(true);
  await act(async () => {
    if (outcome === "success") old.resolve(response);
    else old.reject(new Error("obsolete"));
  });
  expect(props.onUpdate).not.toHaveBeenCalled();
  expect(props.onError).not.toHaveBeenCalled();
  expect(props.onSuccess).not.toHaveBeenCalled();
  const fresh = { ...response, cursor: NEXT_TIMELINE_CURSOR };
  await act(async () => current.resolve(fresh));
  expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith(fresh, replacement);
});

it("cancels a pending retry when disabled", async () => {
  vi.useFakeTimers();
  const request = vi
    .spyOn(api, "updates")
    .mockRejectedValue(new ApiClientError(503, "busy", "Busy"));
  const props = options();
  const { rerender } = renderHook(({ enabled }) => useSessionUpdates({ ...props, enabled }), {
    initialProps: { enabled: true },
  });
  await flush();
  rerender({ enabled: false });
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(request).toHaveBeenCalledTimes(1);
});

// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import type { ItemPageResponse } from "../../src/shared/api-contract";

import { api, ApiClientError } from "../../src/client/api/client";
import { useSessionReader } from "../../src/client/state/use-session-reader";
import { firstPage, NEXT_TIMELINE_CURSOR, SESSION_ID, TIMELINE_CURSOR } from "./session.fixtures";

const initial = { ...firstPage, hasMore: true };
const next = { ...firstPage, cursor: NEXT_TIMELINE_CURSOR, hasMore: false };
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}
function setup() {
  vi.spyOn(api, "updates").mockReturnValue(new Promise(() => {}));
  return vi.spyOn(api, "items");
}

it("retries pagination at the boundary using the original cursor", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const request = setup()
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new ApiClientError(503, "busy", "Busy"))
    .mockResolvedValueOnce(next);
  const { result } = renderHook(() => useSessionReader(SESSION_ID));
  await flush();
  let loading!: Promise<boolean>;
  act(() => {
    loading = result.current.loadMore();
  });
  await flush();
  expect(result.current.readerError).toBe("Busy");
  expect(result.current.context?.cursor).toBe(TIMELINE_CURSOR);
  await act(() => vi.advanceTimersByTimeAsync(999));
  expect(request).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(1));
  await act(async () => {
    await loading;
  });
  expect(request).toHaveBeenLastCalledWith(
    SESSION_ID,
    { cursor: TIMELINE_CURSOR, limit: 300 },
    expect.any(AbortSignal),
  );
  expect(result.current.context?.cursor).toBe(NEXT_TIMELINE_CURSOR);
  expect(result.current.readerError).toBeNull();
});

it("stops pagination retries on a terminal error while preserving loaded data", async () => {
  vi.useFakeTimers();
  const request = setup()
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new ApiClientError(400, "invalid_query", "Stop timeline"));
  const { result } = renderHook(() => useSessionReader(SESSION_ID));
  await flush();
  await act(async () => {
    expect(await result.current.loadMore()).toBe(false);
  });
  expect(result.current.readerError).toBe("Stop timeline");
  expect(result.current.items).toEqual(initial.items);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(["success", "failure"])("ignores canceled page %s after refreshing", async (outcome) => {
  let resolve!: (page: ItemPageResponse) => void;
  let reject!: (reason: unknown) => void;
  const pending = new Promise<ItemPageResponse>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const request = setup()
    .mockResolvedValueOnce(initial)
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(next);
  const { result } = renderHook(() => useSessionReader(SESSION_ID));
  await flush();
  act(() => {
    void result.current.loadMore();
  });
  await act(async () => {
    await result.current.refreshLatest();
  });
  expect(request.mock.calls[1]![2]!.aborted).toBe(true);
  await act(async () => {
    if (outcome === "success") resolve(initial);
    else reject(new Error("obsolete"));
  });
  expect(result.current.context?.cursor).toBe(NEXT_TIMELINE_CURSOR);
  expect(result.current.items).toEqual(next.items);
  expect(result.current.readerError).toBeNull();
  expect(result.current.operation).toBeNull();
});

it("cancels a pagination retry on session replacement", async () => {
  vi.useFakeTimers();
  const request = setup()
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new ApiClientError(503, "busy", "Busy"))
    .mockResolvedValueOnce(next);
  const { result, rerender } = renderHook(({ id }) => useSessionReader(id), {
    initialProps: { id: SESSION_ID },
  });
  await flush();
  act(() => {
    void result.current.loadMore();
  });
  await flush();
  rerender({ id: "replacement" });
  await flush();
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(request).toHaveBeenCalledTimes(3);
  expect(result.current.readerError).toBeNull();
});

it.each(["success", "failure"])(
  "ignores obsolete updates %s after pagination advances the snapshot",
  async (outcome) => {
    let resolve!: (value: Awaited<ReturnType<typeof api.updates>>) => void;
    let reject!: (reason: unknown) => void;
    const old = new Promise<Awaited<ReturnType<typeof api.updates>>>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const updates = vi
      .spyOn(api, "updates")
      .mockReturnValueOnce(old)
      .mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "items").mockResolvedValueOnce(initial).mockResolvedValueOnce(next);
    const { result } = renderHook(() => useSessionReader(SESSION_ID));
    await flush();
    await act(async () => {
      await result.current.loadMore();
    });
    expect(updates.mock.calls[0]![2]!.aborted).toBe(true);
    await act(async () => {
      if (outcome === "success")
        resolve({ ...initial, session: { ...initial.session, title: "Obsolete" } });
      else reject(new Error("obsolete"));
    });
    expect(result.current.context?.session.title).toBe(next.session.title);
    expect(result.current.context?.cursor).toBe(NEXT_TIMELINE_CURSOR);
    expect(result.current.readerError).toBeNull();
  },
);

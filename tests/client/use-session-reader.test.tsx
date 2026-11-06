// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { api, ApiClientError } from "../../src/client/api/client";
import { useSessionReader } from "../../src/client/state/use-session-reader";
import { firstPage, SESSION_ID } from "./session.fixtures";
beforeEach(() => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
it("serializes forward pagination and tail waiting, appending each message once", async () => {
  const mock = vi
    .spyOn(api, "messages")
    .mockResolvedValueOnce({ ...firstPage, nextAfter: 7, hasMore: true })
    .mockResolvedValueOnce({ ...firstPage, items: [], nextAfter: 7, hasMore: false })
    .mockImplementation(() => new Promise(() => {}));
  const hook = renderHook(() => useSessionReader(SESSION_ID));
  await waitFor(() => expect(hook.result.current.context?.nextAfter).toBe(7));
  expect(mock).toHaveBeenCalledTimes(1);
  await act(() => hook.result.current.loadMore());
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(3));
  expect(mock.mock.calls.map((call) => call[1])).toMatchObject([
    { after: 0 },
    { after: 7, wait: false },
    { after: 7, wait: true },
  ]);
  expect(hook.result.current.context?.items).toEqual(firstPage.items);
  hook.unmount();
  expect(mock.mock.calls[2]![2]!.aborted).toBe(true);
});
it("preserves timeline items when a poll only updates session state", async () => {
  let finishPoll!: (page: typeof firstPage) => void;
  const request = vi
    .spyOn(api, "messages")
    .mockResolvedValueOnce({ ...firstPage, hasMore: false })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPoll = resolve;
        }),
    )
    .mockImplementation(() => new Promise(() => {}));
  const hook = renderHook(() => useSessionReader(SESSION_ID));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  const items = hook.result.current.context!.items;
  await act(async () => {
    finishPoll({
      ...firstPage,
      items: [],
      hasMore: false,
      session: { ...firstPage.session, title: "Updated title" },
    });
  });
  expect(hook.result.current.context?.items).toBe(items);
  expect(hook.result.current.context?.session.title).toBe("Updated title");
  hook.unmount();
});
it("reloads once from zero after an out-of-range ordinal", async () => {
  const mock = vi
    .spyOn(api, "messages")
    .mockResolvedValueOnce({ ...firstPage, nextAfter: 9, hasMore: false })
    .mockRejectedValueOnce(new ApiClientError(400, "after_out_of_range", "rewritten"))
    .mockResolvedValueOnce({ ...firstPage, hasMore: true, nextAfter: 1 });
  const hook = renderHook(() => useSessionReader(SESSION_ID));
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(3));
  expect(mock.mock.calls[2]![1]).toMatchObject({ after: 0, wait: false });
  expect(hook.result.current.context?.items).toEqual(firstPage.items);
});
it("cancels tail waiting while hidden and resumes on visibility", async () => {
  const mock = vi
    .spyOn(api, "messages")
    .mockResolvedValueOnce({ ...firstPage, hasMore: false })
    .mockImplementation(() => new Promise(() => {}));
  const hook = renderHook(() => useSessionReader(SESSION_ID));
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(2));
  setHidden(true);
  expect(mock.mock.calls[1]![2]!.aborted).toBe(true);
  setHidden(false);
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(3));
  hook.unmount();
});

function setHidden(hidden: boolean) {
  act(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

it.each([
  ["page", new Error("Offline")],
  ["page", new ApiClientError(429, "capacity", "Busy")],
  ["poll", new ApiClientError(503, "unavailable", "Unavailable")],
] as const)("resumes %s backoff after visibility returns (%s)", async (operation, error) => {
  vi.useFakeTimers();
  const request = vi
    .spyOn(api, "messages")
    .mockResolvedValueOnce({ ...firstPage, nextAfter: 7, hasMore: operation === "page" })
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce({ ...firstPage, items: [], nextAfter: 9, hasMore: true });
  const hook = renderHook(() => useSessionReader(SESSION_ID));
  await flush();
  if (operation === "page") {
    act(() => {
      void hook.result.current.loadMore();
    });
    await flush();
  }
  expect(hook.result.current.readerRetrying).toBe(true);
  setHidden(true);
  await flush();
  expect(request.mock.calls[1]![2]!.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(request).toHaveBeenCalledTimes(2);
  setHidden(false);
  await flush();
  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls[2]![1]).toEqual(request.mock.calls[1]![1]);
  expect(hook.result.current.context?.nextAfter).toBe(9);
  expect(hook.result.current.context?.items).toEqual(firstPage.items);
  expect(hook.result.current.readerError).toBeNull();
  expect(hook.result.current.readerRetrying).toBe(false);
});

it("resumes an interrupted history page without retriggering its sentinel", async () => {
  let finishOldPage!: (page: typeof firstPage) => void;
  const request = vi
    .spyOn(api, "messages")
    .mockResolvedValueOnce({ ...firstPage, nextAfter: 7, hasMore: true })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldPage = resolve;
        }),
    )
    .mockResolvedValueOnce({ ...firstPage, items: [], nextAfter: 9, hasMore: true });
  const hook = renderHook(() => useSessionReader(SESSION_ID));
  await waitFor(() => expect(hook.result.current.context?.nextAfter).toBe(7));
  act(() => {
    void hook.result.current.loadMore();
  });
  setHidden(true);
  expect(request.mock.calls[1]![2]!.aborted).toBe(true);
  setHidden(false);
  await waitFor(() => expect(hook.result.current.context?.nextAfter).toBe(9));
  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls[2]![1]).toMatchObject({ after: 7, wait: false });
  await act(async () => {
    finishOldPage({ ...firstPage, nextAfter: 99 });
  });
  expect(hook.result.current.context?.nextAfter).toBe(9);
  expect(hook.result.current.context?.items).toEqual(firstPage.items);
});

it("keeps terminal errors stopped after visibility changes", async () => {
  const request = vi
    .spyOn(api, "messages")
    .mockRejectedValue(new ApiClientError(400, "invalid_query", "Invalid query"));
  const hook = renderHook(() => useSessionReader(SESSION_ID));
  await waitFor(() => expect(hook.result.current.readerError).toBe("Invalid query"));
  setHidden(true);
  setHidden(false);
  await flush();
  expect(request).toHaveBeenCalledOnce();
  expect(hook.result.current.readerRetrying).toBe(false);
});

it("discards suspended pagination when switching sessions while hidden", async () => {
  const request = vi
    .spyOn(api, "messages")
    .mockResolvedValueOnce({ ...firstPage, nextAfter: 7, hasMore: true })
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValueOnce({ ...firstPage, hasMore: true });
  const hook = renderHook(({ id }) => useSessionReader(id), { initialProps: { id: SESSION_ID } });
  await waitFor(() => expect(hook.result.current.context?.nextAfter).toBe(7));
  act(() => {
    void hook.result.current.loadMore();
  });
  setHidden(true);
  hook.rerender({ id: "another-session" });
  setHidden(false);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls[2]![0]).toBe("another-session");
  expect(request.mock.calls[2]![1]).toMatchObject({ after: 0, wait: false });
});

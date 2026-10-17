// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, ApiClientError } from "../../src/client/api/client";
import { INITIAL_RETRY_MS } from "../../src/client/state/retry-policy";
import { useSessionList } from "../../src/client/state/use-session-list";
import { listBody, SESSION_ID } from "./session.fixtures";

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  });
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function visibility(value: string) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  visibility("visible");
});
describe("session catalog", () => {
  it("replaces structure atomically, continues after 204, and cancels on unmount", async () => {
    const next = deferred<typeof listBody | null>();
    const sessions = vi
      .spyOn(api, "sessions")
      .mockResolvedValueOnce(listBody)
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(next.promise)
      .mockImplementation(() => new Promise(() => {}));
    const view = renderHook(useSessionList);
    await flush();
    expect(sessions).toHaveBeenCalledTimes(3);
    expect(sessions.mock.calls[0]?.[0]).toEqual({ after: undefined });
    expect(sessions.mock.calls[2]?.[0]).toEqual({ after: listBody.revision });
    next.resolve({ ...listBody, revision: "b".repeat(43), sessions: [] });
    await flush();
    expect(view.result.current.list?.sessions).toEqual([]);
    const signal = sessions.mock.calls[3]?.[1];
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
  it("pauses and aborts while hidden and resumes with the existing revision", async () => {
    const sessions = vi
      .spyOn(api, "sessions")
      .mockResolvedValueOnce(listBody)
      .mockImplementation(() => new Promise(() => {}));
    const view = renderHook(useSessionList);
    await flush();
    visibility("hidden");
    expect(sessions.mock.calls.at(-1)?.[1]?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(sessions).toHaveBeenCalledTimes(2);
    visibility("visible");
    await flush();
    expect(sessions).toHaveBeenCalledTimes(3);
    expect(sessions.mock.calls.at(-1)?.[0]).toEqual({ after: listBody.revision });
    view.unmount();
  });
  it("preserves successful data during failures and retries", async () => {
    const sessions = vi
      .spyOn(api, "sessions")
      .mockResolvedValueOnce(listBody)
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(() => new Promise(() => {}));
    const view = renderHook(useSessionList);
    await flush();
    expect(view.result.current.list).toEqual(listBody);
    expect(view.result.current.listError).toBe("offline");
    await act(async () => vi.advanceTimersByTimeAsync(INITIAL_RETRY_MS));
    expect(sessions).toHaveBeenCalledTimes(3);
    view.unmount();
  });
  it("dismisses terminal errors and manually refreshes without an after token", async () => {
    const sessions = vi
      .spyOn(api, "sessions")
      .mockResolvedValueOnce(listBody)
      .mockRejectedValueOnce(new ApiClientError(400, "invalid_query", "stopped"))
      .mockImplementation(() => new Promise(() => {}));
    const view = renderHook(useSessionList);
    await flush();
    expect(view.result.current.listError).toBe("stopped");
    expect(view.result.current.list).toEqual(listBody);
    act(() => view.result.current.clearListError());
    expect(view.result.current.listError).toBeNull();
    expect(sessions).toHaveBeenCalledTimes(2);
    act(() => view.result.current.retryList());
    await flush();
    expect(sessions.mock.calls.at(-1)?.[0]).toEqual({ after: undefined });
    view.unmount();
  });
  it("keeps newer local updatedAt values through list replacement without requests", async () => {
    const next = deferred<typeof listBody | null>();
    const sessions = vi
      .spyOn(api, "sessions")
      .mockResolvedValueOnce(listBody)
      .mockReturnValueOnce(next.promise)
      .mockImplementation(() => new Promise(() => {}));
    const view = renderHook(useSessionList);
    await flush();
    act(() => view.result.current.reportUpdatedAt(SESSION_ID, "2030-01-01T00:00:00Z"));
    const updated = view.result.current.list;
    expect(updated?.sessions[0]?.updatedAt).toBe("2030-01-01T00:00:00Z");
    expect(updated?.revision).toBe(listBody.revision);
    for (const value of [
      null,
      "invalid",
      listBody.sessions[0]!.updatedAt,
      "2030-01-01T00:00:00Z",
    ]) {
      act(() => view.result.current.reportUpdatedAt(SESSION_ID, value));
      expect(view.result.current.list).toBe(updated);
    }
    act(() => view.result.current.reportUpdatedAt("unknown", "2099-01-01T00:00:00Z"));
    expect(view.result.current.list).toBe(updated);
    expect(sessions).toHaveBeenCalledTimes(2);
    next.resolve({
      ...listBody,
      revision: "b".repeat(43),
      sessions: [
        { ...listBody.sessions[0]!, title: "Renamed", updatedAt: null },
        { ...listBody.sessions[0]!, id: "new", updatedAt: "2031-01-01T00:00:00Z" },
      ],
    });
    await flush();
    expect(
      view.result.current.list?.sessions.map(({ title, updatedAt }) => [title, updatedAt]),
    ).toEqual([
      ["Renamed", "2030-01-01T00:00:00Z"],
      [listBody.sessions[0]!.title, "2031-01-01T00:00:00Z"],
    ]);
    view.unmount();
  });
  it("ignores updatedAt feedback before loading and after deletion", async () => {
    const first = deferred<typeof listBody | null>();
    const next = deferred<typeof listBody | null>();
    vi.spyOn(api, "sessions")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(next.promise)
      .mockImplementation(() => new Promise(() => {}));
    const view = renderHook(useSessionList);
    act(() => view.result.current.reportUpdatedAt(SESSION_ID, "2099-01-01T00:00:00Z"));
    expect(view.result.current.list).toBeNull();
    first.resolve(listBody);
    await flush();
    expect(view.result.current.list).toEqual(listBody);
    next.resolve({ ...listBody, sessions: [] });
    await flush();
    const empty = view.result.current.list;
    act(() => view.result.current.reportUpdatedAt(SESSION_ID, "2099-01-01T00:00:00Z"));
    expect(view.result.current.list).toBe(empty);
    view.unmount();
  });
});

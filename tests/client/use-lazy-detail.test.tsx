// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { useLazyDetail } from "../../src/client/state/use-lazy-detail";
import { TIMELINE_CURSOR } from "./session.fixtures";

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

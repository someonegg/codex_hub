import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { api } from "../../src/client/api/client";
import { useSessionInteraction } from "../../src/client/state/use-session-interaction";

// @vitest-environment jsdom

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("session interaction state", () => {
  it("shares the interaction lock and error handling with rebind", async () => {
    const pending = deferred();
    const rebind = vi.spyOn(api, "rebind").mockReturnValue(pending.promise);
    const { result } = renderHook(() => useSessionInteraction("session-a"));
    let operation!: Promise<void>;
    act(() => {
      operation = result.current.rebind();
    });
    const failure = operation.catch((reason: unknown) => reason);
    expect(result.current.interactionBusy).toBe(true);
    await expect(result.current.rebind()).rejects.toThrow("already in progress");
    expect(rebind).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new Error("rebind failed")));
    await failure;
    expect(result.current.error).toBe("rebind failed");
    expect(result.current.interactionBusy).toBe(false);
  });

  it("sends semantic key sequences through the unified client operation", async () => {
    const sendKeys = vi.spyOn(api, "sendKeys").mockResolvedValue(undefined);
    const { result } = renderHook(() => useSessionInteraction("session-a"));

    await act(async () => result.current.sendKeys(["interrupt", "plan", "left"]));

    expect(sendKeys).toHaveBeenCalledWith("session-a", ["interrupt", "plan", "left"]);
    expect(result.current.interactionBusy).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("ignores completion from the session that was active before a switch", async () => {
    const sessionA = deferred();
    const sessionB = deferred();
    vi.spyOn(api, "sendMessage").mockImplementation((sessionId) =>
      sessionId === "session-a" ? sessionA.promise : sessionB.promise,
    );
    const { result, rerender } = renderHook(({ sessionId }) => useSessionInteraction(sessionId), {
      initialProps: { sessionId: "session-a" },
    });

    let operationA!: Promise<void>;
    act(() => {
      operationA = result.current.sendMessage("first");
    });
    const operationAResult = operationA.catch((reason: unknown) => reason);
    rerender({ sessionId: "session-b" });
    let operationB!: Promise<void>;
    act(() => {
      operationB = result.current.sendMessage("second");
    });
    expect(result.current.interactionBusy).toBe(true);

    await act(async () => sessionA.reject(new Error("session A failed")));
    await expect(operationAResult).resolves.toMatchObject({ message: "session A failed" });
    expect(result.current.interactionBusy).toBe(true);
    expect(result.current.error).toBeNull();

    await act(async () => sessionB.resolve());
    await expect(operationB).resolves.toBeUndefined();
    expect(result.current.interactionBusy).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

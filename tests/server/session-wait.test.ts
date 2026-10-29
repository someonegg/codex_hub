import { afterEach, expect, it, vi } from "vitest";

import { waitForLaunch, waitForOperation } from "../../src/server/cli/session-wait.js";
import type { HubOperation } from "../../src/shared/api-contract.js";

const operation = (status: HubOperation["status"]): HubOperation => ({
  operationId: "op/1",
  type: "create",
  status,
  sessionId: "session/1",
  phase: null,
  attachCommand: null,
  createdAt: "",
  updatedAt: "",
  error: null,
});
afterEach(() => vi.useRealTimers());

it("polls pending operations with GET until successful without resubmitting", async () => {
  vi.useFakeTimers();
  const responses = [operation("pending"), operation("succeeded")];
  const api = vi.fn(async (_path: string) => responses.shift());
  const request = async <T>(path: string): Promise<T> => (await api(path)) as T;
  const waiting = waitForOperation(operation("pending"), request, new AbortController().signal);
  expect(api).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  await expect(waiting).resolves.toMatchObject({ status: "succeeded" });
  expect(api.mock.calls).toEqual([["/api/v1/operations/op%2F1"], ["/api/v1/operations/op%2F1"]]);
});

it.each([
  ["failed", 1],
  ["unknown", 2],
] as const)("maps terminal operation status %s", async (status, exitCode) => {
  const api = vi.fn();
  await expect(
    waitForOperation(operation(status), api, new AbortController().signal),
  ).rejects.toMatchObject({ exitCode });
  expect(api).not.toHaveBeenCalled();
});

it("waits for live, connected, idle launch readiness", async () => {
  vi.useFakeTimers();
  const connected = { supported: true, state: "connected", activity: "idle" };
  const responses = [
    { live: false, interaction: connected },
    { live: true, interaction: { ...connected, state: "disconnected" } },
    { live: true, interaction: { ...connected, activity: "working" } },
    { live: true, interaction: connected },
  ];
  const api = vi.fn(async (_path: string) => responses.shift());
  const request = async <T>(path: string): Promise<T> => (await api(path)) as T;
  const waiting = waitForLaunch("session/1", request, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(1500);
  await waiting;
  expect(api.mock.calls).toEqual(
    Array.from({ length: 4 }, () => ["/api/v1/sessions/session%2F1/inspect?limit=1"]),
  );
});

it("aborts a polling delay without issuing another request", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const api = vi.fn();
  const waiting = waitForOperation(operation("pending"), api, abort.signal);
  const rejected = expect(waiting).rejects.toThrow("Command interrupted or timed out");
  abort.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(1000);
  expect(api).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("refuses an already aborted polling delay and missing launch identities", async () => {
  const api = vi.fn();
  await expect(waitForOperation(operation("pending"), api, AbortSignal.abort())).rejects.toThrow(
    "Command interrupted or timed out",
  );
  await expect(waitForLaunch(null, api, new AbortController().signal)).rejects.toThrow(
    "Launch response has no session",
  );
  expect(api).not.toHaveBeenCalled();
});

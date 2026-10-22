import { beforeEach, expect, it, vi } from "vitest";

import { TerminalActivityService } from "../../src/server/interaction/terminal-activity-service.js";
import type { PreviewListener } from "../../src/server/interaction/tmux-preview-listener.js";
import { closeAfterEach } from "../helpers/cleanup.js";

const binding = { socketPath: "/tmp/test", paneId: "%1", sessionName: "test" };
beforeEach(() => vi.useFakeTimers({ now: 0 }));

function setup() {
  const subscriptions: {
    output: (pane?: string) => void;
    fail: (error: Error) => void;
    ready: () => void;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const listen = vi.fn<PreviewListener>((_binding, output, fail) => {
    let ready!: () => void;
    const close = vi.fn();
    const promise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    subscriptions.push({ output, fail, ready, close });
    return { ready: promise, close };
  });
  const service = closeAfterEach(new TerminalActivityService(listen, () => Date.now()));
  service.read("one", binding);
  return { service, listen, subscriptions, first: subscriptions[0]! };
}

it("waits for readiness and five seconds of observation before reporting idle", async () => {
  const { service, first } = setup();
  await vi.advanceTimersByTimeAsync(5000);
  expect(service.read("one", binding)).toBe("unknown");
  first.ready();
  await vi.advanceTimersByTimeAsync(4999);
  first.output("%2");
  first.output();
  expect(service.read("one", binding)).toBe("unknown");
  await vi.advanceTimersByTimeAsync(1);
  expect(service.read("one", binding)).toBe("idle");
});

it("renews the five-second working window only for output from the selected pane", async () => {
  const { service, first } = setup();
  first.ready();
  await vi.advanceTimersByTimeAsync(5000);
  first.output("%1");
  expect(service.read("one", binding)).toBe("working");
  await vi.advanceTimersByTimeAsync(4999);
  expect(service.read("one", binding)).toBe("working");
  first.output("%1");
  await vi.advanceTimersByTimeAsync(4999);
  first.output("%2");
  expect(service.read("one", binding)).toBe("working");
  await vi.advanceTimersByTimeAsync(1);
  expect(service.read("one", binding)).toBe("idle");
});

it("closes a failed subscription and retries with a fresh observation on the next read", async () => {
  const { service, listen, subscriptions, first } = setup();
  first.ready();
  await vi.advanceTimersByTimeAsync(0);
  first.output("%1");
  expect(service.read("one", binding)).toBe("working");
  first.fail(new Error("lost"));
  expect(first.close).toHaveBeenCalledOnce();
  expect(service.read("one", binding)).toBe("unknown");
  expect(listen).toHaveBeenCalledTimes(2);
  subscriptions[1]!.ready();
  await vi.advanceTimersByTimeAsync(0);
  subscriptions[1]!.output("%1");
  expect(service.read("one", binding)).toBe("working");
});

it("expires an unread subscription at sixty seconds without requiring another read", async () => {
  const { first } = setup();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(first.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(first.close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(first.close).toHaveBeenCalledOnce();
});

it("renews the subscription lease on reads and closes it only at the new deadline", async () => {
  const { service, listen, first } = setup();
  await vi.advanceTimersByTimeAsync(30_000);
  service.read("one", binding);
  expect(listen).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(first.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(first.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(first.close).toHaveBeenCalledOnce();
});

it("invalidates only subscriptions that lost ownership and stops its timer on close", async () => {
  const { service, listen, first } = setup();
  service.read("two", { ...binding, paneId: "%2" });
  const second = listen.mock.results[1]!.value;
  service.invalidate((id) => id === "two");
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).not.toHaveBeenCalled();
  service.close();
  expect(second.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(service.read("one", binding)).toBe("unknown");
  expect(listen).toHaveBeenCalledTimes(2);
});

it.each([{ socketPath: "/tmp/other" }, { paneId: "%2" }, { sessionName: "second" }])(
  "rebuilds observation when the binding changes: %j",
  async (change) => {
    const { service, listen, first } = setup();
    first.ready();
    await vi.advanceTimersByTimeAsync(5000);
    expect(service.read("one", binding)).toBe("idle");
    expect(service.read("one", { ...binding, ...change })).toBe("unknown");
    expect(first.close).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledTimes(2);
  },
);

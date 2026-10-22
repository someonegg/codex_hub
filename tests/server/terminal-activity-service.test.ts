import { expect, it, vi } from "vitest";

import { TerminalActivityService } from "../../src/server/interaction/terminal-activity-service.js";
import type { PreviewListener } from "../../src/server/interaction/tmux-preview-listener.js";

it("observes readiness, pane output, the five-second boundary, recovery and leases", async () => {
  let now = 0;
  let output!: (pane?: string) => void;
  let fail!: (error: Error) => void;
  let ready!: () => void;
  const close = vi.fn();
  const listen: PreviewListener = vi.fn((_binding, change, failed) => {
    output = change;
    fail = failed;
    return {
      ready: new Promise<void>((resolve) => {
        ready = resolve;
      }),
      close,
    };
  });
  const service = new TerminalActivityService(listen, () => now);
  const binding = { socketPath: "/tmp/test", paneId: "%1", sessionName: "test" };
  expect(service.read("one", binding)).toBe("unknown");
  ready();
  await Promise.resolve();
  now = 4999;
  output("%2");
  expect(service.read("one", binding)).toBe("unknown");
  now = 5000;
  expect(service.read("one", binding)).toBe("idle");
  output("%1");
  expect(service.read("one", binding)).toBe("working");
  now = 9999;
  expect(service.read("one", binding)).toBe("working");
  output("%1");
  now = 14999;
  expect(service.read("one", binding)).toBe("idle");
  fail(new Error("lost"));
  expect(service.read("one", binding)).toBe("unknown");
  expect(listen).toHaveBeenCalledTimes(2);
  ready();
  await Promise.resolve();
  output("%1");
  expect(service.read("one", binding)).toBe("working");
  service.invalidate(() => false);
  expect(close).toHaveBeenCalled();
  expect(service.read("one", binding)).toBe("unknown");
  now += 60000;
  service.invalidate(() => true);
  expect(service.read("one", binding)).toBe("unknown");
  service.close();
  expect(service.read("one", binding)).toBe("unknown");
});

it("rebuilds observation when the pane moves to another tmux session", async () => {
  const close = vi.fn();
  const listen = vi.fn(() => ({ ready: Promise.resolve(), close }));
  let now = 0;
  const service = new TerminalActivityService(listen, () => now);
  const binding = { socketPath: "/tmp/test", paneId: "%1", sessionName: "first" };
  service.read("one", binding);
  await Promise.resolve();
  now = 5000;
  expect(service.read("one", binding)).toBe("idle");
  expect(service.read("one", { ...binding, sessionName: "second" })).toBe("unknown");
  expect(close).toHaveBeenCalledTimes(1);
  expect(listen).toHaveBeenCalledTimes(2);
  service.close();
});

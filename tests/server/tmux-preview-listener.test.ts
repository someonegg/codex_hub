import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { createTmuxPreviewListener } from "../../src/server/interaction/tmux-preview-listener.js";

function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  });
}
const binding = { socketPath: "/tmp/control.sock", paneId: "%1", sessionName: "name with spaces" };
afterEach(() => vi.useRealTimers());
it("shares socket/session clients, parses fragmented notifications, and closes the final subscription", async () => {
  const process = child();
  spawn.mockReturnValue(process);
  const listen = createTmuxPreviewListener();
  const first = vi.fn();
  const second = vi.fn();
  const a = listen(binding, first, vi.fn());
  const b = listen({ ...binding, paneId: "%2" }, second, vi.fn());
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0]![1]).toEqual([
    "-S",
    binding.socketPath,
    "-C",
    "attach-session",
    "-f",
    "ignore-size",
    "-E",
    "-t",
    "=name with spaces",
  ]);
  process.stdout.write("%begin 1 1 0\n%en");
  process.stdout.write("d 1 1 0\n%out");
  await a.ready;
  process.stdout.write("put %1 hello\\012world\n%layout-change @1 layout\n");
  expect(first.mock.calls).toEqual([["%1"], []]);
  expect(second.mock.calls).toEqual(first.mock.calls);
  a.close();
  expect(process.kill).not.toHaveBeenCalled();
  b.close();
  expect(process.kill).toHaveBeenCalledOnce();
});
it.each(["error", "close", "protocol", "timeout"])(
  "rejects startup and notifies subscribers on %s",
  async (kind) => {
    vi.useFakeTimers();
    const process = child();
    spawn.mockReturnValue(process);
    const listen = createTmuxPreviewListener();
    const failed = vi.fn();
    const a = listen(binding, vi.fn(), failed);
    const rejected = expect(a.ready).rejects.toThrow();
    if (kind === "error") process.emit("error", new Error("spawn failed"));
    if (kind === "close") process.emit("close", 1);
    if (kind === "protocol") process.stdout.write("%error 1 1 0\n");
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(failed).toHaveBeenCalledOnce();
    const replacement = child();
    spawn.mockReturnValue(replacement);
    const b = listen(binding, vi.fn(), vi.fn());
    replacement.stdout.write("%end 1 1 0\n");
    await b.ready;
    b.close();
  },
);

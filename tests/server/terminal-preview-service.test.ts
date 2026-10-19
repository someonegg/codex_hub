import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { applyPreview } from "../../src/client/state/terminal-preview-patch.js";
import { TerminalPreviewService } from "../../src/server/interaction/terminal-preview-service.js";
import type { PreviewListener } from "../../src/server/interaction/tmux-preview-listener.js";
import type { TerminalPreviewFrame } from "../../src/shared/api-contract.js";

const binding = { socketPath: "/tmp/test.sock", paneId: "%1", sessionName: "test" };
let service: TerminalPreviewService;
let change: (pane?: string) => void;
let fail: (error: Error) => void;
let content: string;
let capture: ReturnType<typeof vi.fn<() => Promise<{ content: string; truncated: boolean }>>>;
let close: ReturnType<typeof vi.fn<() => void>>;
let listen: ReturnType<typeof vi.fn<PreviewListener>>;

beforeEach(() => {
  vi.useFakeTimers();
  content = "first";
  close = vi.fn();
  capture = vi.fn(async () => ({ content, truncated: false }));
  listen = vi.fn((_binding, changed, failed) => {
    change = changed;
    fail = failed;
    return { ready: Promise.resolve(), close };
  });
  service = new TerminalPreviewService(capture, listen);
});
afterEach(() => {
  service.close();
  vi.useRealTimers();
});

function subscribe(session = "session", target = binding, guard = () => {}) {
  const frames: TerminalPreviewFrame[] = [];
  const failed = vi.fn();
  const abort = new AbortController();
  const stop = service.subscribe(
    session,
    target,
    guard,
    (frame) => frames.push(frame),
    failed,
    abort.signal,
  );
  return { frames, failed, abort, stop };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

it("shares first capture, sends new viewers full frames, and merges only matching pane events", async () => {
  content = "padding\n".repeat(100);
  const a = subscribe(),
    b = subscribe();
  await flush();
  expect(a.frames).toEqual(b.frames);
  expect(a.frames[0]?.type).toBe("snapshot");
  expect(capture).toHaveBeenCalledOnce();
  expect(listen).toHaveBeenCalledOnce();
  change("%2");
  await vi.advanceTimersByTimeAsync(350);
  expect(capture).toHaveBeenCalledOnce();
  content += "tail";
  change("%1");
  await vi.advanceTimersByTimeAsync(175);
  change("%1");
  await vi.advanceTimersByTimeAsync(174);
  expect(a.frames).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(a.frames[1]?.type).toBe("delta");
  expect(a.frames).toEqual(b.frames);
  const joined = subscribe();
  await flush();
  expect(joined.frames[0]).toMatchObject({ type: "snapshot", content });
  expect(capture).toHaveBeenCalledTimes(2);
});

it("does not publish unchanged content or wake periodically", async () => {
  const viewer = subscribe();
  await flush();
  change();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(viewer.frames).toHaveLength(1);
  expect(capture).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("releases the listener immediately after the last viewer, with idempotent cancellation", async () => {
  const a = subscribe(),
    b = subscribe();
  await flush();
  a.abort.abort();
  a.stop();
  expect(close).not.toHaveBeenCalled();
  content = "second";
  change();
  await vi.advanceTimersByTimeAsync(350);
  expect(a.frames).toHaveLength(1);
  expect(b.frames).toHaveLength(2);
  b.stop();
  b.stop();
  expect(close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  subscribe();
  await flush();
  expect(listen).toHaveBeenCalledTimes(2);
});

it("cancels during listener startup without waiting or affecting another viewer", async () => {
  service.close();
  let ready!: () => void;
  service = new TerminalPreviewService(capture, () => ({
    ready: new Promise<void>((resolve) => {
      ready = resolve;
    }),
    close,
  }));
  const a = subscribe(),
    b = subscribe();
  a.abort.abort();
  expect(close).not.toHaveBeenCalled();
  ready();
  await flush();
  expect(a.frames).toHaveLength(0);
  expect(b.frames).toHaveLength(1);
  expect(capture).toHaveBeenCalledOnce();
});

it("shutdown cancels startup and closes all subscribers", async () => {
  service.close();
  service = new TerminalPreviewService(capture, () => ({ ready: new Promise(() => {}), close }));
  const viewer = subscribe();
  service.close();
  expect(close).toHaveBeenCalledOnce();
  expect(viewer.failed).toHaveBeenCalledWith(expect.objectContaining({ name: "AbortError" }));
  expect(() => subscribe()).toThrow("Aborted");
});

it("suppresses late capture results and scheduling after final cancellation", async () => {
  let complete!: (value: { content: string; truncated: boolean }) => void;
  capture.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const viewer = subscribe();
  await flush();
  change();
  viewer.abort.abort();
  complete({ content: "late", truncated: false });
  await vi.advanceTimersByTimeAsync(2000);
  expect(viewer.frames).toHaveLength(0);
  expect(viewer.failed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not overlap captures and preserves a second merge window for output during capture", async () => {
  const viewer = subscribe();
  await flush();
  let complete!: (value: { content: string; truncated: boolean }) => void;
  capture.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  change();
  await vi.advanceTimersByTimeAsync(350);
  change();
  await vi.advanceTimersByTimeAsync(5000);
  expect(capture).toHaveBeenCalledTimes(2);
  complete({ content: "intermediate", truncated: false });
  await flush();
  content = "final";
  await vi.advanceTimersByTimeAsync(349);
  expect(capture).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(viewer.frames.at(-1)).toMatchObject({ type: "snapshot", content: "final" });
  expect(capture).toHaveBeenCalledTimes(3);
});

it("invalidates ownership immediately, including unchanged output", async () => {
  let valid = true;
  const viewer = subscribe("session", binding, () => {
    if (!valid) throw new Error("replaced");
  });
  await flush();
  valid = false;
  service.invalidate();
  expect(viewer.failed).toHaveBeenCalledWith(expect.objectContaining({ message: "replaced" }));
  expect(close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("fails all viewers on listener failure and rebuilds a new subscription", async () => {
  const a = subscribe(),
    b = subscribe();
  await flush();
  fail(new Error("gone"));
  expect(a.failed).toHaveBeenCalledWith(expect.objectContaining({ message: "gone" }));
  expect(b.failed).toHaveBeenCalledOnce();
  const next = subscribe();
  await flush();
  expect(listen).toHaveBeenCalledTimes(2);
  expect(next.frames[0]?.type).toBe("snapshot");
});

it("replaces subscriptions when the resolved tmux session changes", async () => {
  const viewer = subscribe();
  await flush();
  const next = subscribe("session", { ...binding, sessionName: "destination" });
  await flush();
  expect(viewer.failed).toHaveBeenCalledWith(
    expect.objectContaining({ message: "The pane's tmux session changed" }),
  );
  expect(close).toHaveBeenCalledOnce();
  expect(next.frames).toHaveLength(1);
});

it("detects pane movement before capturing, including topology-only notifications", async () => {
  service.close();
  let current = binding;
  service = new TerminalPreviewService(capture, listen, async () => current);
  const viewer = subscribe();
  await flush();
  current = { ...binding, sessionName: "destination" };
  change();
  await vi.advanceTimersByTimeAsync(350);
  expect(viewer.failed).toHaveBeenCalledWith(expect.objectContaining({ code: "disconnected" }));
  expect(capture).toHaveBeenCalledOnce();
});

it("publishes truncation-only updates and isolates binding revisions", async () => {
  content = "stable\n".repeat(100);
  const viewer = subscribe();
  await flush();
  capture.mockResolvedValueOnce({ content, truncated: true });
  change();
  await vi.advanceTimersByTimeAsync(350);
  expect(viewer.frames.at(-1)).toMatchObject({ type: "delta", operations: [], truncated: true });
  const replacement = subscribe("replacement");
  await flush();
  expect(replacement.frames[0]?.revision).not.toBe(viewer.frames[0]?.revision);
});

it.each(["oversized", "edit budget", "not smaller"])(
  "falls back to full text for %s and resumes deltas from that frame",
  async (reason) => {
    content = reason === "not smaller" ? "a" : `start\n${"a\n".repeat(300)}`;
    const viewer = subscribe();
    await flush();
    if (reason === "oversized") content += "x".repeat(8192);
    else if (reason === "edit budget") content = content.replaceAll("a\n", "b\n");
    else content = "b";
    change();
    await vi.advanceTimersByTimeAsync(350);
    const baseline = viewer.frames.at(-1)!;
    expect(baseline).toMatchObject({ type: "snapshot", content });
    if (reason === "not smaller") return;
    content = content.replace("start", "next");
    change();
    await vi.advanceTimersByTimeAsync(350);
    const delta = viewer.frames.at(-1)!;
    expect(delta).toMatchObject({ type: "delta", baseRevision: baseline.revision });
    expect(applyPreview(applyPreview(null, baseline), delta)?.content).toBe(content);
  },
);

it.each([8192, 8193])("enforces serialized UTF-8 delta byte boundary %i", async (size) => {
  content = `old\n${"padding".repeat(4000)}`;
  const viewer = subscribe();
  await flush();
  const first = viewer.frames[0]!;
  const overhead = Buffer.byteLength(
    JSON.stringify({
      type: "delta",
      baseRevision: first.revision,
      revision: first.revision,
      operations: [{ startLine: 0, deleteCount: 1, lines: [""] }],
      truncated: false,
      capturedAt: first.capturedAt,
    }),
  );
  content = `${"x".repeat(size - overhead)}\n${"padding".repeat(4000)}`;
  change();
  await vi.advanceTimersByTimeAsync(350);
  const next = viewer.frames.at(-1)!;
  if (size === 8192) {
    expect(next.type).toBe("delta");
    expect(Buffer.byteLength(JSON.stringify(next))).toBe(size);
  } else expect(next).toMatchObject({ type: "snapshot", content });
});

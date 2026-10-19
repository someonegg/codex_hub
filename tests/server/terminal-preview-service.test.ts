import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { TerminalPreviewService } from "../../src/server/interaction/terminal-preview-service.js";
import type { PreviewListener } from "../../src/server/interaction/tmux-preview-listener.js";

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
const get = (after?: string, signal?: AbortSignal) =>
  service.preview("session", binding, () => {}, after, signal);

it("fails old waiters and replaces the subscription when a request resolves a different tmux session", async () => {
  const first = await get();
  const waiting = get(first!.revision);
  const rejected = expect(waiting).rejects.toThrow("tmux session changed");
  await vi.advanceTimersByTimeAsync(0);
  const moved = { ...binding, sessionName: "destination" };
  content = "moved";
  expect((await service.preview("session", moved, () => {}))!.content).toBe("moved");
  await rejected;
  expect(close).toHaveBeenCalledOnce();
  expect(listen).toHaveBeenLastCalledWith(moved, expect.any(Function), expect.any(Function));
});

it("fails unchanged pending previews when a topology event reveals a session change", async () => {
  service.close();
  let current = binding;
  service = new TerminalPreviewService(capture, listen, async () => current);
  const first = await get();
  const waiting = get(first!.revision);
  const rejected = expect(waiting).rejects.toThrow("tmux session changed");
  await vi.advanceTimersByTimeAsync(0);
  current = { ...binding, sessionName: "destination" };
  change();
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(capture).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledOnce();
  expect(await service.preview("session", current, () => {})).toBeTruthy();
});

it("shares first capture and revisions, ignores other panes, and uses a fixed window", async () => {
  const [a, b] = await Promise.all([get(), get()]);
  expect(a).toEqual(b);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(listen).toHaveBeenCalledTimes(1);
  const waiting = get(a!.revision);
  await vi.advanceTimersByTimeAsync(0);
  change("%2");
  await vi.advanceTimersByTimeAsync(1000);
  expect(capture).toHaveBeenCalledTimes(1);
  content = "second";
  change("%1");
  await vi.advanceTimersByTimeAsync(500);
  change("%1");
  await vi.advanceTimersByTimeAsync(499);
  expect(capture).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect((await waiting)!.content).toBe("second");
  expect(capture).toHaveBeenCalledTimes(2);
});
it("keeps unchanged text waiting and returns 204 after 25 seconds", async () => {
  const first = await get();
  let done = false;
  const waiting = get(first!.revision).then((value) => {
    done = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(0);
  change();
  await vi.advanceTimersByTimeAsync(1000);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(24000);
  expect(await waiting).toBeNull();
});
it("captures during idle, preserves merge windows on resume, and expires after 10 seconds", async () => {
  const first = await get();
  content = "resumed";
  change();
  await vi.advanceTimersByTimeAsync(500);
  expect((await get())!.revision).toBe(first!.revision);
  expect(capture).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(capture).toHaveBeenCalledTimes(2);
  expect((await get())!.content).toBe("resumed");
  content = "idle update";
  change();
  await vi.advanceTimersByTimeAsync(1000);
  expect(capture).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(8999);
  expect(close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(close).toHaveBeenCalledOnce();
  await get();
  expect(listen).toHaveBeenCalledTimes(2);
});
it("keeps the next merge window when a client reconnects after output during capture", async () => {
  const first = await get();
  const waiting = get(first!.revision);
  await vi.advanceTimersByTimeAsync(0);
  let complete!: (value: { content: string; truncated: boolean }) => void;
  capture.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  change();
  await vi.advanceTimersByTimeAsync(1000);
  content = "final";
  change();
  complete({ content: "intermediate", truncated: false });
  const second = await waiting;
  const reconnected = get(second!.revision);
  await vi.advanceTimersByTimeAsync(999);
  expect(capture).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect((await reconnected)!.content).toBe("final");
  expect(capture).toHaveBeenCalledTimes(3);
});
it("does not restart scheduling when an in-flight idle capture finishes after expiry", async () => {
  await get();
  let complete!: (value: { content: string; truncated: boolean }) => void;
  capture.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  change();
  await vi.advanceTimersByTimeAsync(1000);
  change();
  await vi.advanceTimersByTimeAsync(9000);
  expect(close).toHaveBeenCalledOnce();
  complete({ content: "late", truncated: false });
  await vi.advanceTimersByTimeAsync(1000);
  expect(capture).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it("removes aborted waiters and enforces per-session capacity", async () => {
  const first = await get();
  const controllers = Array.from({ length: 10 }, () => new AbortController());
  const waits = controllers.map((controller) =>
    get(first!.revision, controller.signal).catch((error: Error) => error.name),
  );
  await vi.advanceTimersByTimeAsync(0);
  await expect(get(first!.revision)).rejects.toThrow("Too many");
  controllers.forEach((controller) => controller.abort());
  expect(await Promise.all(waits)).toEqual(Array(10).fill("AbortError"));
  expect((await get())!.revision).toBe(first!.revision);
});
it("fails waiting clients and rebuilds after listener failure", async () => {
  const first = await get();
  const waiting = get(first!.revision);
  const rejected = expect(waiting).rejects.toThrow("gone");
  await vi.advanceTimersByTimeAsync(0);
  fail(new Error("gone"));
  await rejected;
  await get();
  expect(listen).toHaveBeenCalledTimes(2);
});
it("does not overlap capture and schedules a second window for events during capture", async () => {
  const first = await get();
  const abort = new AbortController();
  const waiting = get(first!.revision, abort.signal).catch(() => null);
  await vi.advanceTimersByTimeAsync(0);
  let complete!: (value: { content: string; truncated: boolean }) => void;
  capture.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  change();
  await vi.advanceTimersByTimeAsync(1000);
  change();
  await vi.advanceTimersByTimeAsync(5000);
  expect(capture).toHaveBeenCalledTimes(2);
  complete({ content: "first", truncated: false });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(999);
  expect(capture).toHaveBeenCalledTimes(2);
  content = "final";
  await vi.advanceTimersByTimeAsync(1);
  expect((await waiting)!.content).toBe("final");
  expect(capture).toHaveBeenCalledTimes(3);
});

it("limits global waiters across sessions and releases all waits on shutdown", async () => {
  const sessions = Array.from({ length: 101 }, (_, index) => `session-${index}`);
  const first = await Promise.all(
    sessions.map((session) => service.preview(session, binding, () => {})),
  );
  const pending = sessions
    .slice(0, 100)
    .map((session, index) =>
      service
        .preview(session, binding, () => {}, first[index]!.revision)
        .catch((error: Error) => error.name),
    );
  await vi.advanceTimersByTimeAsync(0);
  await expect(
    service.preview(sessions[100]!, binding, () => {}, first[100]!.revision),
  ).rejects.toThrow("Too many");
  service.close();
  expect(await Promise.all(pending)).toEqual(Array(100).fill("AbortError"));
  expect(vi.getTimerCount()).toBe(0);
});
it.each([false, true])(
  "invalidates obsolete bindings immediately (waiting: %s)",
  async (waiting) => {
    let valid = true;
    const guard = () => {
      if (!valid) throw new Error("binding replaced");
    };
    const first = await service.preview("session", binding, guard);
    const rejected = waiting
      ? expect(service.preview("session", binding, guard, first!.revision)).rejects.toThrow(
          "binding replaced",
        )
      : undefined;
    await vi.advanceTimersByTimeAsync(0);
    valid = false;
    service.invalidate();
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("cancels during startup without waiting for the shared listener", async () => {
  service.close();
  service = new TerminalPreviewService(capture, () => ({ ready: new Promise(() => {}), close }));
  const abort = new AbortController();
  const pending = get(undefined, abort.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  abort.abort();
  await rejected;
  expect(capture).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10000);
  expect(close).toHaveBeenCalledOnce();
});
it("returns well-formed stale revisions immediately and isolates process identities", async () => {
  const first = await get("x".repeat(43));
  expect(first!.revision).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const other = new TerminalPreviewService(capture, listen);
  try {
    expect((await other.preview("session", binding, () => {}, first!.revision))!.revision).not.toBe(
      first!.revision,
    );
  } finally {
    other.close();
  }
});

it("does not capture notifications before startup completes, and shutdown cancels startup", async () => {
  service.close();
  service = new TerminalPreviewService(capture, (_binding, changed) => {
    change = changed;
    return { ready: new Promise(() => {}), close };
  });
  const pending = get();
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  change();
  await vi.advanceTimersByTimeAsync(2000);
  expect(capture).not.toHaveBeenCalled();
  service.close();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("shares deltas, catches up through history, and evicts old revisions", async () => {
  content = Array.from({ length: 100 }, (_, i) => `stable line ${i}`).join("\n");
  const first = (await get())!;
  let previous = first;
  for (let i = 0; i < 6; i++) {
    content += `\nadded ${i}`;
    change();
    await vi.advanceTimersByTimeAsync(1000);
    const [a, b] = await Promise.all([get(previous.revision), get(previous.revision)]);
    expect(a).toEqual(b);
    expect(a).toHaveProperty("patches");
    if (i === 1) expect(await get(first.revision)).toHaveProperty("patches", expect.any(Array));
    previous = a!;
  }
  expect(await get(first.revision)).toHaveProperty("content", content);
});

it("publishes empty operations for truncation-only changes and isolates binding identities", async () => {
  content = "stable\n".repeat(100);
  const first = (await get())!;
  capture.mockResolvedValueOnce({ content, truncated: true });
  change();
  await vi.advanceTimersByTimeAsync(1000);
  const next = await get(first.revision);
  expect(next).toMatchObject({ patches: [{ operations: [] }], truncated: true });
  expect(await service.preview("replacement", binding, () => {}, first.revision)).toHaveProperty(
    "content",
  );
});

it("drops history when a single response exceeds its budget or diff work", async () => {
  content = "stable\n".repeat(2000);
  const first = (await get())!;
  content += "x".repeat(8192);
  change();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await get(first.revision)).toHaveProperty("content", content);
  content += "\nsmall";
  change();
  await vi.advanceTimersByTimeAsync(1000);
  await get();
  expect(await get(first.revision)).toHaveProperty("content", content);
});

it.each([8192, 8193])(
  "enforces the exact UTF-8 generated-patch response boundary (%i)",
  async (size) => {
    content = `old\n${"padding".repeat(4000)}`;
    const first = (await get())!;
    const overhead = Buffer.byteLength(
      JSON.stringify({
        baseRevision: first.revision,
        revision: first.revision,
        patches: [{ operations: [{ startLine: 0, deleteCount: 1, lines: [""] }] }],
        truncated: false,
        capturedAt: first.capturedAt,
      }),
    );
    content = `${"x".repeat(size - overhead)}\n${"padding".repeat(4000)}`;
    change();
    await vi.advanceTimersByTimeAsync(1000);
    const next = (await get(first.revision))!;
    if (size === 8192) {
      expect(next).toHaveProperty("patches");
      expect(Buffer.byteLength(JSON.stringify(next))).toBe(size);
    } else expect(next).toHaveProperty("content", content);
  },
);

it("evicts by cumulative entry bytes before reaching five entries", async () => {
  content = `old\n${"padding".repeat(6000)}`;
  const revisions = [(await get())!.revision];
  for (let i = 0; i < 5; i++) {
    content = `${String(i).repeat(7000)}\n${"padding".repeat(6000)}`;
    change();
    await vi.advanceTimersByTimeAsync(1000);
    revisions.push((await get(revisions.at(-1)))!.revision);
  }
  expect(await get(revisions[0])).toHaveProperty("content");
  expect(await get(revisions[1])).toHaveProperty("patches");
});

it("falls back for oversized chains without discarding useful history, and prefers current repeated revisions", async () => {
  const a = "a".repeat(500),
    b = "b".repeat(500),
    c = "c".repeat(500);
  content = `zero\n${a}`;
  const first = (await get())!;
  content = `one\n${a}`;
  change();
  await vi.advanceTimersByTimeAsync(1000);
  const second = (await get(first.revision))!;
  content = `one\n${b}`;
  change();
  await vi.advanceTimersByTimeAsync(1000);
  const third = (await get(second.revision))!;
  content = `two\n${b}`;
  change();
  await vi.advanceTimersByTimeAsync(1000);
  await get(third.revision);
  expect(await get(first.revision)).toHaveProperty("content");
  expect(await get(third.revision)).toHaveProperty("patches");
  content = `one\n${a}`;
  change();
  await vi.advanceTimersByTimeAsync(1000);
  await get();
  expect((await get())!.revision).toBe(second.revision);
  const waiting = get(second.revision);
  await vi.advanceTimersByTimeAsync(25000);
  expect(await waiting).toBeNull();
  content = `three\n${c}`;
  change();
  await vi.advanceTimersByTimeAsync(1000);
  await get();
  // Most recent matching base is used even if an older occurrence was evicted.
  expect((await get(second.revision))!.revision).not.toBe(second.revision);
});

it.each([32768, 32769])("enforces the exact cumulative entry boundary (%i)", async (total) => {
  const padding = "p".repeat(40000);
  content = `old\n${padding}`;
  const first = (await get())!;
  const overhead = Buffer.byteLength(
    JSON.stringify({
      baseRevision: first.revision,
      revision: first.revision,
      operations: [{ startLine: 0, deleteCount: 1, lines: [""] }],
    }),
  );
  let previous = first.revision;
  for (let i = 0; i < 5; i++) {
    const size = i === 4 ? total - 4 * 6500 : 6500;
    content = `${String(i).repeat(size - overhead)}\n${padding}`;
    change();
    await vi.advanceTimersByTimeAsync(1000);
    previous = (await get(previous))!.revision;
  }
  const response = (await get(first.revision))!;
  if (total === 32768)
    expect(response).toHaveProperty("patches", expect.arrayContaining([expect.any(Object)]));
  else expect(response).toHaveProperty("content");
});

it("selects the newest compatible occurrence of a repeated revision", async () => {
  const base = "padding\n".repeat(100);
  content = `a\n${base}`;
  const a = (await get())!;
  content = `b\n${base}`;
  change();
  await vi.advanceTimersByTimeAsync(1000);
  await get();
  content = `a\n${base}`;
  change();
  await vi.advanceTimersByTimeAsync(1000);
  await get();
  content = `c\n${base}`;
  change();
  await vi.advanceTimersByTimeAsync(1000);
  await get();
  expect(await get(a.revision)).toMatchObject({
    patches: [{ operations: [{ startLine: 0, deleteCount: 1, lines: ["c"] }] }],
  });
});

it("establishes a fresh baseline after exceeding the edit-distance budget", async () => {
  content = `start\n${"a\n".repeat(300)}`;
  const first = (await get())!;
  content = `start\n${"b\n".repeat(300)}`;
  change();
  await vi.advanceTimersByTimeAsync(1000);
  const baseline = (await get(first.revision))!;
  expect(baseline).toHaveProperty("content");
  content = content.replace("start", "next");
  change();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await get(baseline.revision)).toHaveProperty("patches");
  expect(await get(first.revision)).toHaveProperty("content");
});

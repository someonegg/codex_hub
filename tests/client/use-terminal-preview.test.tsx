// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { SessionInteraction } from "../../src/client/components/SessionInteraction";
import { useTerminalPreview } from "../../src/client/state/use-terminal-preview";
import { installMockWebSocket, MockWebSocket } from "./mock-websocket";

const frame = {
  type: "snapshot" as const,
  content: "output",
  truncated: false,
  revision: "first",
  capturedAt: "2026-08-08T12:00:00Z",
};
const display = {
  content: frame.content,
  truncated: frame.truncated,
  revision: frame.revision,
  capturedAt: frame.capturedAt,
};
const latest = () => MockWebSocket.instances.at(-1)!;
beforeEach(installMockWebSocket);

it("starts folded, waits only for the first frame, and applies consecutive updates on one socket", () => {
  const { result, unmount } = renderHook(() => useTerminalPreview("a", true));
  expect(MockWebSocket.instances).toHaveLength(0);
  act(() => result.current.onTogglePreview());
  expect(String(latest().url)).toBe("ws://localhost:3000/api/v1/sessions/a/terminal-preview");
  expect(result.current.previewBusy).toBe(true);
  act(() => latest().message(frame));
  expect(result.current.preview).toEqual(display);
  expect(result.current.previewBusy).toBe(false);
  act(() =>
    latest().message({
      type: "delta",
      baseRevision: "first",
      revision: "second",
      operations: [{ startLine: 0, deleteCount: 1, lines: ["changed"] }],
      truncated: true,
      capturedAt: "next",
    }),
  );
  expect(result.current.preview).toEqual({
    content: "changed",
    revision: "second",
    truncated: true,
    capturedAt: "next",
  });
  expect(MockWebSocket.instances).toHaveLength(1);
  unmount();
  expect(latest().close).toHaveBeenCalledOnce();
});

it("closes on hiding and collapse, preserves the last frame, and isolates old sockets and sessions", () => {
  let visible: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible);
  const { result, rerender, unmount } = renderHook(
    ({ id, connected }) => useTerminalPreview(id, connected),
    { initialProps: { id: "a", connected: true } },
  );
  act(() => result.current.onTogglePreview());
  const first = latest();
  act(() => first.message(frame));
  visible = "hidden";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(first.close).toHaveBeenCalledOnce();
  expect(result.current.preview).toEqual(display);
  visible = "visible";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(MockWebSocket.instances).toHaveLength(2);
  act(() => first.message({ ...frame, content: "stale" }));
  expect(result.current.preview).toEqual(display);
  act(() => result.current.onTogglePreview());
  expect(latest().close).toHaveBeenCalledOnce();
  act(() => result.current.onTogglePreview());
  rerender({ id: "b", connected: true });
  expect(result.current.previewExpanded).toBe(false);
  expect(result.current.preview).toBeNull();
  act(() => latest().message(frame));
  expect(result.current.preview).toBeNull();
  act(() => result.current.onTogglePreview());
  act(() => latest().message(frame));
  rerender({ id: "b", connected: false });
  expect(latest().close).toHaveBeenCalledOnce();
  expect(result.current.preview).toBeNull();
  expect(result.current.previewExpanded).toBe(false);
  unmount();
});

it("backs off failures, resets after a valid first frame, stops terminal errors, and cancels retry timers", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { result, unmount } = renderHook(() => useTerminalPreview("a", true));
  act(() => result.current.onTogglePreview());
  act(() => latest().disconnect());
  expect(result.current.previewBusy).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(MockWebSocket.instances).toHaveLength(2);
  act(() => latest().disconnect());
  await act(async () => vi.advanceTimersByTimeAsync(1999));
  expect(MockWebSocket.instances).toHaveLength(2);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  act(() => latest().message(frame));
  act(() => latest().message({ type: "error", code: "busy", message: "Busy", retryable: true }));
  expect(result.current.previewError).toBe("Busy");
  expect(result.current.preview).toEqual(display);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(MockWebSocket.instances).toHaveLength(4);
  act(() =>
    latest().message({
      type: "error",
      code: "session_not_found",
      message: "Missing",
      retryable: false,
    }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(MockWebSocket.instances).toHaveLength(4);
  expect(result.current.previewError).toBe("Missing");
  act(() => result.current.onTogglePreview());
  act(() => result.current.onTogglePreview());
  expect(MockWebSocket.instances).toHaveLength(5);
  act(() => latest().disconnect());
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  {
    type: "delta",
    baseRevision: "wrong",
    revision: "bad",
    operations: [],
    truncated: false,
    capturedAt: "bad",
  },
  { ...frame, content: 42 },
  { type: "unknown" },
])("keeps the display and recovers a full baseline after malformed updates: %j", async (bad) => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { result, unmount } = renderHook(() => useTerminalPreview("a", true));
  act(() => result.current.onTogglePreview());
  act(() => latest().message(frame));
  act(() => latest().message(bad));
  expect(result.current.preview).toEqual(display);
  expect(latest().close).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  act(() => latest().message({ ...frame, content: "recovered", revision: "new" }));
  expect(result.current.preview?.content).toBe("recovered");
  unmount();
});

it("rejects an initial delta even if the previous connection left a matching display", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { result, unmount } = renderHook(() => useTerminalPreview("a", true));
  act(() => result.current.onTogglePreview());
  act(() => latest().message(frame));
  act(() => latest().disconnect());
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  act(() =>
    latest().message({
      type: "delta",
      baseRevision: frame.revision,
      revision: "bad",
      operations: [],
      truncated: false,
      capturedAt: "bad",
    }),
  );
  expect(latest().close).toHaveBeenCalledOnce();
  expect(result.current.preview).toEqual(display);
  unmount();
});

it("connects the panel toggle to the socket lifecycle", () => {
  const { unmount } = render(
    <SessionInteraction
      sessionId="a"
      interaction={{
        supported: true,
        activity: "unknown",
        supersededBySessionId: null,
        state: "connected",
        attachCommand: null,
      }}
      itemCount={0}
      updatedAt={null}
    />,
  );
  expect(MockWebSocket.instances).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Terminal Preview" }));
  act(() => latest().message(frame));
  expect(screen.getByLabelText("Terminal Preview content")).toHaveTextContent("output");
  fireEvent.click(screen.getByRole("button", { name: "Terminal Preview" }));
  expect(latest().close).toHaveBeenCalledOnce();
  unmount();
});

it("auto-expands once per key, waits for connection, and resets across sessions", () => {
  const { result, rerender, unmount } = renderHook(
    ({ id, connected, key }) => useTerminalPreview(id, connected, key),
    { initialProps: { id: "a", connected: false, key: "one" } },
  );
  expect(result.current.previewExpanded).toBe(false);
  rerender({ id: "a", connected: true, key: "one" });
  expect(result.current.previewExpanded).toBe(true);
  act(() => result.current.onTogglePreview());
  rerender({ id: "a", connected: true, key: "one" });
  expect(result.current.previewExpanded).toBe(false);
  rerender({ id: "a", connected: true, key: "two" });
  expect(result.current.previewExpanded).toBe(true);
  rerender({ id: "b", connected: true, key: "two" });
  expect(MockWebSocket.instances).toHaveLength(3);
  expect(latest().close).not.toHaveBeenCalled();
  unmount();
});

it.each([false, true])(
  "dismisses details while retaining stopped status and manually retries (retryable=%s)",
  async (retryable) => {
    vi.useFakeTimers();
    const { unmount } = render(
      <SessionInteraction
        sessionId="a"
        interaction={{
          supported: true,
          activity: null,
          state: "connected",
          supersededBySessionId: null,
          attachCommand: null,
        }}
        itemCount={0}
        updatedAt={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Terminal Preview" }));
    const old = latest();
    act(() => old.message(frame));
    act(() => old.message({ type: "error", code: "failed", message: "Capture failed", retryable }));
    expect(screen.getByText("Preview updates stopped.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss terminal preview error" }));
    expect(screen.queryByText("Capture failed")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Terminal Preview content")).toHaveTextContent("output");
    expect(MockWebSocket.instances).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Reconnecting…" })).toBeDisabled();
    act(() => old.message({ ...frame, content: "stale" }));
    act(() => latest().message({ ...frame, revision: "recovered", content: "recovered" }));
    expect(screen.queryByText("Preview updates stopped.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Terminal Preview content")).toHaveTextContent("recovered");
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(MockWebSocket.instances).toHaveLength(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  },
);

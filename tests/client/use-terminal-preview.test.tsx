// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { TerminalPreviewResponse } from "../../src/shared/api-contract";

import { api, ApiClientError } from "../../src/client/api/client";
import { SessionInteraction } from "../../src/client/components/SessionInteraction";
import { useTerminalPreview } from "../../src/client/state/use-terminal-preview";

const frame = { content: "output", truncated: false, capturedAt: "2026-08-08T12:00:00Z" };
afterEach(() => vi.useRealTimers());

it("starts folded, polls after completion without overlap, and preserves unchanged frames", async () => {
  vi.useFakeTimers();
  let resolve!: (value: TerminalPreviewResponse) => void;
  const capture = vi
    .spyOn(api, "terminalPreview")
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue(frame);
  const { result, unmount } = renderHook(() => useTerminalPreview("a", true));
  expect(capture).not.toHaveBeenCalled();
  act(() => result.current.onTogglePreview());
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(capture).toHaveBeenCalledTimes(1);
  await act(async () => resolve(frame));
  const previous = result.current.preview;
  await act(async () => vi.advanceTimersByTimeAsync(999));
  expect(capture).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(capture).toHaveBeenCalledTimes(2);
  expect(result.current.preview).toBe(previous);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels on hide and collapse, resumes immediately, and isolates sessions", async () => {
  let visible: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible);
  let resolve!: (value: TerminalPreviewResponse) => void;
  const capture = vi
    .spyOn(api, "terminalPreview")
    .mockResolvedValueOnce(frame)
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue(frame);
  const { result, rerender, unmount } = renderHook(
    ({ id, connected }) => useTerminalPreview(id, connected),
    { initialProps: { id: "a", connected: true } },
  );
  await act(async () => result.current.onTogglePreview());
  visible = "hidden";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(result.current.preview).toEqual(frame);
  visible = "visible";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  const signal = capture.mock.calls[1]![1];
  act(() => result.current.onTogglePreview());
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve({ ...frame, content: "stale" }));
  expect(result.current.preview).toEqual(frame);
  await act(async () => result.current.onTogglePreview());
  rerender({ id: "a", connected: false });
  expect(result.current.preview).toBeNull();
  await act(async () => rerender({ id: "a", connected: true }));
  expect(result.current.preview).toBeNull();
  expect(result.current.previewExpanded).toBe(false);
  rerender({ id: "b", connected: true });
  expect(result.current.previewExpanded).toBe(false);
  expect(result.current.preview).toBeNull();
  unmount();
});

it("backs off transient errors, retains the frame, and restarts stopped reads on expansion", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const capture = vi
    .spyOn(api, "terminalPreview")
    .mockResolvedValueOnce(frame)
    .mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce(new ApiClientError(400, "bad_request", "bad request"))
    .mockResolvedValue(frame);
  const { result, unmount } = renderHook(() => useTerminalPreview("a", true));
  await act(async () => result.current.onTogglePreview());
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(result.current.previewError).toBe("offline");
  expect(result.current.preview).toEqual(frame);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(capture).toHaveBeenCalledTimes(3);
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(capture).toHaveBeenCalledTimes(3);
  act(() => result.current.onTogglePreview());
  await act(async () => result.current.onTogglePreview());
  expect(capture).toHaveBeenCalledTimes(4);
  unmount();
});

it("connects the panel toggle to the preview lifecycle", async () => {
  const capture = vi.spyOn(api, "terminalPreview").mockResolvedValue(frame);
  const { unmount } = render(
    <SessionInteraction
      sessionId="a"
      interaction={{
        supported: true,
        supersededBySessionId: null,
        state: "connected",
        attachCommand: null,
      }}
      itemCount={0}
      updatedAt={null}
    />,
  );
  expect(capture).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Terminal preview" })));
  expect(screen.getByLabelText("Terminal preview content")).toHaveTextContent("output");
  expect(capture).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Terminal preview" }));
  expect(screen.queryByLabelText("Terminal preview content")).toBeNull();
  unmount();
});

it("auto-expands once per latest message, waits for connection, and resets across sessions", async () => {
  const capture = vi.spyOn(api, "terminalPreview").mockResolvedValue(frame);
  const { result, rerender } = renderHook(
    ({ id, connected, key }) => useTerminalPreview(id, connected, key),
    { initialProps: { id: "a", connected: false, key: "request-a" as string | null } },
  );
  expect(result.current.previewExpanded).toBe(false);
  expect(capture).not.toHaveBeenCalled();
  await act(async () => rerender({ id: "a", connected: true, key: "request-a" }));
  expect(result.current.previewExpanded).toBe(true);
  act(() => result.current.onTogglePreview());
  rerender({ id: "a", connected: true, key: "request-a" });
  expect(result.current.previewExpanded).toBe(false);
  rerender({ id: "a", connected: false, key: "request-a" });
  rerender({ id: "a", connected: true, key: "request-a" });
  expect(result.current.previewExpanded).toBe(false);
  await act(async () => rerender({ id: "a", connected: true, key: "plan-b" }));
  expect(result.current.previewExpanded).toBe(true);
  rerender({ id: "b", connected: true, key: null });
  expect(result.current.previewExpanded).toBe(false);
  await act(async () => rerender({ id: "b", connected: true, key: "plan-b" }));
  expect(result.current.previewExpanded).toBe(true);
});

it("cancels preview polling when a live update marks the session superseded", async () => {
  vi.useFakeTimers();
  let complete!: (value: TerminalPreviewResponse) => void;
  const capture = vi.spyOn(api, "terminalPreview").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const properties = { sessionId: "old", itemCount: 1, updatedAt: null };
  const view = render(
    <SessionInteraction
      {...properties}
      interaction={{
        supported: true,
        state: "connected",
        supersededBySessionId: null,
        attachCommand: null,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Terminal preview" }));
  expect(capture).toHaveBeenCalledOnce();
  const signal = capture.mock.calls[0]![1];
  view.rerender(
    <SessionInteraction
      {...properties}
      interaction={{
        supported: true,
        state: "superseded",
        supersededBySessionId: "new",
        attachCommand: null,
      }}
    />,
  );
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    complete(frame);
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(capture).toHaveBeenCalledOnce();
  expect(screen.queryByText("output")).not.toBeInTheDocument();
});

it("rejects delayed expansion callbacks while disconnected and stops pending captures", async () => {
  vi.useFakeTimers();
  let complete!: (value: TerminalPreviewResponse) => void;
  const capture = vi.spyOn(api, "terminalPreview").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const { result, rerender } = renderHook(({ connected }) => useTerminalPreview("a", connected), {
    initialProps: { connected: true },
  });
  const delayedExpand = result.current.onExpandPreview;
  act(() => result.current.onExpandPreview());
  const signal = capture.mock.calls[0]![1];
  rerender({ connected: false });
  expect(signal?.aborted).toBe(true);
  expect(result.current.previewExpanded).toBe(false);
  act(() => delayedExpand());
  expect(result.current.previewExpanded).toBe(false);
  await act(async () => {
    complete(frame);
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(result.current.preview).toBeNull();
  expect(result.current.previewBusy).toBe(false);
  rerender({ connected: true });
  expect(result.current.previewExpanded).toBe(false);
  expect(capture).toHaveBeenCalledOnce();
});

it.each(["command", "handoff"])(
  "keeps preview folded when a delayed %s completes after disconnect",
  async (action) => {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    vi.spyOn(api, "terminalPreview").mockResolvedValue(frame);
    const operation =
      action === "command" ? vi.spyOn(api, "sendMessage") : vi.spyOn(api, "handoffPaneBinding");
    operation.mockReturnValue(pending);
    const properties = { sessionId: "a", itemCount: 0, updatedAt: null };
    const connected = {
      supported: true as const,
      state: "connected" as const,
      supersededBySessionId: null,
      attachCommand: null,
    };
    const view = render(<SessionInteraction {...properties} interaction={connected} />);
    if (action === "command") {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "/plan" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    } else fireEvent.click(screen.getByRole("button", { name: "Handoff" }));
    expect(operation).toHaveBeenCalledOnce();
    view.rerender(
      <SessionInteraction {...properties} interaction={{ ...connected, state: "disconnected" }} />,
    );
    await act(async () => complete());
    expect(screen.getByRole("button", { name: "Terminal preview" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    view.rerender(<SessionInteraction {...properties} interaction={connected} />);
    expect(screen.getByRole("button", { name: "Terminal preview" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  },
);

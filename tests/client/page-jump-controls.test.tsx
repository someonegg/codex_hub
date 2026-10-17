import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PageJumpControls } from "../../src/client/components/PageJumpControls";

// @vitest-environment jsdom

describe("page jump controls", () => {
  afterEach(() => {
    setPageMetrics({ scrollY: 0, innerHeight: 768, scrollHeight: 768 });
  });

  it("shows only the controls that move away from the nearest edge", async () => {
    setPageMetrics({ scrollY: 0, innerHeight: 800, scrollHeight: 3_000 });
    render(<PageJumpControls />);

    expect(screen.queryByRole("button", { name: "Back to top" })).toBeNull();
    expect(screen.getByRole("button", { name: "Jump to bottom" })).toBeVisible();

    act(() => {
      setPageMetrics({ scrollY: 1_100, innerHeight: 800, scrollHeight: 3_000 });
      fireEvent.scroll(window);
    });
    expect(await screen.findByRole("button", { name: "Back to top" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Jump to bottom" })).toBeVisible();

    act(() => {
      setPageMetrics({ scrollY: 2_200, innerHeight: 800, scrollHeight: 3_000 });
      fireEvent.scroll(window);
    });
    expect(screen.getByRole("button", { name: "Back to top" })).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Jump to bottom" })).toBeNull();
    });
  });

  it("jumps to either page edge", () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    setPageMetrics({ scrollY: 1_000, innerHeight: 800, scrollHeight: 3_000 });
    render(<PageJumpControls />);

    fireEvent.click(screen.getByRole("button", { name: "Back to top" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    fireEvent.click(screen.getByRole("button", { name: "Jump to bottom" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 3_000, behavior: "smooth" });
  });

  it("avoids smooth scrolling when reduced motion is requested", () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    setPageMetrics({ scrollY: 1_000, innerHeight: 800, scrollHeight: 3_000 });
    render(<PageJumpControls />);

    fireEvent.click(screen.getByRole("button", { name: "Back to top" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
    fireEvent.click(screen.getByRole("button", { name: "Jump to bottom" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 3_000, behavior: "auto" });
  });

  it("updates when the document height changes and disconnects its observer", async () => {
    let notifyResize!: ResizeObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = callback;
        }
        observe() {}
        disconnect() {
          disconnect();
        }
      },
    );
    setPageMetrics({ scrollY: 0, innerHeight: 800, scrollHeight: 800 });
    const view = render(<PageJumpControls />);
    expect(screen.queryByRole("button", { name: "Jump to bottom" })).toBeNull();

    act(() => {
      setPageMetrics({ scrollY: 0, innerHeight: 800, scrollHeight: 2_000 });
      notifyResize([], {} as ResizeObserver);
    });
    expect(await screen.findByRole("button", { name: "Jump to bottom" })).toBeVisible();

    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("coalesces repeated scroll events into one animation frame", () => {
    let runFrame!: FrameRequestCallback;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      runFrame = callback;
      return 7;
    });
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    setPageMetrics({ scrollY: 0, innerHeight: 800, scrollHeight: 3_000 });
    render(<PageJumpControls />);

    act(() => {
      setPageMetrics({ scrollY: 1_100, innerHeight: 800, scrollHeight: 3_000 });
      fireEvent.scroll(window);
      fireEvent.scroll(window);
    });
    expect(requestAnimationFrame).toHaveBeenCalledOnce();

    act(() => runFrame(16));
    expect(screen.getByRole("button", { name: "Back to top" })).toBeVisible();
  });
});

function setPageMetrics(metrics: { scrollY: number; innerHeight: number; scrollHeight: number }) {
  Object.defineProperty(window, "scrollY", { configurable: true, value: metrics.scrollY });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: metrics.innerHeight });
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
}

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageJumpControls } from "../../src/client/components/PageJumpControls";

// @vitest-environment jsdom

describe("page jump controls", () => {
  beforeEach(() => vi.useFakeTimers());
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
    await act(async () => vi.advanceTimersToNextFrame());
    expect(screen.getByRole("button", { name: "Back to top" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Jump to bottom" })).toBeVisible();

    act(() => {
      setPageMetrics({ scrollY: 2_200, innerHeight: 800, scrollHeight: 3_000 });
      fireEvent.scroll(window);
    });
    expect(screen.getByRole("button", { name: "Back to top" })).toBeVisible();
    await act(async () => vi.advanceTimersToNextFrame());
    expect(screen.queryByRole("button", { name: "Jump to bottom" })).toBeNull();
  });

  it.each([
    [false, "smooth"],
    [true, "auto"],
  ] as const)("jumps to either edge with reduced motion=%s", (matches, behavior) => {
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches }));
    setPageMetrics({ scrollY: 1_000, innerHeight: 800, scrollHeight: 3_000 });
    render(<PageJumpControls />);

    fireEvent.click(screen.getByRole("button", { name: "Back to top" }));
    fireEvent.click(screen.getByRole("button", { name: "Jump to bottom" }));
    expect(scrollTo.mock.calls).toEqual([[{ top: 0, behavior }], [{ top: 3_000, behavior }]]);
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
    await act(async () => vi.advanceTimersToNextFrame());
    expect(screen.getByRole("button", { name: "Jump to bottom" })).toBeVisible();

    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("keeps controls above the panel and returns them to the viewport corner", async () => {
    setPageMetrics({ scrollY: 1_000, innerHeight: 800, scrollHeight: 3_000 });
    const panel = document.createElement("section");
    const bounds = vi.spyOn(panel, "getBoundingClientRect");
    bounds.mockReturnValue({ top: 600 } as DOMRect);
    const view = render(<PageJumpControls interactionPanel={panel} />);
    const controls = screen.getByRole("navigation", { name: "Page position" });
    expect(controls.style.getPropertyValue("--panel-clearance")).toBe("212px");

    bounds.mockReturnValue({ top: -200 } as DOMRect);
    fireEvent.scroll(window);
    await act(async () => vi.advanceTimersToNextFrame());
    expect(controls.style.getPropertyValue("--panel-clearance")).toBe("1012px");

    bounds.mockReturnValue({ top: 1_200 } as DOMRect);
    fireEvent.scroll(window);
    await act(async () => vi.advanceTimersToNextFrame());
    expect(controls.style.getPropertyValue("--panel-clearance")).toBe("0px");

    bounds.mockReturnValue({ top: 600 } as DOMRect);
    fireEvent.scroll(window);
    await act(async () => vi.advanceTimersToNextFrame());
    expect(controls.style.getPropertyValue("--panel-clearance")).toBe("212px");
    view.rerender(<PageJumpControls interactionPanel={null} />);
    expect(controls.style.getPropertyValue("--panel-clearance")).toBe("0px");
  });

  it("updates clearance when the panel resizes and observes a replacement panel", async () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    let notifyResize!: ResizeObserverCallback;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    setPageMetrics({ scrollY: 1_000, innerHeight: 800, scrollHeight: 3_000 });
    const panel = document.createElement("section");
    const bounds = vi.spyOn(panel, "getBoundingClientRect");
    bounds.mockReturnValue({ top: 600 } as DOMRect);
    const view = render(<PageJumpControls interactionPanel={panel} />);
    expect(observe).toHaveBeenCalledWith(panel);
    bounds.mockReturnValue({ top: 400 } as DOMRect);
    act(() => notifyResize([], {} as ResizeObserver));
    await act(async () => vi.advanceTimersToNextFrame());
    const controls = screen.getByRole("navigation", { name: "Page position" });
    expect(controls.style.getPropertyValue("--panel-clearance")).toBe("412px");

    const replacement = document.createElement("section");
    vi.spyOn(replacement, "getBoundingClientRect").mockReturnValue({ top: 700 } as DOMRect);
    view.rerender(<PageJumpControls interactionPanel={replacement} />);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(replacement);
    expect(controls.style.getPropertyValue("--panel-clearance")).toBe("112px");
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

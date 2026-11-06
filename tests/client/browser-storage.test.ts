// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

const key = "ahub.browser-state.v1";

beforeEach(() => {
  sessionStorage.clear();
  vi.resetModules();
});

it("retains unsaved values over readable old snapshots and flushes them on recovery", async () => {
  sessionStorage.setItem(key, JSON.stringify({ agent: "old", scroll: "10" }));
  const { browserStorage } = await import("../../src/client/state/browser-storage");
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Full", "QuotaExceededError");
  });
  browserStorage.setItem("agent", "new");
  browserStorage.setItem("timeline", "tools");
  expect(browserStorage.getItem("agent")).toBe("new");
  expect(browserStorage.getItem("timeline")).toBe("tools");
  expect(browserStorage.getItem("scroll")).toBe("10");
  write.mockRestore();
  browserStorage.setItem("scroll", "20");
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({
    agent: "new",
    timeline: "tools",
    scroll: "20",
  });
});

it("retains consecutive updates when storage is entirely unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Blocked");
  });
  const { browserStorage } = await import("../../src/client/state/browser-storage");
  browserStorage.setItem("agent", "work");
  browserStorage.setItem("timeline", "tools");
  expect(browserStorage.getItem("agent")).toBe("work");
  expect(browserStorage.getItem("timeline")).toBe("tools");
});

it("does not discard memory when a read fails after a successful save", async () => {
  const { browserStorage } = await import("../../src/client/state/browser-storage");
  browserStorage.setItem("agent", "work");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Blocked");
  });
  expect(browserStorage.getItem("agent")).toBe("work");
});

it("observes cleared storage after successful writes", async () => {
  const { browserStorage } = await import("../../src/client/state/browser-storage");
  browserStorage.setItem("agent", "work");
  sessionStorage.clear();
  expect(browserStorage.getItem("agent")).toBeNull();
});

it("ignores independent keys and only updates the unified document", async () => {
  sessionStorage.setItem("agent", "old");
  const { browserStorage } = await import("../../src/client/state/browser-storage");
  expect(browserStorage.getItem("agent")).toBeNull();
  expect(sessionStorage.getItem(key)).toBeNull();
  browserStorage.setItem("agent", "work");
  expect(browserStorage.getItem("agent")).toBe("work");
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({ agent: "work" });
  expect(sessionStorage.getItem("agent")).toBe("old");
});

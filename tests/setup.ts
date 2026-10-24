import { afterEach, vi } from "vitest";

import { cleanupTempDirectories } from "./helpers/temp-directories.js";

afterEach(cleanupTempDirectories);
// Node-only suites do not need the DOM matchers or React renderer.
if (typeof window !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
  const { cleanup } = await import("@testing-library/react/pure");
  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    window.history.replaceState(null, "", "/");
  });
}
afterEach(() => vi.useRealTimers());

if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
}

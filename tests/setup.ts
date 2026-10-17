import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import { cleanupTempDirectories } from "./helpers/temp-directories.js";

afterEach(cleanupTempDirectories);
afterEach(() => {
  vi.useRealTimers();
  if (typeof window === "undefined") return;
  cleanup();
  window.sessionStorage.clear();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  window.history.replaceState(null, "", "/");
});

if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
}

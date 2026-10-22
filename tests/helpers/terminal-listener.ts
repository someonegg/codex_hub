import { vi } from "vitest";

import type { PreviewListener } from "../../src/server/interaction/tmux-preview-listener.js";

/** Unit tests must opt in to pane output and never start native tmux clients. */
export function createTestPreviewListener() {
  return vi.fn<PreviewListener>(() => ({ ready: Promise.resolve(), close: vi.fn() }));
}

import { expect, it } from "vitest";

import { applyPreview } from "../../src/client/state/terminal-preview-patch";
const current = { content: "a\nb\n", revision: "one", truncated: false, capturedAt: "before" };
const delta = {
  baseRevision: "one",
  revision: "three",
  truncated: true,
  capturedAt: "after",
  patches: [
    { operations: [{ startLine: 1, deleteCount: 1, lines: ["你好😀"] }] },
    { operations: [] },
  ],
};
it("applies ordered patches with final metadata", () => {
  expect(applyPreview(current, delta)).toEqual({
    content: "a\n你好😀\n",
    revision: "three",
    truncated: true,
    capturedAt: "after",
  });
});
it("rejects missing bases and invalid operations without mutating the snapshot", () => {
  expect(applyPreview(null, delta)).toBeNull();
  expect(applyPreview({ ...current, revision: "other" }, delta)).toBeNull();
  for (const startLine of [-1, 0.5, 100, NaN]) {
    expect(
      applyPreview(current, {
        ...delta,
        patches: [{ operations: [{ startLine, deleteCount: 0, lines: [] }] }],
      }),
    ).toBeNull();
  }
  expect(current.content).toBe("a\nb\n");
});

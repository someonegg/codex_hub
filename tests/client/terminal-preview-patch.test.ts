import { expect, it } from "vitest";

import type { LineOperation } from "../../src/shared/api-contract";

import { applyPreview } from "../../src/client/state/terminal-preview-patch";
const current = { content: "a\nb\n", revision: "one", truncated: false, capturedAt: "before" };
const delta = {
  type: "delta" as const,
  baseRevision: "one",
  revision: "two",
  truncated: true,
  capturedAt: "after",
  operations: [
    { startLine: 1, deleteCount: 1, lines: ["你好😀", "inserted"] },
    { startLine: 0, deleteCount: 1, lines: ["A"] },
  ],
};
it("applies descending operations with final metadata", () => {
  expect(applyPreview(current, delta)).toEqual({
    content: "A\n你好😀\ninserted\n",
    revision: "two",
    truncated: true,
    capturedAt: "after",
  });
});
it("accepts a full frame without keeping its wire discriminator", () => {
  expect(applyPreview(null, { ...current, type: "snapshot" })).toEqual(current);
});
it("keeps trailing newlines and commits truncation-only updates", () => {
  expect(applyPreview(current, { ...delta, operations: [] })).toEqual({
    ...current,
    revision: "two",
    truncated: true,
    capturedAt: "after",
  });
});
it("rejects missing bases and invalid operations without mutating the snapshot", () => {
  expect(applyPreview(null, delta)).toBeNull();
  expect(applyPreview({ ...current, revision: "other" }, delta)).toBeNull();
  const invalidOperations: LineOperation[][] = [
    ...[-1, 0.5, 100, NaN].map((startLine) => [{ startLine, deleteCount: 0, lines: [] }]),
    [{ startLine: 0, deleteCount: -1, lines: [] }],
    [{ startLine: 0, deleteCount: 0.5, lines: [] }],
    [{ startLine: 2, deleteCount: 2, lines: [] }],
    [{ startLine: 0, deleteCount: 0, lines: ["unexpected\nnewline"] }],
    [
      { startLine: 0, deleteCount: 1, lines: [] },
      { startLine: 2, deleteCount: 0, lines: ["out of order"] },
    ],
    [
      { startLine: 1, deleteCount: 1, lines: [] },
      { startLine: 0, deleteCount: 2, lines: ["overlap"] },
    ],
  ];
  for (const operations of invalidOperations) {
    expect(
      applyPreview(current, {
        ...delta,
        operations,
      }),
    ).toBeNull();
  }
  expect(current.content).toBe("a\nb\n");
});

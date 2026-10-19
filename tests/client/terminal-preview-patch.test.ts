import { expect, it } from "vitest";

import type { LineOperation } from "../../src/shared/api-contract";

import { applyPreview } from "../../src/client/state/terminal-preview-patch";
const current = { content: "a\nb\n", revision: "one", truncated: false, capturedAt: "before" };
const delta = {
  baseRevision: "one",
  revision: "three",
  truncated: true,
  capturedAt: "after",
  patches: [
    { operations: [{ startLine: 1, deleteCount: 1, lines: ["你好😀", "inserted"] }] },
    { operations: [] },
    {
      operations: [
        { startLine: 3, deleteCount: 0, lines: ["tail"] },
        { startLine: 0, deleteCount: 1, lines: ["A"] },
      ],
    },
  ],
};
it("applies ordered patches with final metadata", () => {
  expect(applyPreview(current, delta)).toEqual({
    content: "A\n你好😀\ninserted\ntail\n",
    revision: "three",
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
        patches: [{ operations }],
      }),
    ).toBeNull();
  }
  expect(current.content).toBe("a\nb\n");
});

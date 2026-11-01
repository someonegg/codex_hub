import { expect, it } from "vitest";

import { diffLines } from "../../src/server/interaction/terminal-preview-diff.js";

it.each([
  ["", "你好\n😀\n"],
  ["a\n", ""],
  ["", ""],
])("reconstructs %j → %j exactly", (before, after) => {
  const lines = before.split("\n");
  const operations = diffLines(before, after);
  expect(operations).not.toBeNull();
  for (const op of operations!) lines.splice(op.startLine, op.deleteCount, ...op.lines);
  expect(lines.join("\n")).toBe(after);
});

it("bounds edit distance and comparison work", () => {
  expect(diffLines(Array(300).fill("a").join("\n"), Array(300).fill("b").join("\n"))).toBeNull();
  expect(diffLines("a\n".repeat(1_000_001), "a\n".repeat(1_000_001))).toBeNull();
});

it("reconstructs randomized repeated lines", () => {
  let seed = 17;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  for (let n = 0; n < 1000; n++) {
    const make = () => Array.from({ length: random() % 30 }, () => String(random() % 5)).join("\n");
    const before = make(),
      after = make();
    const lines = before.split("\n");
    for (const op of diffLines(before, after)!)
      lines.splice(op.startLine, op.deleteCount, ...op.lines);
    expect(lines.join("\n")).toBe(after);
  }
});

import { afterEach, expect, it, vi } from "vitest";

import { formatTable, output, outputFailure, singleLine } from "../../src/server/cli/output.js";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});
it("keeps JSON results compatible and human output explicit", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  output({ deleted: true }, true, "Deleted page id");
  expect(log).toHaveBeenLastCalledWith('{"deleted":true}');
  output({ deleted: true }, false, "Deleted page id");
  expect(log).toHaveBeenLastCalledWith("Deleted page id");
  expect(singleLine("a\nb\tc")).toBe("a b c");
});
it("separates JSON errors from human diagnostics", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  outputFailure(new Error("Storage failed"), true);
  expect(JSON.parse(log.mock.calls[0]![0]).error.code).toBe("command_failed");
  expect(err).not.toHaveBeenCalled();
  outputFailure(new Error("Storage failed"), false);
  expect(err).toHaveBeenCalledWith("Storage failed");
  expect(process.exitCode).toBe(1);
});

it("does not classify arbitrary TypeErrors as invalid arguments", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  outputFailure(new TypeError("Unexpected internal failure"), true);
  expect(JSON.parse(log.mock.calls[0]![0]).error.code).toBe("command_failed");
});

it("aligns mixed Unicode by display cells rather than code units", () => {
  expect(
    formatTable(
      ["NAME", "VALUE"],
      [
        ["中文", "CJK"],
        ["e\u0301", "combining"],
        ["👩🏽‍💻", "ZWJ"],
        ["🇨🇳", "flag"],
        ["✈️", "variation"],
        ["Ａ", "fullwidth"],
        ["·", "ambiguous"],
        ["", "empty"],
      ],
    ),
  ).toBe(
    [
      "NAME  VALUE",
      "中文  CJK",
      "e\u0301     combining",
      "👩🏽‍💻    ZWJ",
      "🇨🇳    flag",
      "✈️    variation",
      "Ａ    fullwidth",
      "·     ambiguous",
      "      empty",
    ].join("\n"),
  );
});

it("preserves long fields, normalizes cell whitespace before measuring and omits trailing padding", () => {
  const long = "/projects/" + "中文".repeat(80);
  expect(
    formatTable(
      ["PATH", "TITLE"],
      [
        [long, "full"],
        ["a\r\nb\tc", ""],
      ],
    ),
  ).toBe(`PATH${" ".repeat(328)}TITLE\n${long}  full\na  b c`);
  expect(formatTable(["ID", "TITLE"], [])).toBe("ID  TITLE");
});

it("aligns URLs after text symbols and emoji forms using independent cell widths", () => {
  // Expected widths are fixtures, not values calculated by the production dependency.
  const symbols: [string, number][] = [
    ["©", 1],
    ["©\uFE0F", 2],
    ["©\uFE0E", 1],
    ["™", 1],
    ["™\uFE0F", 2],
    ["™\uFE0E", 1],
    ["↔", 1],
    ["↔\uFE0F", 2],
    ["☺", 1],
    ["☺\uFE0F", 2],
    ["✈", 1],
    ["✈\uFE0F", 2],
    ["1\uFE0F\u20E3", 2],
    ["1\u20E3", 2],
    ["👨‍👩‍👧‍👦", 2],
    ["🏳️‍🌈", 2],
    ["e\u0301", 1],
    ["\u0301", 0],
    ["\u200D", 0],
    ["x", 1],
  ];
  const lines = formatTable(
    ["TITLE", "URL"],
    symbols.map(([symbol]) => [`${symbol} report`, "/value"]),
  ).split("\n");
  expect(lines[0]).toBe("TITLE      URL");
  symbols.forEach(([symbol, cells], index) => {
    const title = `${symbol} report`;
    const line = lines[index + 1]!;
    expect(line).toBe(`${title}${" ".repeat(4 - cells)}/value`);
    const padding = line.indexOf("/value") - title.length;
    // Measure the emitted column start with the fixture's grapheme width plus ASCII cells.
    expect(cells + " report".length + padding).toBe(11);
  });
});

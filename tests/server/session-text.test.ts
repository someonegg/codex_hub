import { describe, expect, it } from "vitest";

import {
  MAX_SESSION_TITLE_CHARS,
  sessionTitleFromMarkdown,
  truncateText,
} from "../../src/server/domain/session-text.js";

describe("session title text", () => {
  it("does not split a UTF-16 surrogate pair at the code-unit limit", () => {
    const prefix = "x".repeat(3);

    expect(truncateText(`${prefix}😀tail`, 4)).toEqual({
      text: prefix,
      truncated: true,
    });
  });

  it("uses a Setext heading for the session title", () => {
    expect(sessionTitleFromMarkdown("intro\n\nSetext level one\n================")).toBe(
      "Setext level one",
    );
  });

  it("uses the first H1 or H2 in document order and extracts plain text", () => {
    expect(
      sessionTitleFromMarkdown(
        "## **First** [heading](https://example.com) with `code`\n\n# Later heading",
      ),
    ).toBe("First heading with code");
  });

  it("ignores headings inside fenced code", () => {
    expect(sessionTitleFromMarkdown("Fallback line\n\n```md\n# Fenced heading\n```")).toBe(
      "Fallback line",
    );
  });

  it("bounds a Markdown heading to the session title limit", () => {
    const heading = "x".repeat(MAX_SESSION_TITLE_CHARS + 1);
    expect(sessionTitleFromMarkdown(`# ${heading}`)).toBe(
      heading.slice(0, MAX_SESSION_TITLE_CHARS),
    );
  });

  it("safely falls back when Markdown nesting exceeds the title traversal limit", () => {
    const markdown = `${"> ".repeat(5_000)}# Deep heading`;
    expect(sessionTitleFromMarkdown(markdown)).not.toBe("Deep heading");
  });
});

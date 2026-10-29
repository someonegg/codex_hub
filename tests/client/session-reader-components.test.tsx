import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { MessageItem as Message, SessionDetail } from "../../src/shared/domain";

import { EventTime } from "../../src/client/components/EventTime";
import {
  MessageItem,
  planPreview,
  safeUrlTransform,
} from "../../src/client/components/MessageItem";
import { SessionHeader } from "../../src/client/components/SessionHeader";
import { Timeline } from "../../src/client/components/Timeline";
import { DEFAULT_TIMELINE_VISIBILITY } from "../../src/client/state/timeline-visibility";
import { firstPage, SESSION_ID } from "./session.fixtures";

// @vitest-environment jsdom

describe("session reader components", () => {
  it("keeps technical details collapsed while event filters remain visible", async () => {
    const user = userEvent.setup();
    const session: SessionDetail = {
      ...firstPage.session,
      projectDirectory: "/project/main",
      workingDirectory: "/worktrees/task",
    };
    const header = (value: typeof session) => (
      <SessionHeader
        session={value}
        visibility={DEFAULT_TIMELINE_VISIBILITY}
        onVisibilityChange={vi.fn()}
      />
    );
    const view = render(header(session));
    const details = screen.getByText("Session information").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByRole("group", { name: "Timeline event visibility" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /^tool$/ })).toBeVisible();
    expect(screen.getByText(/Project Directory/)).not.toBeVisible();
    await user.click(screen.getByText("Session information"));
    expect(details).toHaveAttribute("open");
    expect(screen.getByText(/Project Directory/)).toBeVisible();
    expect(screen.getByRole("group", { name: "Timeline event visibility" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /^tool$/ })).toBeVisible();
    expect(screen.getByText(/Project Directory/)).toHaveTextContent(
      "Project Directory · /project/main",
    );
    expect(screen.getByText(/Working Directory/)).toHaveTextContent(
      "Working Directory · /worktrees/task",
    );
    view.rerender(header({ ...session, workingDirectory: session.projectDirectory }));
    expect(screen.getAllByText("/project/main")).toHaveLength(2);
    expect(details).toHaveAttribute("open");
    view.rerender(header({ ...session, workingDirectory: null, projectDirectory: null }));
    expect(screen.getByText(/Project Directory/)).toHaveTextContent(
      "Project Directory · Unavailable",
    );
    expect(screen.getByText(/Working Directory/)).toHaveTextContent(
      "Working Directory · Unavailable",
    );
  });

  it("closes session information when switching sessions", async () => {
    const user = userEvent.setup();
    const header = (id: string) => (
      <SessionHeader
        session={{ ...firstPage.session, id }}
        visibility={DEFAULT_TIMELINE_VISIBILITY}
        onVisibilityChange={vi.fn()}
      />
    );
    const view = render(header("first"));
    await user.click(screen.getByText("Session information"));
    expect(screen.getByText("Session information").closest("details")).toHaveAttribute("open");
    view.rerender(header("second"));
    expect(screen.getByText("Session information").closest("details")).not.toHaveAttribute("open");
  });

  it("renders valid event timestamps with semantic time markup and omits invalid values", () => {
    const valid = "2026-07-28T10:00:00.000Z";
    const view = render(<EventTime timestamp={valid} />);
    expect(
      screen.getByText(
        new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        }).format(new Date(valid)),
      ),
    ).toHaveAttribute("datetime", valid);
    expect(view.container.querySelector("time")).not.toHaveTextContent("2026");

    view.rerender(<EventTime timestamp={null} />);
    expect(document.querySelector("time")).toBeNull();
    view.rerender(<EventTime timestamp="not-a-timestamp" />);
    expect(document.querySelector("time")).toBeNull();
  });

  it("uses request time for paired user input and response time for an orphan", () => {
    render(
      <Timeline
        items={[
          {
            kind: "user_input",
            stage: "request",
            id: "request",
            ordinal: 1,
            timestamp: "2026-07-28T10:00:00.000Z",
            callId: "paired",
            questions: [],
          },
          {
            kind: "user_input",
            stage: "response",
            outcome: "aborted",
            id: "response",
            ordinal: 2,
            timestamp: "2026-07-28T10:00:01.000Z",
            callId: "paired",
          },
          {
            kind: "user_input",
            stage: "response",
            outcome: "aborted",
            id: "orphan",
            ordinal: 3,
            timestamp: "2026-07-28T10:00:02.000Z",
            callId: "orphan",
          },
        ]}
        sessionId={SESSION_ID}
        cursor={firstPage.cursor}
        hasMore={false}
        loading={false}
        onLoadMore={vi.fn()}
        onTimelineConflict={vi.fn()}
      />,
    );

    expect(
      [...document.querySelectorAll("time")].map((node) => node.getAttribute("datetime")),
    ).toEqual(["2026-07-28T10:00:00.000Z", "2026-07-28T10:00:02.000Z"]);
  });

  it("renders detailed total and last token usage in separate groups", () => {
    render(
      <Timeline
        items={[
          {
            kind: "token",
            id: "token-7",
            ordinal: 7,
            timestamp: null,
            tokenUsage: {
              total: {
                totalTokens: 12_345,
                inputTokens: 10_000,
                cachedInputTokens: 4_000,
                cacheWriteInputTokens: 500,
                outputTokens: 2_000,
                reasoningOutputTokens: 345,
              },
              last: {
                totalTokens: 678,
                inputTokens: 500,
                cachedInputTokens: 100,
                cacheWriteInputTokens: null,
                outputTokens: 150,
                reasoningOutputTokens: null,
              },
            },
          },
        ]}
        sessionId={SESSION_ID}
        cursor={firstPage.cursor}
        hasMore={false}
        loading={false}
        onLoadMore={vi.fn()}
        onTimelineConflict={vi.fn()}
      />,
    );

    const total = screen.getByRole("region", { name: "Total token usage" });
    const last = screen.getByRole("region", { name: "Last token usage" });
    expect(within(total).getByText("12,345")).toBeInTheDocument();
    expect(within(total).getByText("4,000")).toBeInTheDocument();
    expect(within(total).getByText("500")).toBeInTheDocument();
    expect(within(last).getByText("678")).toBeInTheDocument();
    expect(within(last).getByText("150")).toBeInTheDocument();
    expect(within(last).queryByText("Cache write input")).toBeNull();
    expect(within(last).queryByText("Reasoning output")).toBeNull();
  });

  it("renders Markdown without raw HTML, external images, or dangerous links", () => {
    render(
      <MessageItem
        item={{
          kind: "message",
          id: "message-9",
          ordinal: 9,
          timestamp: null,
          role: "assistant",
          phase: "response",
          itemType: null,
          markdown:
            "<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![remote](https://tracker.invalid/a.png)\n\n[good](https://example.com)",
        }}
      />,
    );
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("[Image omitted: remote]")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "good" })).toHaveAttribute(
      "rel",
      "noreferrer noopener",
    );
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(safeUrlTransform("data:text/html,boom")).toBe("");
    expect(safeUrlTransform("file:///tmp/secret")).toBe("");
  });

  it("renders single-line double-dollar math inline and multiline math as display", () => {
    render(
      <MessageItem
        item={{
          kind: "message",
          id: "message-math",
          ordinal: 10,
          timestamp: null,
          role: "assistant",
          phase: "response",
          itemType: null,
          markdown:
            "Inline $E = mc^2$.\n\n$$a^2 + b^2 = c^2$$\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$",
        }}
      />,
    );

    expect(document.querySelector(".katex")).toBeInTheDocument();
    expect(document.querySelector(".katex-display .katex")).toBeInTheDocument();
    expect(document.querySelectorAll(".katex")).toHaveLength(3);
    expect(document.querySelectorAll(".katex-display .katex")).toHaveLength(1);
    expect(document.querySelector("[node]")).toBeNull();
  });

  it("gives tables, code blocks, and display math independent accessible scroll regions", () => {
    render(
      <MessageItem
        item={{
          kind: "message",
          id: "message-wide-markdown",
          ordinal: 11,
          timestamp: null,
          role: "assistant",
          phase: "response",
          itemType: null,
          markdown: [
            "| Column | Value |",
            "| --- | --- |",
            "| alpha | beta |",
            "",
            "```text",
            "a very wide line that keeps its original code formatting",
            "```",
            "",
            "$$",
            "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
            "$$",
          ].join("\n"),
        }}
      />,
    );

    const tableRegion = screen.getByRole("region", { name: "Scrollable table" });
    const codeRegion = screen.getByRole("region", { name: "Scrollable code block" });
    const mathRegion = screen.getByRole("region", { name: "Scrollable math formula" });
    expect(tableRegion).toHaveAttribute("tabindex", "0");
    expect(codeRegion).toHaveAttribute("tabindex", "0");
    expect(mathRegion).toHaveAttribute("tabindex", "0");
    expect(tableRegion.querySelector(":scope > table")).toBeInTheDocument();
    expect(codeRegion.querySelector(":scope > pre > code")).toBeInTheDocument();
    expect(mathRegion.querySelector(":scope > .katex-display")).toBeInTheDocument();
    expect(document.querySelector("[node]")).toBeNull();
  });

  it("leaves math syntax in code untouched and keeps invalid math readable", () => {
    render(
      <MessageItem
        item={{
          kind: "message",
          id: "message-math-edge",
          ordinal: 11,
          timestamp: null,
          role: "assistant",
          phase: "response",
          itemType: null,
          markdown: "`$notMath$`\n\n```text\n$$not display math$$\n```\n\n$$\\frac{1}{$$",
        }}
      />,
    );

    expect(screen.getByText("$notMath$")).toBeInTheDocument();
    expect(screen.getByText("$$not display math$$")).toBeInTheDocument();
    expect(document.querySelector("code .katex")).toBeNull();
    expect(document.querySelector(".katex-error")).toHaveTextContent("\\frac{1}{");
  });

  it("previews completed plans collapsed and toggles their full Markdown", async () => {
    const user = userEvent.setup();
    render(
      <MessageItem
        item={{
          kind: "message",
          id: "message-plan",
          ordinal: 12,
          timestamp: null,
          role: "assistant",
          phase: "response",
          itemType: "Plan",
          markdown:
            "<proposed_plan>\n# Release plan\n\n- First **important** step\n- Read the [docs](https://example.com)\n</proposed_plan>",
        }}
      />,
    );

    const toggle = screen.getByRole("button", { name: /Assistant response · Plan · 12.*Show/ });
    expect(toggle.querySelector(".message-avatar")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".plan-preview")).toHaveTextContent(
      "Release plan First important step Read the docs",
    );
    expect(document.querySelector(".plan-preview")).not.toHaveTextContent("proposed_plan");
    expect(screen.queryByRole("heading", { name: "Release plan" })).toBeNull();
    const contentId = toggle.getAttribute("aria-controls");
    expect(contentId === null ? null : document.getElementById(contentId)).toBeNull();
    expect(document.querySelector(".plan-preview")).not.toHaveAttribute("id");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const fullContent = document.getElementById(contentId!);
    expect(fullContent).not.toHaveAttribute("hidden");
    expect(screen.getByRole("heading", { name: "Release plan" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "docs" })).toBeInTheDocument();
    expect(document.querySelector(".plan-preview")).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".plan-preview")).toBeInTheDocument();
    expect(fullContent).toHaveAttribute("hidden");
    await user.click(toggle);
    expect(document.getElementById(contentId!)).toBe(fullContent);
  });

  it("opens the latest plan, preserves manual choices, and resets only for a new plan or session", async () => {
    const user = userEvent.setup();
    const plan = (ordinal: number): Message => ({
      kind: "message",
      id: `plan-${ordinal}`,
      ordinal,
      timestamp: null,
      role: "assistant",
      phase: "response",
      itemType: "Plan",
      markdown: `# Plan ${ordinal}`,
    });
    const timeline = (items: Message[], sessionId = SESSION_ID) => (
      <Timeline
        items={items}
        sessionId={sessionId}
        cursor={firstPage.cursor}
        hasMore={true}
        loading={false}
        paginationEnabled={false}
        onLoadMore={vi.fn()}
        onTimelineConflict={vi.fn()}
      />
    );
    const toggle = (ordinal: number) =>
      screen.getByRole("button", { name: new RegExp(`Assistant response · Plan · ${ordinal}`) });
    const view = render(timeline([plan(1), plan(2)]));
    expect(toggle(1)).toHaveAttribute("aria-expanded", "false");
    expect(toggle(2)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { name: "Plan 2" })).toBeVisible();
    const content = document.getElementById(toggle(2).getAttribute("aria-controls")!);
    await user.click(toggle(1));
    expect(toggle(1)).toHaveAttribute("aria-expanded", "true");
    expect(toggle(2)).toHaveAttribute("aria-expanded", "true");
    view.rerender(
      timeline([
        plan(1),
        { ...plan(2), markdown: "# Updated plan" },
        {
          ...plan(3),
          itemType: null,
        },
      ]),
    );
    expect(toggle(1)).toHaveAttribute("aria-expanded", "true");
    expect(toggle(2)).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle(2));
    view.rerender(timeline([plan(1), plan(2)]));
    expect(toggle(2)).toHaveAttribute("aria-expanded", "false");
    expect(content).toHaveAttribute("hidden");
    view.rerender(timeline([plan(1), plan(2), plan(3)]));
    expect(toggle(1)).toHaveAttribute("aria-expanded", "false");
    expect(toggle(2)).toHaveAttribute("aria-expanded", "false");
    expect(toggle(3)).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle(2).getAttribute("aria-controls")!)).toBe(content);
    expect(content).toHaveAttribute("hidden");
    expect(screen.getByRole("heading", { name: "Plan 3" })).toBeVisible();
    await user.click(toggle(1));
    await user.click(toggle(3));
    view.rerender(timeline([plan(1), plan(2), plan(3)], "another-session"));
    expect(toggle(1)).toHaveAttribute("aria-expanded", "false");
    expect(toggle(3)).toHaveAttribute("aria-expanded", "true");
  });

  it("bounds plan previews by Unicode code points and limits parsed source", () => {
    expect(planPreview("😀".repeat(321))).toBe("😀".repeat(319) + "…");
    expect(Array.from(planPreview("界".repeat(2001)))).toHaveLength(320);
    expect(planPreview("[label](" + "x".repeat(2100) + ") SECRET")).not.toContain("SECRET");
    expect(planPreview("😀".repeat(320))).toBe("😀".repeat(320));
  });

  it("uses GFM rules for task lists, strikethrough, and tables in plan previews", () => {
    expect(
      planPreview(
        [
          "- [x] ~~Old step~~ Done",
          "",
          "| Status | Owner |",
          "| --- | --- |",
          "| Ready | Codex |",
        ].join("\n"),
      ),
    ).toBe(["Old step Done", "Status · Owner", "Ready · Codex"].join("\n"));
  });
});

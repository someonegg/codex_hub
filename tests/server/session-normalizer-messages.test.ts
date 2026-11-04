import { describe, expect, it } from "vitest";

import { normalizeRecords } from "./session-normalizer.fixtures.js";

describe("message and directive normalization", () => {
  it("keeps explicit metadata titles ahead of Markdown user headings", () => {
    const normalized = normalizeRecords(
      "metadata-title",
      [
        {
          ordinal: 1,
          value: {
            type: "event_msg",
            payload: { type: "user_message", message: "# Markdown title" },
          },
        },
      ],
      { title: "Metadata title" },
    );

    expect(normalized.session.title).toBe("Metadata title");
  });

  it("emits a completed UserMessage and uses it for the title", () => {
    const normalized = normalizeRecords("completed-user-message", [
      completedItem(1, {
        type: "UserMessage",
        content: [
          { type: "text", text: "First user line" },
          { type: "image", text: "NON_TEXT_MUST_NOT_RENDER" },
          { type: "text", text: "Second user paragraph" },
          { type: "Text", text: "WRONG_CASE_MUST_NOT_RENDER" },
        ],
      }),
    ]);

    expect(normalized.timeline).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "user",
        phase: null,
        itemType: null,
        markdown: "First user line\n\nSecond user paragraph",
      }),
    ]);
    expect(normalized.session).toEqual(
      expect.objectContaining({
        title: "First user line",
      }),
    );
    expect(JSON.stringify(normalized)).not.toContain("NON_TEXT_MUST_NOT_RENDER");
    expect(JSON.stringify(normalized)).not.toContain("WRONG_CASE_MUST_NOT_RENDER");
  });

  it.each([
    ["commentary", "update"],
    ["final", "response"],
    ["final_answer", "response"],
    [undefined, null],
  ] as const)("normalizes completed AgentMessage phase %s", (phase, expectedPhase) => {
    const normalized = normalizeRecords(`completed-agent-${phase ?? "missing"}`, [
      completedItem(1, {
        type: "AgentMessage",
        ...(phase === undefined ? {} : { phase }),
        content: [
          { type: "Text", text: "First assistant paragraph" },
          { type: "text", text: "WRONG_CASE_MUST_NOT_RENDER" },
          { type: "Text", text: "Second assistant paragraph" },
        ],
      }),
    ]);

    expect(normalized.timeline).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        phase: expectedPhase,
        itemType: null,
        markdown: "First assistant paragraph\n\nSecond assistant paragraph",
      }),
    ]);
    expect(JSON.stringify(normalized)).not.toContain("WRONG_CASE_MUST_NOT_RENDER");
  });

  it("keeps completed Plan text as a typed assistant final message", () => {
    const normalized = normalizeRecords("completed-item-session", [
      {
        ordinal: 1,
        value: {
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: { type: "Plan", text: "# Plan\n\n- First step" },
          },
        },
      },
    ]);

    expect(normalized.timeline).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        phase: "response",
        itemType: "plan",
        markdown: "# Plan\n\n- First step",
      }),
    ]);
  });
});

function completedItem(ordinal: number, item: Record<string, unknown>) {
  return {
    ordinal,
    value: {
      type: "event_msg",
      payload: { type: "item_completed", item },
    },
  };
}

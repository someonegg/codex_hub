import { describe, expect, it } from "vitest";

import { MAX_SESSION_TITLE_CHARS } from "../../src/server/domain/session-text.js";
import { normalizeDecoded, resolveIdentity } from "./session-normalizer.fixtures.js";
import {
  decodedRollout,
  normalizeFixture,
  normalizeRecords,
} from "./session-normalizer.fixtures.js";

describe("session identity and recovery", () => {
  it("bounds JSONL titles to the first non-empty line", () => {
    const longLine = "A JSONL title that should stay compact ".repeat(8);
    const normalized = normalizeRecords("long-title-session", [], {
      threadId: "long-title-session",
      title: ` \n\n ${longLine}\nIgnored title continuation`,
    });

    expect(normalized.session.title).toBe(longLine.trim().slice(0, MAX_SESSION_TITLE_CHARS));
    expect(normalized.session.title).toHaveLength(MAX_SESSION_TITLE_CHARS);
    expect(normalized.session.title).not.toContain("\n");
  });

  it("falls back to the first user message and record timestamps", () => {
    const decoded = decodedRollout("fallback-session", [
      {
        ordinal: 1,
        value: {
          timestamp: "2026-07-28T12:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Fallback title from user" }],
          },
        },
      },
      {
        ordinal: 2,
        value: {
          timestamp: "2026-07-28T12:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Fallback title from user",
          },
        },
      },
      {
        ordinal: 3,
        value: {
          timestamp: "2026-07-28T12:00:05.000Z",
          type: "event_msg",
          payload: { type: "token_count" },
        },
      },
    ]);
    const normalized = normalizeDecoded(decoded, resolveIdentity(decoded));

    expect(normalized.session).toEqual(
      expect.objectContaining({
        title: "Fallback title from user",
        createdAt: "2026-07-28T12:00:00.000Z",
        updatedAt: "2026-07-28T12:00:05.000Z",
      }),
    );
  });

  it("chooses filename-matching metadata when duplicate metadata records exist", async () => {
    const normalized = await normalizeFixture("rollout-2026-07-28T11-00-00-child-session.jsonl");
    expect(normalized.session.workingDirectory).toBe("/synthetic/child");
    expect(normalized.session.parentId).toBe("basic-session");
    expect(normalized.session.subagent).toEqual({
      taskName: "widget_review",
      nickname: "Sagan",
      role: "reviewer",
    });
  });

  it("extracts a parent thread ID from current nested thread-spawn metadata", () => {
    const decoded = decodedRollout("nested-child", [
      {
        ordinal: 1,
        value: {
          type: "session_meta",
          payload: {
            id: "nested-child",
            parent_thread_id: "",
            parent_id: 42,
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: "parent-session",
                  agent_path: "/root/nested-child",
                },
              },
            },
          },
        },
      },
    ]);

    expect(resolveIdentity(decoded)).toMatchObject({
      parentThreadId: "parent-session",
      subagent: { taskName: "nested-child" },
    });
  });
});

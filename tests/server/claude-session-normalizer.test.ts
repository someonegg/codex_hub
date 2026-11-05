import { describe, expect, it } from "vitest";

import {
  appendClaudeRecords,
  type ClaudeState,
  createClaudeState,
} from "../../src/server/adapters/claude/session-normalizer.js";

const id = "claude-session";
const append = (state: ClaudeState, ...rows: Record<string, unknown>[]) =>
  appendClaudeRecords(
    state,
    rows.map((value, index) => ({ ordinal: state.line + index + 1, value })),
  );
const message = (role: "user" | "assistant", content: unknown) => ({
  type: role,
  message: { role, content },
});
const ask = (question: string) =>
  message("assistant", [
    { type: "tool_use", name: "AskUserQuestion", id: "ask", input: { questions: [{ question }] } },
  ]);
const answer = (question: string) =>
  message("user", [
    { type: "tool_result", tool_use_id: "ask", content: { answers: { [question]: "Yes" } } },
  ]);

describe("Claude incremental allocation", () => {
  it.each([
    { type: "progress", cwd: "/ignored" },
    message("user", "<system-reminder>hidden</system-reminder>"),
    message("assistant", [{ type: "tool_use", name: "Read", id: "read", input: {} }]),
    message("user", [{ type: "tool_result", tool_use_id: "missing", content: "result" }]),
  ])("reuses collections for records without display items: %j", (row) => {
    const before = append(createClaudeState(id), message("user", "Hello"), ask("Continue?"));
    const after = append(before, row);
    expect(after.timeline).toBe(before.timeline);
    expect(after.questions).toBe(before.questions);
  });

  it("updates metadata and identity diagnostics while reusing collections", () => {
    const before = createClaudeState(id);
    const after = append(
      before,
      { type: "system", cwd: "/project", version: "1", timestamp: "2026-01-01T00:00:00Z" },
      { type: "custom-title", customTitle: "Title" },
      { type: "ai-title", aiTitle: "AI title" },
      { type: "system", sessionId: "conflicting" },
    );
    expect(after.timeline).toBe(before.timeline);
    expect(after.questions).toBe(before.questions);
    expect(after).toMatchObject({
      cwd: "/project",
      firstCwd: "/project",
      version: "1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      customTitle: "Title",
      aiTitle: "AI title",
      identityConflict: true,
    });
    expect(after.diagnostics).toHaveLength(1);
    expect(before.cwd).toBeNull();
  });

  it("copies the timeline only when emitting and preserves existing items", () => {
    const before = append(createClaudeState(id), message("user", "Hello"));
    const after = append(before, message("assistant", "World"));
    expect(after.timeline).not.toBe(before.timeline);
    expect(after.timeline[0]).toBe(before.timeline[0]);
    expect(before.timeline).toHaveLength(1);
    expect(after.timeline[1]).toMatchObject({ id: `${id}:1`, ordinal: 1, markdown: "World" });
    expect(after.questions).toBe(before.questions);
  });

  it("copies questions on insertion and consumption without changing old snapshots", () => {
    const empty = createClaudeState(id);
    const requested = append(empty, ask("Continue?"));
    const originalQuestions = requested.questions.get("ask");
    expect(requested.questions).not.toBe(empty.questions);
    expect(empty.questions.size).toBe(0);
    const answered = append(requested, answer("Continue?"));
    expect(answered.questions).not.toBe(requested.questions);
    expect(answered.questions.size).toBe(0);
    expect(requested.questions.get("ask")).toBe(originalQuestions);
    expect(answered.timeline[1]).toMatchObject({ outcome: "answered" });
  });

  it("uses the latest duplicate call ID and consumes questions within the same batch", () => {
    const before = append(createClaudeState(id), ask("Old?"));
    const rows = [ask("First?"), ask("Latest?"), answer("Latest?"), answer("Latest?")];
    const full = append(before, ...rows);
    expect(full.questions.size).toBe(0);
    expect(before.questions.get("ask")?.[0]?.question).toBe("Old?");
    expect(full.timeline).toHaveLength(4);
    expect(full.timeline[3]).toMatchObject({
      outcome: "answered",
      answers: [{ questionId: "ask:0", answers: ["Yes"] }],
    });
    expect(full.timeline.map(({ id: itemId, ordinal }) => [itemId, ordinal])).toEqual(
      full.timeline.map((_, index) => [`${id}:${index}`, index]),
    );
    for (let split = 0; split <= rows.length; split++) {
      const partial = append(before, ...rows.slice(0, split));
      const snapshot = [...partial.questions];
      expect(append(partial, ...rows.slice(split))).toEqual(full);
      expect([...partial.questions]).toEqual(snapshot);
    }
  });
});

import { execFileSync } from "node:child_process";

import { expect, it } from "vitest";

import {
  appendClaudeRecords,
  createClaudeState,
} from "../../src/server/adapters/claude/session-normalizer.js";
import {
  codexBindingAttemptsFrom,
  codexBindingCommand,
} from "../../src/server/adapters/codex/interaction-parser.js";

it("round trips quoted task names without shell evaluation", () => {
  const task = "跨项目 'quoted' $(printf unsafe) `command`";
  const command = codexBindingCommand(undefined, "/project", task).slice(2);
  const output = execFileSync("bash", ["-c", command], {
    encoding: "utf8",
    env: {
      ...process.env,
      TMUX: "/tmp/task-test-socket,123,0",
      AHUB_TMUX_SESSION_NAME: "ahub-00000000-0000-0000-0000-000000000007",
    },
  });
  expect(bindingAttempts(output)).toEqual([
    {
      ordinal: 1,
      valid: true,
      socketPath: "/tmp/task-test-socket",
      sessionName: "ahub-00000000-0000-0000-0000-000000000007",
      projectDirectory: "/project",
      taskName: task,
    },
  ]);
});

it.each(["not-json", "42", JSON.stringify(""), JSON.stringify("a>b")])(
  "ignores an empty or invalid task field without invalidating the binding: %s",
  (task) => {
    const output = `AHUB_TMUX_BIND_V3\n/tmp/socket\nahub-00000000-0000-0000-0000-000000000007\n\n/project\n${task}\n`;
    expect(bindingAttempts(output, 9)).toEqual([
      {
        ordinal: 9,
        valid: true,
        socketPath: "/tmp/socket",
        sessionName: "ahub-00000000-0000-0000-0000-000000000007",
        projectDirectory: "/project",
      },
    ]);
  },
);

function bindingAttempts(output: string, ordinal = 1) {
  return codexBindingAttemptsFrom({
    ordinal,
    value: {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `<user_shell_command>\n${output}</user_shell_command>`,
          },
        ],
      },
    },
  });
}

it("rejects shell output delimiters before generating commands", () => {
  expect(() =>
    codexBindingCommand(undefined, "/project", "Fix </user_shell_command> parsing"),
  ).toThrow("Task name");
});

it.each(["null", '""', '"  "', "not-json", "42", JSON.stringify("a>b")])(
  "preserves Claude task/project metadata for invalid or empty updates: %s",
  (task) => {
    const initial = createClaudeState("session");
    const first = appendClaudeRecords(initial, [
      claudeBindingRecord(1, "/first", JSON.stringify("first")),
    ]);
    const second = appendClaudeRecords(first, [claudeBindingRecord(2, "relative", task)]);
    expect(second).toMatchObject({ project: "/first", taskName: "first" });
    expect(first).toMatchObject({ project: "/first", taskName: "first" });
  },
);

function claudeBindingRecord(ordinal: number, project: string, task: string, marker = "V3") {
  return {
    ordinal,
    value: {
      type: "user",
      message: {
        role: "user",
        content: `<bash-stdout>AHUB_TMUX_BIND_${marker}\n/tmp/socket\nahub-00000000-0000-0000-0000-000000000007\n\n${project}\n${task}\n</bash-stdout>`,
      },
    },
  };
}

it("ignores unknown Claude protocol versions while preserving prior metadata", () => {
  const first = appendClaudeRecords(createClaudeState("session"), [
    claudeBindingRecord(1, "/first", JSON.stringify("first")),
  ]);
  const legacy = appendClaudeRecords(first, [claudeBindingRecord(2, "/legacy", "", "V1")]);
  expect(legacy).toMatchObject({ project: "/first", taskName: "first" });
  expect(first).toMatchObject({ project: "/first", taskName: "first" });
});

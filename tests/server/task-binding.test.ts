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
  const command = codexBindingCommand(undefined, "/project", task)
    .slice(2)
    .replace("$(tmux display-message -p '#{socket_path}')", "/tmp/task-test-socket")
    .replace("$TMUX_PANE", "%7");
  const output = execFileSync("bash", ["-c", command], { encoding: "utf8" });
  expect(bindingAttempts(output)).toEqual([
    {
      ordinal: 1,
      valid: true,
      socketPath: "/tmp/task-test-socket",
      paneId: "%7",
      projectDirectory: "/project",
      taskName: task,
    },
  ]);
});

it.each(["not-json", "42", JSON.stringify(""), JSON.stringify("a>b")])(
  "ignores an empty or invalid task field without invalidating the binding: %s",
  (task) => {
    const output = `AHUB_TMUX_BIND_V2\n/tmp/socket\n%7\n\n/project\n${task}\n`;
    expect(bindingAttempts(output, 9)).toEqual([
      {
        ordinal: 9,
        valid: true,
        socketPath: "/tmp/socket",
        paneId: "%7",
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
    const row = (ordinal: number, project: string, task: string, marker = "V2") => ({
      ordinal,
      value: {
        type: "user",
        message: {
          role: "user",
          content: `<bash-stdout>AHUB_TMUX_BIND_${marker}\n/tmp/socket\n%7\n\n${project}\n${task}\n</bash-stdout>`,
        },
      },
    });
    const first = appendClaudeRecords(initial, [row(1, "/first", JSON.stringify("first"))]);
    const second = appendClaudeRecords(first, [row(2, "relative", task)]);
    expect(second).toMatchObject({ project: "/first", taskName: "first" });
    const legacy = appendClaudeRecords(second, [row(3, "/legacy", "", "V1")]);
    expect(legacy).toMatchObject({ project: "/legacy", taskName: "first" });
    expect(first).toMatchObject({ project: "/first", taskName: "first" });
  },
);

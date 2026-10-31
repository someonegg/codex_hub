import { execFileSync } from "node:child_process";

import { expect, it } from "vitest";

import {
  codexBindingAttemptsFrom,
  codexBindingCommand,
} from "../../src/server/adapters/codex/interaction-parser.js";

it.each([null, "跨项目 'quoted' $(printf unsafe) `command`"])(
  "round trips task binding without shell evaluation: %s",
  (task) => {
    const command = codexBindingCommand(undefined, "/project", task)
      .slice(2)
      .replace("$(tmux display-message -p '#{socket_path}')", "/tmp/task-test-socket")
      .replace("$TMUX_PANE", "%7");
    const output = execFileSync("bash", ["-c", command], { encoding: "utf8" });
    const attempts = bindingAttempts(output);
    expect(attempts[0]).toMatchObject({
      valid: true,
      taskName: task,
      projectDirectory: "/project",
    });
  },
);

it.each(["", "not-json", "42", JSON.stringify("a>b")])(
  "invalidates a malformed V2 task binding: %s",
  (task) => {
    const output = `AHUB_TMUX_BIND_V2\n/tmp/socket\n%7\n\n/project\n${task}\n`;
    expect(bindingAttempts(output, 9)).toEqual([{ ordinal: 9, valid: false }]);
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

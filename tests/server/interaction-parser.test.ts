import { expect, it } from "vitest";

import {
  codexBindingAttemptsFrom,
  codexBindingCommand,
  codexInterruptSteps,
} from "../../src/server/adapters/codex/interaction-parser.js";
const operationId = "00000000-0000-4000-8000-000000000001";

function response(ordinal: number, payload: Record<string, unknown>) {
  return {
    ordinal,
    value: {
      type: "response_item",
      timestamp: `2026-08-01T00:00:${String(ordinal).padStart(2, "0")}.000Z`,
      payload,
    },
  };
}

function shellText(tmux: string, pane: string) {
  return `<user_shell_command>\nChunk ID: bind\nProcess exited with code 0\nFinal output:\nAHUB_TMUX_BIND_V1\n${tmux}\n${pane}\n${operationId}\n\n</user_shell_command>`;
}

it("ignores inherited bindings, including invalid attempts", () => {
  for (const socket of ["/tmp/tmux.sock", "invalid"]) {
    const record = response(1, {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: shellText(socket, "%7") }],
    });
    expect(
      codexBindingAttemptsFrom({
        ...record,
        value: { ...record.value, metadata: { inherited_user_message: true } },
      }),
    ).toEqual([]);
  }
});

it("parses bindings only from user shell output", () => {
  const text = shellText("/tmp/tmux.sock", "%7");
  expect(
    codexBindingAttemptsFrom(
      response(1, { type: "message", role: "assistant", content: [{ type: "text", text }] }),
    ),
  ).toEqual([]);
  expect(
    codexBindingAttemptsFrom(response(2, { type: "custom_tool_call_output", output: text })),
  ).toEqual([]);
  const userRecord = response(3, {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });
  expect(
    codexBindingAttemptsFrom({
      ...userRecord,
      value: { ...userRecord.value, metadata: { inherited_user_message: false } },
    }),
  ).toEqual([{ ordinal: 3, valid: true, socketPath: "/tmp/tmux.sock", paneId: "%7", operationId }]);
});

it("rejects a UUID-length operation ID without hexadecimal digits", () => {
  const id = "------------------------------------";
  expect(
    codexBindingAttemptsFrom(
      response(1, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: shellText("/tmp/a", "%1").replace(operationId, id) }],
      }),
    ),
  ).toEqual([{ ordinal: 1, valid: false }]);
});

it("accepts manual bindings with spaces and commas in the socket path", () => {
  const text = `<user_shell_command>\nAHUB_TMUX_BIND_V1\n/tmp/a space,comma.sock\n%42\n\n\n</user_shell_command>`;
  expect(
    codexBindingAttemptsFrom(
      response(1, { type: "message", role: "user", content: [{ type: "input_text", text }] }),
    ),
  ).toEqual([{ ordinal: 1, valid: true, socketPath: "/tmp/a space,comma.sock", paneId: "%42" }]);
});

it.each([
  ["relative/socket", "%1"],
  ["", "%1"],
  ["/tmp/a", "1"],
  ["/tmp/a", "%a"],
])("rejects invalid target %s %s", (socket, pane) => {
  expect(
    codexBindingAttemptsFrom(
      response(1, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: shellText(socket!, pane!) }],
      }),
    ),
  ).toEqual([{ ordinal: 1, valid: false }]);
});

it("reports a damaged shell wrapper as an invalid attempt", () => {
  expect(
    codexBindingAttemptsFrom(
      response(1, {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<user_shell_command>\nAHUB_TMUX_BIND_V1\n/tmp/new.sock\n%2",
          },
        ],
      }),
    ),
  ).toEqual([{ ordinal: 1, valid: false }]);
});

it("generates a basic binding command while retaining creation operation IDs", () => {
  const basic = codexBindingCommand();
  expect(basic).toContain("AHUB_TMUX_BIND_V1");
  expect(basic).toContain("#{socket_path}");
  expect(basic).toContain("$TMUX_PANE");
  expect(codexBindingCommand(operationId)).toContain(operationId);
  expect(basic).not.toContain(operationId);
  expect(() => codexBindingCommand("invalid")).toThrow("Invalid operation ID");
});

it("returns every bind including multiple binds within one record and shell block", () => {
  const text =
    shellText("/tmp/shared.sock", "%1").replace(
      "</user_shell_command>",
      `AHUB_TMUX_BIND_V1\n/tmp/shared.sock\n%2\n${operationId}\n\n</user_shell_command>`,
    ) + shellText("bad", "%3");
  expect(
    codexBindingAttemptsFrom(
      response(1, { type: "message", role: "user", content: [{ type: "input_text", text }] }),
    ),
  ).toEqual([
    { valid: true, ordinal: 1, socketPath: "/tmp/shared.sock", paneId: "%1", operationId },
    { valid: true, ordinal: 1, socketPath: "/tmp/shared.sock", paneId: "%2", operationId },
    { valid: false, ordinal: 1 },
  ]);
});

it("ignores an invalid project without invalidating the pane", () => {
  const text = `<user_shell_command>\nAHUB_TMUX_BIND_V1\n/tmp/socket\n%1\n\nrelative\n</user_shell_command>`;
  expect(
    codexBindingAttemptsFrom(
      response(1, { type: "message", role: "user", content: [{ type: "input_text", text }] }),
    ),
  ).toEqual([{ ordinal: 1, valid: true, socketPath: "/tmp/socket", paneId: "%1" }]);
});

it.each(["\n", "\r\n"])("normalizes V1 project line endings %j", (eol) => {
  const text = [
    "<user_shell_command>",
    "AHUB_TMUX_BIND_V1",
    "/tmp/socket",
    "%1",
    "",
    "/project",
    "</user_shell_command>",
  ].join(eol);
  expect(
    codexBindingAttemptsFrom(
      response(1, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      }),
    ),
  ).toEqual([
    {
      ordinal: 1,
      valid: true,
      socketPath: "/tmp/socket",
      paneId: "%1",
      projectDirectory: "/project",
    },
  ]);
});

it("interrupts with Ctrl+U then Escape after the configured delay", () => {
  expect(codexInterruptSteps()).toEqual([
    { keys: ["C-u"], delayMs: 0 },
    { keys: ["Escape"], delayMs: 100 },
  ]);
});

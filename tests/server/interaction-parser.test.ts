import { expect, it } from "vitest";

import {
  CODEX_INTERACTION_KEY_BINDINGS,
  codexBindingAttemptsFrom,
  codexBindingCommand,
  codexInteraction,
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
  return `<user_shell_command>\nChunk ID: bind\nProcess exited with code 0\nFinal output:\nCODEX_HUB_TMUX_BIND_V3\n${tmux}\n${pane}\n${operationId}\n</user_shell_command>`;
}

it.each(["CODEX_HUB_TMUX_BIND_V3", "CODEX_HUB_TMUX_BIND_V4"])(
  "ignores inherited %s bindings, including invalid attempts",
  (version) => {
    for (const socket of ["/tmp/tmux.sock", "invalid"]) {
      const record = response(1, {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: shellText(socket, "%7").replace("CODEX_HUB_TMUX_BIND_V3", version),
          },
        ],
      });
      expect(
        codexBindingAttemptsFrom({
          ...record,
          value: { ...record.value, metadata: { inherited_user_message: true } },
        }),
      ).toEqual([]);
    }
  },
);

it.each([
  undefined,
  null,
  {},
  { inherited_user_message: false },
  { inherited_user_message: "true" },
])("preserves bindings without an explicit inherited flag: %j", (metadata) => {
  const record = response(1, {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: shellText("/tmp/tmux.sock", "%7") }],
  });
  expect(codexBindingAttemptsFrom({ ...record, value: { ...record.value, metadata } })).toEqual([
    { ordinal: 1, valid: true, socketPath: "/tmp/tmux.sock", paneId: "%7", operationId },
  ]);
});

it("parses only user shell output and keeps binding outside normalized interaction", () => {
  const text = shellText("/tmp/tmux.sock", "%7");
  expect(
    codexBindingAttemptsFrom(
      response(1, { type: "message", role: "assistant", content: [{ type: "text", text }] }),
    ),
  ).toEqual([]);
  expect(
    codexBindingAttemptsFrom(response(2, { type: "custom_tool_call_output", output: text })),
  ).toEqual([]);
  expect(
    codexBindingAttemptsFrom(
      response(3, { type: "message", role: "user", content: [{ type: "input_text", text }] }),
    ),
  ).toEqual([{ ordinal: 3, valid: true, socketPath: "/tmp/tmux.sock", paneId: "%7", operationId }]);
  expect(codexInteraction()).toEqual({
    transport: "tmux",
    bindingCommand: codexBindingCommand(),
    keyBindings: CODEX_INTERACTION_KEY_BINDINGS,
    interruptSteps: codexInterruptSteps,
  });
});

it.each(["invalid", "------------------------------------"])(
  "rejects invalid operation ID %s",
  (id) => {
    expect(
      codexBindingAttemptsFrom(
        response(1, {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: shellText("/tmp/a", "%1").replace(operationId, id) },
          ],
        }),
      ),
    ).toEqual([{ ordinal: 1, valid: false }]);
  },
);

it.each([undefined, operationId])(
  "accepts manual and created bindings with spaces and commas",
  (id) => {
    const text = `<user_shell_command>\nCODEX_HUB_TMUX_BIND_V3\n/tmp/a space,comma.sock\n%42${id ? `\n${id}` : ""}\n</user_shell_command>`;
    expect(
      codexBindingAttemptsFrom(
        response(1, { type: "message", role: "user", content: [{ type: "input_text", text }] }),
      ),
    ).toEqual([
      {
        ordinal: 1,
        valid: true,
        socketPath: "/tmp/a space,comma.sock",
        paneId: "%42",
        ...(id ? { operationId: id } : {}),
      },
    ]);
  },
);

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
            text: "<user_shell_command>\nCODEX_HUB_TMUX_BIND_V3\n/tmp/new.sock\n%2",
          },
        ],
      }),
    ),
  ).toEqual([{ ordinal: 1, valid: false }]);
});

it("generates a basic binding command while retaining creation operation IDs", () => {
  const basic = codexBindingCommand();
  expect(basic).toContain("CODEX_HUB_TMUX_BIND_V4");
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
      `CODEX_HUB_TMUX_BIND_V3\n/tmp/shared.sock\n%2\n${operationId}\n</user_shell_command>`,
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

it.each([undefined, "", "relative", "/bad\0path", "/bad\rpath"])(
  "ignores invalid V4 project %j without invalidating the pane",
  (project) => {
    const text = `<user_shell_command>\nCODEX_HUB_TMUX_BIND_V4\n/tmp/socket\n%1\n\n${project ?? ""}\n</user_shell_command>`;
    expect(
      codexBindingAttemptsFrom(
        response(1, { type: "message", role: "user", content: [{ type: "input_text", text }] }),
      ),
    ).toEqual([{ ordinal: 1, valid: true, socketPath: "/tmp/socket", paneId: "%1" }]);
  },
);

it.each(["\n", "\r\n"])("normalizes V4 project line endings %j", (eol) => {
  const text = [
    "<user_shell_command>",
    "CODEX_HUB_TMUX_BIND_V4",
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

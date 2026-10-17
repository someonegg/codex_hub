import { describe, expect, it } from "vitest";

import {
  CODEX_INTERACTION_KEY_BINDINGS,
  codexBindingCommand,
} from "../../src/server/adapters/codex/interaction-parser.js";
import { normalizeRecords } from "./session-normalizer.fixtures.js";

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

describe("Codex interaction adapter", () => {
  it("recognizes a binding only in a user response_item shell command", () => {
    const normalized = normalizeRecords("binding", [
      response(1, {
        type: "custom_tool_call_output",
        call_id: "tool",
        output: "CODEX_HUB_TMUX_BIND_V3\n/tmp/wrong\n%1",
      }),
      {
        ordinal: 2,
        value: {
          type: "event_msg",
          payload: { type: "user_message", message: shellText("/tmp/also-wrong", "%2") },
        },
      },
      response(3, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: shellText("/tmp/tmux.sock", "%7") }],
      }),
    ]);

    expect(normalized.interaction).toEqual({
      bindingAttempt: {
        ordinal: 3,
        valid: true,
        socketPath: "/tmp/tmux.sock",
        paneId: "%7",
        operationId,
      },
      transport: "tmux",
      rebindCommand: codexBindingCommand(),
      keyBindings: CODEX_INTERACTION_KEY_BINDINGS,
    });
  });

  it("uses only the latest binding attempt and does not fall back", () => {
    const normalized = normalizeRecords("latest-binding", [
      response(1, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: shellText("/tmp/valid.sock", "%1") }],
      }),
      response(8, {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: shellText("malformed", "pane-8"),
          },
        ],
      }),
    ]);

    expect(normalized.interaction?.bindingAttempt).toEqual({ ordinal: 8, valid: false });
  });

  it("treats a damaged latest shell-command wrapper as a failed attempt", () => {
    const normalized = normalizeRecords("damaged-binding", [
      response(1, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: shellText("/tmp/valid.sock", "%1") }],
      }),
      response(9, {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<user_shell_command>\nCODEX_HUB_TMUX_BIND_V3\n/tmp/new.sock\n%2",
          },
        ],
      }),
    ]);
    expect(normalized.interaction?.bindingAttempt).toEqual({ ordinal: 9, valid: false });
  });
});

it("recognizes operation IDs in V3 binding output with a valid UUID", () => {
  const operationId = "00000000-0000-4000-8000-000000000001";
  const normalized = normalizeRecords("operation-binding", [
    response(1, {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `<user_shell_command>\nCODEX_HUB_TMUX_BIND_V3\n/tmp/with spaces.sock\n%2\n${operationId}\n</user_shell_command>`,
        },
      ],
    }),
  ]);
  expect(normalized.interaction?.bindingAttempt).toEqual({
    ordinal: 1,
    valid: true,
    socketPath: "/tmp/with spaces.sock",
    paneId: "%2",
    operationId,
  });
});
it("does not fall back to an older binding after an incomplete V3 record", () => {
  const normalized = normalizeRecords("incomplete-operation", [
    response(1, {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: shellText("/tmp/old.sock", "%1") }],
    }),
    response(2, {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "<user_shell_command>\nCODEX_HUB_TMUX_BIND_V3\n/tmp/new.sock\n%2",
        },
      ],
    }),
  ]);
  expect(normalized.interaction?.bindingAttempt).toEqual({ ordinal: 2, valid: false });
});

it.each(["invalid", "------------------------------------"])(
  "rejects invalid operation ID %s",
  (id) => {
    const result = normalizeRecords("invalid", [
      response(1, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: shellText("/tmp/a", "%1").replace(operationId, id) }],
      }),
    ]);
    expect(result.interaction?.bindingAttempt).toEqual({ ordinal: 1, valid: false });
  },
);

it.each([undefined, "00000000-0000-4000-8000-000000000001"])(
  "accepts manual and created V3 bindings with spaces and commas",
  (id) => {
    const text = `<user_shell_command>\nCODEX_HUB_TMUX_BIND_V3\n/tmp/a space,comma.sock\n%42${id ? `\n${id}` : ""}\n</user_shell_command>`;
    const parsed = normalizeRecords("manual", [
      response(1, { type: "message", role: "user", content: [{ type: "input_text", text }] }),
    ]);
    expect(parsed.interaction?.bindingAttempt).toEqual({
      ordinal: 1,
      valid: true,
      socketPath: "/tmp/a space,comma.sock",
      paneId: "%42",
      ...(id ? { operationId: id } : {}),
    });
  },
);
it.each([
  ["relative/socket", "%1"],
  ["", "%1"],
  ["/tmp/a", "1"],
  ["/tmp/a", "%a"],
])("rejects invalid V3 target %s %s", (socket, pane) => {
  const parsed = normalizeRecords("invalid", [
    response(1, {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: shellText(socket!, pane!) }],
    }),
  ]);
  expect(parsed.interaction?.bindingAttempt).toEqual({ ordinal: 1, valid: false });
});

it("generates a basic binding command while retaining creation operation IDs", () => {
  const basic = codexBindingCommand();
  expect(basic).toContain("CODEX_HUB_TMUX_BIND_V3");
  expect(basic).toContain("#{socket_path}");
  expect(basic).toContain("$TMUX_PANE");
  expect(codexBindingCommand(operationId)).toContain(operationId);
  expect(basic).not.toContain(operationId);
  expect(() => codexBindingCommand("invalid")).toThrow("Invalid operation ID");
});

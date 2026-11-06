import { expect, it } from "vitest";

import {
  codexBindingAttemptsFrom,
  codexBindingCommand,
  codexInteraction,
} from "../../src/server/adapters/codex/interaction-parser.js";
import { interruptSteps } from "../../src/server/adapters/shared/session-management.js";
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
  return `<user_shell_command>\nChunk ID: bind\nProcess exited with code 0\nFinal output:\nAHUB_TMUX_BIND_V3\n${tmux}\n${pane}\n${operationId}\n\n</user_shell_command>`;
}

it("ignores inherited bindings, including invalid attempts", () => {
  for (const socket of ["/tmp/tmux.sock", "invalid"]) {
    const record = response(1, {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: shellText(socket, "ahub-00000000-0000-0000-0000-000000000007"),
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
});

it("parses bindings only from user shell output", () => {
  const text = shellText("/tmp/tmux.sock", "ahub-00000000-0000-0000-0000-000000000007");
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
  ).toEqual([
    {
      ordinal: 3,
      valid: true,
      socketPath: "/tmp/tmux.sock",
      sessionName: "ahub-00000000-0000-0000-0000-000000000007",
      operationId,
    },
  ]);
});

it("rejects a UUID-length operation ID without hexadecimal digits", () => {
  const id = "------------------------------------";
  expect(
    codexBindingAttemptsFrom(
      response(1, {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: shellText("/tmp/a", "ahub-00000000-0000-0000-0000-000000000001").replace(
              operationId,
              id,
            ),
          },
        ],
      }),
    ),
  ).toEqual([{ ordinal: 1, valid: false }]);
});

it("accepts manual bindings with spaces and commas in the socket path", () => {
  const text = `<user_shell_command>\nAHUB_TMUX_BIND_V3\n/tmp/a space,comma.sock\nahub-00000000-0000-0000-0000-000000000042\n\n\n</user_shell_command>`;
  expect(
    codexBindingAttemptsFrom(
      response(1, { type: "message", role: "user", content: [{ type: "input_text", text }] }),
    ),
  ).toEqual([
    {
      ordinal: 1,
      valid: true,
      socketPath: "/tmp/a space,comma.sock",
      sessionName: "ahub-00000000-0000-0000-0000-000000000042",
    },
  ]);
});

it.each([
  ["relative/socket", "ahub-00000000-0000-0000-0000-000000000001"],
  ["", "ahub-00000000-0000-0000-0000-000000000001"],
  ["/tmp/a", "1"],
  ["/tmp/a", "%a"],
  ["/tmp/a", "arbitrary-session"],
  ["/tmp/a", "AHUB-00000000-0000-0000-0000-000000000001"],
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
            text: "<user_shell_command>\nAHUB_TMUX_BIND_V3\n/tmp/new.sock\nahub-00000000-0000-0000-0000-000000000002",
          },
        ],
      }),
    ),
  ).toEqual([{ ordinal: 1, valid: false }]);
});

it("generates a basic binding command while retaining creation operation IDs", () => {
  const basic = codexBindingCommand();
  expect(basic).toContain("AHUB_TMUX_BIND_V3");
  expect(basic).toContain("${TMUX%%,*}");
  expect(basic).toContain("$AHUB_TMUX_SESSION_NAME");
  expect(basic).not.toContain("$(");
  expect(codexBindingCommand(operationId)).toContain(operationId);
  expect(basic).not.toContain(operationId);
  expect(() => codexBindingCommand("invalid")).toThrow("Invalid operation ID");
});

it("returns every bind including multiple binds within one record and shell block", () => {
  const text =
    shellText("/tmp/shared.sock", "ahub-00000000-0000-0000-0000-000000000001").replace(
      "</user_shell_command>",
      `AHUB_TMUX_BIND_V3\n/tmp/shared.sock\nahub-00000000-0000-0000-0000-000000000002\n${operationId}\n\n</user_shell_command>`,
    ) + shellText("bad", "ahub-00000000-0000-0000-0000-000000000003");
  expect(
    codexBindingAttemptsFrom(
      response(1, { type: "message", role: "user", content: [{ type: "input_text", text }] }),
    ),
  ).toEqual([
    {
      valid: true,
      ordinal: 1,
      socketPath: "/tmp/shared.sock",
      sessionName: "ahub-00000000-0000-0000-0000-000000000001",
      operationId,
    },
    {
      valid: true,
      ordinal: 1,
      socketPath: "/tmp/shared.sock",
      sessionName: "ahub-00000000-0000-0000-0000-000000000002",
      operationId,
    },
    { valid: false, ordinal: 1 },
  ]);
});

it("ignores an invalid project without invalidating the pane", () => {
  const text = `<user_shell_command>\nAHUB_TMUX_BIND_V3\n/tmp/socket\nahub-00000000-0000-0000-0000-000000000001\n\nrelative\n</user_shell_command>`;
  expect(
    codexBindingAttemptsFrom(
      response(1, { type: "message", role: "user", content: [{ type: "input_text", text }] }),
    ),
  ).toEqual([
    {
      ordinal: 1,
      valid: true,
      socketPath: "/tmp/socket",
      sessionName: "ahub-00000000-0000-0000-0000-000000000001",
    },
  ]);
});

it.each(["\n", "\r\n"])("normalizes V3 project line endings %j", (eol) => {
  const text = [
    "<user_shell_command>",
    "AHUB_TMUX_BIND_V3",
    "/tmp/socket",
    "ahub-00000000-0000-0000-0000-000000000001",
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
      sessionName: "ahub-00000000-0000-0000-0000-000000000001",
      projectDirectory: "/project",
    },
  ]);
});

it("provides the shared interrupt capability", () => {
  expect(codexInteraction().interruptSteps).toBe(interruptSteps);
});

it("ignores quoted shell wrappers in ordinary user prose", () => {
  const text =
    "Please explain this example:\n" +
    shellText("/tmp/socket", "ahub-00000000-0000-0000-0000-000000000007");
  expect(
    codexBindingAttemptsFrom(
      response(1, { type: "message", role: "user", content: [{ type: "input_text", text }] }),
    ),
  ).toEqual([]);
});

it.each(["V1", "UNKNOWN"])("ignores unknown protocol marker %s", (version) => {
  const text = shellText("/tmp/socket", "ahub-00000000-0000-0000-0000-000000000001").replace(
    "BIND_V3",
    `BIND_${version}`,
  );
  expect(
    codexBindingAttemptsFrom(
      response(1, { type: "message", role: "user", content: [{ type: "input_text", text }] }),
    ),
  ).toEqual([]);
  expect(
    codexBindingAttemptsFrom(
      response(2, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: text.replace("</user_shell_command>", "") }],
      }),
    ),
  ).toEqual([]);
});

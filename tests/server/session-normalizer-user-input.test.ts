import { describe, expect, it } from "vitest";

import { normalizeRecords } from "./session-normalizer.fixtures.js";

const QUESTIONS = {
  questions: [
    {
      header: "Choice",
      id: "choice",
      question: "Which option should be used?",
      options: [
        { label: "First", description: "Use the first approach." },
        { label: "Second", description: "Use the second approach." },
      ],
    },
  ],
};

describe("request_user_input normalization", () => {
  it("recognizes the Codex aborted output while retaining the request", () => {
    const normalized = normalizeRecords("user-input-aborted", [
      userInputRequest(1, "aborted", QUESTIONS),
      userInputOutput(2, "aborted", "aborted by user after 344.5s"),
    ]);

    expect(normalized.timeline[1]).toMatchObject({
      kind: "user_input",
      stage: "response",
      callId: "aborted",
      outcome: "aborted",
    });
  });

  it("retains malformed recognized records safely and reports diagnostics", () => {
    const normalized = normalizeRecords("user-input-invalid", [
      userInputRequest(1, "invalid", { questions: [] }),
      userInputOutput(2, "invalid", "unexpected response"),
    ]);

    expect(normalized.timeline[0]).toMatchObject({
      kind: "user_input",
      stage: "request",
      questions: [],
    });
    expect(normalized.timeline[1]).toMatchObject({
      kind: "user_input",
      stage: "response",
      outcome: "unavailable",
      summary: "unexpected response",
    });
    expect(normalized.session.diagnostics.map(({ code, ordinal }) => [code, ordinal])).toEqual([
      ["invalid_user_input", 1],
      ["invalid_user_input", 2],
    ]);
  });
});

function userInputRequest(ordinal: number, callId: string, argumentsValue: unknown) {
  return {
    ordinal,
    value: {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: callId,
        arguments: JSON.stringify(argumentsValue),
      },
    },
  };
}

function userInputOutput(ordinal: number, callId: string, output: string) {
  return {
    ordinal,
    value: {
      type: "response_item",
      payload: { type: "function_call_output", call_id: callId, output },
    },
  };
}

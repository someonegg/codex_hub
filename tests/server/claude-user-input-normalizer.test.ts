import { describe, expect, it } from "vitest";

import {
  normalizeQuestionResponse,
  normalizeQuestions,
} from "../../src/server/adapters/claude/user-input-normalizer.js";

describe("normalizeQuestions", () => {
  it("maps question entries with stable ids and defaults", () => {
    expect(
      normalizeQuestions("ask", [
        {
          question: "Proceed?",
          header: "Scope",
          options: [{ label: "Yes", description: "Apply now" }, { label: "No" }],
        },
      ]),
    ).toEqual([
      {
        id: "ask:0",
        header: "Scope",
        question: "Proceed?",
        options: [
          { label: "Yes", description: "Apply now" },
          { label: "No", description: "" },
        ],
      },
    ]);
  });

  it("skips non-object entries and entries without a string question", () => {
    expect(
      normalizeQuestions("ask", [
        null,
        42,
        "text",
        { question: 7 },
        { header: "No question" },
        { question: "Valid" },
      ]),
    ).toEqual([expect.objectContaining({ id: "ask:5", question: "Valid" })]);
  });

  it("keeps questions without usable options", () => {
    expect(
      normalizeQuestions("ask", [
        { question: "No options field" },
        { question: "Options not an array", options: "yes" },
        {
          question: "Only labeled options count",
          options: [
            { description: "missing label" },
            "plain",
            null,
            { label: "Kept", description: null },
          ],
        },
      ]),
    ).toEqual([
      { id: "ask:0", header: "", question: "No options field", options: [] },
      { id: "ask:1", header: "", question: "Options not an array", options: [] },
      {
        id: "ask:2",
        header: "",
        question: "Only labeled options count",
        options: [{ label: "Kept", description: "" }],
      },
    ]);
  });
});

describe("normalizeQuestionResponse", () => {
  const questions = normalizeQuestions("ask", [
    { question: "Color?", options: [{ label: "Red" }, { label: "Blue" }] },
    { question: "Size?", options: [{ label: "One" }, { label: "Two" }] },
  ]);
  const base = { kind: "user_input", stage: "response", callId: "ask", timestamp: "T" } as const;

  it("answers by question text and by generated question id", () => {
    const byText = normalizeQuestionResponse(
      "ask",
      questions,
      JSON.stringify({ answers: { "Color?": "Red", "Size?": ["One", "Two"] } }),
      null,
      "T",
    );
    expect(byText).toEqual({
      ...base,
      outcome: "answered",
      answers: [
        { questionId: "ask:0", answers: ["Red"] },
        { questionId: "ask:1", answers: ["One", "Two"] },
      ],
    });
    const byId = normalizeQuestionResponse(
      "ask",
      questions,
      JSON.stringify({ answers: { "ask:0": "Red", "ask:1": "Two" } }),
      null,
      "T",
    );
    expect(byId).toMatchObject({
      outcome: "answered",
      answers: [
        { questionId: "ask:0", answers: ["Red"] },
        { questionId: "ask:1", answers: ["Two"] },
      ],
    });
  });

  it("prefers the tool use result over parsed content", () => {
    const response = normalizeQuestionResponse(
      "ask",
      questions,
      JSON.stringify({ answers: { "Color?": "Red", "Size?": "One" } }),
      { answers: { "Color?": "Blue", "Size?": "Two" } },
      "T",
    );
    expect(response).toMatchObject({
      outcome: "answered",
      answers: [
        { questionId: "ask:0", answers: ["Blue"] },
        { questionId: "ask:1", answers: ["Two"] },
      ],
    });
  });

  it("reads structured answers from object content without JSON parsing", () => {
    const response = normalizeQuestionResponse(
      "ask",
      questions,
      { answers: { "Color?": "Red", "Size?": "One" } },
      null,
      "T",
    );
    expect(response).toMatchObject({ outcome: "answered" });
  });

  it.each([
    ["denied flag", { denied: true }],
    ["rejected flag", { rejected: true }],
  ])("reports aborted for the %s", (_label, toolUseResult) => {
    expect(normalizeQuestionResponse("ask", questions, {}, toolUseResult, "T")).toMatchObject({
      ...base,
      outcome: "aborted",
    });
  });

  it.each([
    "The user doesn't want to proceed. Ask what to do instead.",
    "User declined to answer",
    "Request interrupted by user",
  ])("reports aborted for the rejection text %s", (text) => {
    expect(normalizeQuestionResponse("ask", questions, text, null, "T")).toMatchObject({
      ...base,
      outcome: "aborted",
    });
  });

  it.each([
    ["non-array answers", { answers: "Red" }],
    ["mixed-type answer arrays", { answers: { "Color?": ["Red", 3], "Size?": "Two" } }],
    ["answers keyed by unknown questions", { answers: { Shape: "Round" } }],
    ["unparseable text content", "not JSON"],
  ])("reports unavailable for %s", (_label, content) => {
    expect(normalizeQuestionResponse("ask", questions, content, null, "T")).toMatchObject({
      ...base,
      outcome: "unavailable",
    });
  });

  it("reports unavailable when any question lacks an answer", () => {
    const response = normalizeQuestionResponse(
      "ask",
      questions,
      JSON.stringify({ answers: { "Color?": "Red" } }),
      null,
      "T",
    );
    expect(response).toMatchObject({ ...base, outcome: "unavailable" });
  });
});

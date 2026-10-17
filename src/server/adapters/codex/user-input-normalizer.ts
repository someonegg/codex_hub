import type {
  DomainUserInputAnswer,
  DomainUserInputQuestion,
  DomainUserInputRecord,
} from "../../domain/session-domain.js";
import { MAX_PREVIEW_CHARS, truncateText } from "../../domain/session-text.js";
import { isObject } from "./rollout-decoder.js";
import type { ToolOutput } from "./tool-normalizer.js";

export interface UserInputRequest {
  readonly callId: string;
  readonly ordinal: number;
  readonly timestamp: string | null;
  readonly questions: readonly DomainUserInputQuestion[];
  readonly malformed: boolean;
}

export interface NormalizedUserInput {
  readonly item: DomainUserInputRecord;
  readonly malformed: boolean;
}

export function normalizeUserInputRequest(request: UserInputRequest): NormalizedUserInput {
  return {
    item: {
      kind: "user_input",
      stage: "request",
      id: `user-input-${request.ordinal}`,
      ordinal: request.ordinal,
      timestamp: request.timestamp,
      callId: request.callId,
      questions: request.questions,
    },
    malformed: request.malformed,
  };
}

export function normalizeUserInputResponse(output: ToolOutput): NormalizedUserInput {
  const parsed = parseResponse(output.output);
  const base = {
    kind: "user_input" as const,
    stage: "response" as const,
    id: `user-input-${output.ordinal}`,
    ordinal: output.ordinal,
    timestamp: output.timestamp,
    callId: output.callId,
  };
  if (parsed.kind === "answered") {
    return {
      item: { ...base, outcome: "answered", answers: parsed.answers },
      malformed: false,
    };
  }
  if (parsed.kind === "aborted") {
    return {
      item: { ...base, outcome: "aborted" },
      malformed: false,
    };
  }
  return {
    item: {
      ...base,
      outcome: "unavailable",
      summary: truncateText(
        output.output ?? "User input response was unavailable.",
        MAX_PREVIEW_CHARS,
      ).text,
    },
    malformed: true,
  };
}

export function parseUserInputQuestions(value: unknown): readonly DomainUserInputQuestion[] | null {
  const object = parseObject(value);
  if (object === null || !Array.isArray(object.questions)) return null;
  if (object.questions.length < 1 || object.questions.length > 3) return null;
  const questions = object.questions.map(parseQuestion);
  if (!questions.every((question) => question !== null)) return null;
  const parsed = questions as DomainUserInputQuestion[];
  return new Set(parsed.map((question) => question.id)).size === parsed.length ? parsed : null;
}

function parseQuestion(value: unknown): DomainUserInputQuestion | null {
  if (!isObject(value) || !Array.isArray(value.options)) return null;
  if (value.options.length < 2 || value.options.length > 3) return null;
  const id = string(value.id);
  const header = string(value.header);
  const question = string(value.question);
  const options = value.options.map((option) => {
    if (!isObject(option)) return null;
    const label = string(option.label);
    const description = string(option.description);
    return label === null || description === null ? null : { label, description };
  });
  if (
    id === null ||
    header === null ||
    question === null ||
    !options.every((option) => option !== null)
  )
    return null;
  const parsedOptions = options as DomainUserInputQuestion["options"];
  if (new Set(parsedOptions.map((option) => option.label)).size !== parsedOptions.length) {
    return null;
  }
  return { id, header, question, options: parsedOptions };
}

function parseResponse(
  value: string | null,
):
  | { kind: "answered"; answers: readonly DomainUserInputAnswer[] }
  | { kind: "aborted" }
  | { kind: "unavailable" } {
  if (value === null) return { kind: "unavailable" };
  if (value.trim().toLocaleLowerCase("en-US").startsWith("aborted by user")) {
    return { kind: "aborted" };
  }
  const object = parseObject(value);
  if (object === null || !isObject(object.answers)) return { kind: "unavailable" };
  const answers: DomainUserInputAnswer[] = [];
  for (const [questionId, rawAnswer] of Object.entries(object.answers)) {
    if (!isObject(rawAnswer) || !Array.isArray(rawAnswer.answers)) {
      return { kind: "unavailable" };
    }
    const values = rawAnswer.answers.filter(
      (answer): answer is string => typeof answer === "string",
    );
    if (values.length !== rawAnswer.answers.length) return { kind: "unavailable" };
    answers.push({ questionId, answers: values });
  }
  return { kind: "answered", answers };
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (isObject(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

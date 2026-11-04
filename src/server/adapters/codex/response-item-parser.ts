import { isObject } from "./rollout-decoder.js";
import { parseUserInputQuestions, type UserInputRequest } from "./user-input-normalizer.js";
import { nonEmptyString } from "./value-readers.js";

export interface ToolOutput {
  callId: string;
  ordinal: number;
  timestamp: string | null;
  output: string | null;
  failed: boolean;
}

export type ParsedResponseItem =
  | { readonly kind: "tool_output"; readonly value: ToolOutput }
  | { readonly kind: "user_input_request"; readonly value: UserInputRequest }
  | { readonly kind: "ignored" };

export function parseResponseItem(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): ParsedResponseItem {
  const userInput = userInputRequest(ordinal, timestamp, payload);
  if (userInput !== null) return { kind: "user_input_request", value: userInput };
  const output = toolOutput(ordinal, timestamp, payload);
  if (output !== null) return { kind: "tool_output", value: output };
  return { kind: "ignored" };
}

function userInputRequest(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): UserInputRequest | null {
  if (payload.type !== "function_call" || payload.name !== "request_user_input") return null;
  const callId = nonEmptyString(payload.call_id);
  if (callId === null) return null;
  const questions = parseUserInputQuestions(payload.arguments);
  return {
    callId,
    ordinal,
    timestamp,
    questions: questions ?? [],
    malformed: questions === null,
  };
}

function toolOutput(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): ToolOutput | null {
  const type = nonEmptyString(payload.type);
  if (type !== "function_call_output" && type !== "custom_tool_call_output") return null;
  const callId = nonEmptyString(payload.call_id);
  if (callId === null) return null;
  return {
    callId,
    ordinal,
    timestamp,
    output: toolOutputText(payload.output),
    failed: payload.success === false || payload.status === "failed",
  };
}

function serializeText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function toolOutputText(value: unknown): string | null {
  if (!Array.isArray(value)) return serializeText(value);
  const parts = value
    .filter(isObject)
    .map(
      (part) =>
        nonEmptyString(part.text) ?? nonEmptyString(part.output_text) ?? serializeText(part),
    )
    .filter((part): part is string => part !== null);
  return parts.length === 0 ? serializeText(value) : parts.join("\n\n");
}

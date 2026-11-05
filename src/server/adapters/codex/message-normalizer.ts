import type { DomainMessageRecord } from "../../domain/session-domain.js";
import { truncateText } from "../../domain/session-text.js";
import { isObject } from "../shared/jsonl-decoder.js";
import { MAX_MESSAGE_CHARS } from "./limits.js";
import { nonEmptyString } from "./value-readers.js";

export function eventMessage(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): DomainMessageRecord | null {
  const type = nonEmptyString(payload.type);
  if (type === "user_message" || type === "agent_message") {
    const markdown = nonEmptyString(payload.message);
    if (markdown === null) return null;
    const role = type === "user_message" ? "user" : "assistant";
    const phase = type === "agent_message" ? normalizePhase(payload.phase) : null;
    return messageItem(ordinal, timestamp, role, phase, null, markdown);
  }
  if (type !== "item_completed" || !isObject(payload.item)) return null;
  const item = payload.item;
  const itemType = nonEmptyString(item.type);
  if (itemType === "UserMessage") {
    const markdown = itemContentText(item.content, "text");
    return markdown === null ? null : messageItem(ordinal, timestamp, "user", null, null, markdown);
  }
  if (itemType === "AgentMessage") {
    const markdown = itemContentText(item.content, "Text");
    return markdown === null
      ? null
      : messageItem(ordinal, timestamp, "assistant", normalizePhase(item.phase), null, markdown);
  }
  if (itemType !== "Plan") return null;
  const markdown = nonEmptyString(item.text);
  return markdown === null
    ? null
    : messageItem(ordinal, timestamp, "assistant", "response", "plan", markdown);
}

function messageItem(
  ordinal: number,
  timestamp: string | null,
  role: "user" | "assistant",
  phase: "update" | "response" | null,
  itemType: DomainMessageRecord["itemType"],
  markdown: string,
): DomainMessageRecord {
  return {
    kind: "message",
    id: `message-${ordinal}`,
    ordinal,
    timestamp,
    role,
    phase,
    itemType,
    markdown: truncateText(markdown, MAX_MESSAGE_CHARS).text,
  };
}

function itemContentText(value: unknown, acceptedType: "text" | "Text"): string | null {
  if (!Array.isArray(value)) return null;
  const text = value
    .filter(isObject)
    .filter((part) => part.type === acceptedType)
    .map((part) => nonEmptyString(part.text))
    .filter((part): part is string => part !== null)
    .join("\n\n");
  return text.length === 0 ? null : text;
}

function normalizePhase(value: unknown): "update" | "response" | null {
  if (value === "commentary") return "update";
  if (value === "final" || value === "final_answer") return "response";
  return null;
}

import { MAX_INTERACTION_MESSAGE_BYTES } from "../../shared/interaction.js";

export class MessageValidationError extends Error {
  readonly code = "invalid_message";
  constructor(message: string) {
    super(message);
  }
}

export function normalizeMessage(message: string): string {
  const normalized = message.replace(/\r\n?/g, "\n");
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (normalized.trim().length === 0) {
    throw new MessageValidationError("message must not be blank");
  }
  if (bytes > MAX_INTERACTION_MESSAGE_BYTES) {
    throw new MessageValidationError(
      `message must not exceed ${MAX_INTERACTION_MESSAGE_BYTES} UTF-8 bytes`,
    );
  }
  return normalized;
}

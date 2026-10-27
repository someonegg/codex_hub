import type { IncomingMessage } from "node:http";

import { MAX_INTERACTION_MESSAGE_BYTES } from "../../shared/interaction.js";

const MAX_INTERACTION_JSON_BYTES = MAX_INTERACTION_MESSAGE_BYTES * 6 + 1_024;

export class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | "invalid_json"
      | "body_too_large"
      | "invalid_session"
      | "forbidden"
      | "not_found",
    message: string,
  ) {
    super(message);
  }
}

export async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    invalidBody("Content-Type must be application/json");
  }
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_INTERACTION_JSON_BYTES) {
    bodyTooLarge();
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_INTERACTION_JSON_BYTES) bodyTooLarge();
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    invalidBody("Request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalidBody("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function invalidBody(message: string): never {
  throw new RequestBodyError(400, "invalid_json", message);
}

function bodyTooLarge(): never {
  throw new RequestBodyError(413, "body_too_large", "Request body is too large");
}

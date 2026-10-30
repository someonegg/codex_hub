import { createHash } from "node:crypto";

export type OpaqueSessionId = string;

export function encodeStringTuple(...parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("");
}

export function opaqueIdForParts(...parts: readonly string[]): OpaqueSessionId {
  return createHash("sha256")
    .update(encodeStringTuple(...parts), "utf16le")
    .digest("base64url");
}

export function opaqueIdForPath(canonicalPath: string): OpaqueSessionId {
  return createHash("sha256").update(canonicalPath, "utf8").digest("base64url");
}

export const SESSION_ID_PATTERN = "[A-Za-z0-9_-]{20,100}";
export function isOpaqueId(value: string): boolean {
  return new RegExp(`^${SESSION_ID_PATTERN}$`).test(value);
}

import { ApiClientError } from "../api/client";

export function messageFor(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return "The local hub could not complete the request.";
}

export function isAbort(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    reason.name === "AbortError"
  );
}

export function isTimelineConflict(reason: unknown): reason is ApiClientError {
  return reason instanceof ApiClientError && reason.code === "timeline_changed";
}

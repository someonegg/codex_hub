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

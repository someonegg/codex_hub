export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export function commandFailure(error: unknown, mutationSubmitted: boolean): CommandError {
  if (error instanceof CommandError) return error;
  if (mutationSubmitted)
    return new CommandError(
      "operation_result_unknown",
      "Operation result unknown; the backend operation was not retried or canceled. Use list, inspect, or terminal to check the current state.",
      2,
    );
  return new CommandError(
    "query_failed",
    `Query failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export function httpFailure(
  status: number,
  method: string,
  error: { code?: string; message?: string } | undefined,
  mutationSubmitted: boolean,
): CommandError {
  const unknown =
    (mutationSubmitted && (method === "GET" || error?.code === "operation_result_unknown")) ||
    (status >= 500 && method !== "GET" && error?.code !== "interaction_failed");
  if (unknown)
    return new CommandError(
      "operation_result_unknown",
      "Operation result unknown; use list, inspect, or terminal to check the current state.",
      2,
    );
  return new CommandError("request_failed", error?.message ?? `HTTP ${status}`);
}

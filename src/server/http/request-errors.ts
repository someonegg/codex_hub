import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApiErrorLogger, ApiRouterOptions } from "./api-router.js";
import { sendJson } from "./router.js";

export class MalformedRequestError extends Error {}
export function requestUrl(request: IncomingMessage): URL {
  try {
    return new URL(request.url ?? "/", "http://localhost");
  } catch {
    throw new MalformedRequestError("Malformed URL");
  }
}
export function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    throw new MalformedRequestError("Malformed path encoding");
  }
}
export function isMissingFile(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}
const ids = new WeakMap<IncomingMessage, string>();
export function requestId(request: IncomingMessage, factory: () => string = randomUUID): string {
  let id = ids.get(request);
  if (!id) {
    id = factory();
    ids.set(request, id);
  }
  return id;
}
export const consoleErrorLogger: ApiErrorLogger = {
  error(message, context) {
    console.error(message, context);
  },
};
export function reportRequestError(
  request: IncomingMessage,
  response: ServerResponse,
  error: unknown,
  options: ApiRouterOptions = {},
  sessionApi = false,
): void {
  const id = requestId(request, options.requestId);
  (options.logger ?? consoleErrorLogger).error(
    sessionApi ? "Session API request failed" : "HTTP request failed",
    {
      requestId: id,
      ...(!sessionApi ? { method: request.method, path: request.url?.split("?")[0] ?? "/" } : {}),
      error,
    },
  );
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  sendJson(
    response,
    500,
    {
      error: {
        code: "internal_error",
        message: sessionApi
          ? "The local session reader could not complete the request"
          : "The server could not complete the request",
        requestId: id,
      },
    },
    request.method === "HEAD",
  );
}

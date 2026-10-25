import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApiError } from "../../shared/api-contract.js";

export type ApiRouter = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean> | boolean;

export function sendJson(
  response: ServerResponse,
  status: number,
  body: ApiError | object,
  headOnly = false,
): void {
  const json = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", response.getHeader("Cache-Control") ?? "no-store");
  response.setHeader("Content-Length", Buffer.byteLength(json));
  response.end(headOnly ? undefined : json);
}

export const emptyApiRouter: ApiRouter = (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (!pathname.startsWith("/api/")) return false;
  sendJson(
    response,
    404,
    { error: { code: "not_found", message: "API endpoint not found" } },
    request.method === "HEAD",
  );
  return true;
};

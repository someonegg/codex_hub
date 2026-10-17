import { ManagementError, type OperationService } from "../management/operation-service.js";
import type { ApiRouteHandler } from "./api-route-handler.js";
import { readJsonObject, RequestBodyError } from "./request-body.js";
import { sendJson } from "./router.js";
import { SESSION_ID_PATTERN, SESSION_ROOT, sessionPath } from "./session-path.js";

const OPERATION_PATH = /^\/api\/v1\/operations\/[^/]+$/;
const SESSION_PATH = new RegExp(`^${SESSION_ROOT}/${SESSION_ID_PATTERN}(?:/archive)?$`);

export function createSessionManagementRoutes(operations?: OperationService): ApiRouteHandler {
  return {
    matches: (url) =>
      OPERATION_PATH.test(url.pathname) ||
      url.pathname === SESSION_ROOT ||
      SESSION_PATH.test(url.pathname),
    async handle(request, response, url) {
      if (!operations) return false;
      if (OPERATION_PATH.test(url.pathname)) {
        if (request.method !== "GET") return false;
        const operationId = url.pathname.slice("/api/v1/operations/".length);
        const operation = await operations.get(operationId);
        if (!operation) {
          throw new ManagementError(
            404,
            "Operation not found; the server may have restarted or the record expired",
          );
        }
        sendJson(response, 200, operation);
        return true;
      }
      const create = url.pathname === SESSION_ROOT;
      const archive = url.pathname.endsWith("/archive");
      const method = create || archive ? "POST" : "DELETE";
      if (request.method !== method) return false;
      const protocol = "encrypted" in request.socket && request.socket.encrypted ? "https" : "http";
      if (
        request.headers.origin &&
        request.headers.origin !== `${protocol}://${request.headers.host}`
      ) {
        throw new ManagementError(403, "Cross-origin management requests are not allowed");
      }
      const body = await readJsonObject(request);
      if (create) {
        if (typeof body.requestId !== "string")
          throw new RequestBodyError(400, "invalid_json", "requestId is required");
        if (
          Object.keys(body).some((key) => !["directory", "worktree", "requestId"].includes(key)) ||
          typeof body.directory !== "string" ||
          typeof body.worktree !== "boolean"
        ) {
          throw new RequestBodyError(400, "invalid_json", "directory and worktree are required");
        }
        sendJson(
          response,
          202,
          operations.create({
            directory: body.directory,
            worktree: body.worktree,
            requestId: body.requestId,
          }),
        );
      } else {
        if (Object.keys(body).length !== 0)
          throw new RequestBodyError(400, "invalid_json", "Expected an empty object");
        const { id: sessionId } = sessionPath(url.pathname);
        sendJson(response, 202, operations.manage(archive ? "archive" : "delete", sessionId));
      }
      return true;
    },
    mapError(error, request, response) {
      if (error instanceof ManagementError) {
        sendJson(
          response,
          error.status,
          {
            error: { code: "management_error", message: error.message },
          },
          request.method === "HEAD",
        );
        return true;
      }
      return false;
    },
  };
}

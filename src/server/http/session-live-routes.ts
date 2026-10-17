import type { ServerResponse } from "node:http";

import type { LiveRevision, SessionLiveQuery, TimelineCursor } from "../../shared/api-contract.js";
import { SessionLiveError, type SessionLiveService } from "../live/session-live-service.js";
import { RepositoryQueryError } from "../repository/session-queries.js";
import type { ApiRouteHandler } from "./api-route-handler.js";
import { invalid, only, optional } from "./query-params.js";
import { sendJson } from "./router.js";
import { SESSION_ID_PATTERN, SESSION_ROOT, sessionPath } from "./session-path.js";

const LIVE_PATH = new RegExp(`^${SESSION_ROOT}/${SESSION_ID_PATTERN}/live$`);

export function createSessionLiveRoutes(live: SessionLiveService): ApiRouteHandler {
  return {
    matches: (url) => LIVE_PATH.test(url.pathname),
    async handle(request, response, url) {
      const headOnly = request.method === "HEAD";
      if (request.method !== "GET" && !headOnly) return false;
      const { id } = sessionPath(url.pathname);
      response.setHeader("Cache-Control", "no-store");
      const abort = new AbortController();
      const onDisconnect = () => {
        if (!response.writableEnded) abort.abort();
      };
      request.once("aborted", onDisconnect);
      response.once("close", onDisconnect);
      try {
        const result = await live.wait(id, parseLiveQuery(url.searchParams), abort.signal);
        if (abort.signal.aborted || response.destroyed) return true;
        if (result === null) return noContent(response);
        sendJson(response, 200, result, headOnly);
        return true;
      } finally {
        request.removeListener("aborted", onDisconnect);
        response.removeListener("close", onDisconnect);
      }
    },
    mapError(error, request, response) {
      const headOnly = request.method === "HEAD";
      if (error instanceof RepositoryQueryError) {
        const status = error.code === "timeline_changed" ? 409 : 400;
        sendJson(
          response,
          status,
          {
            error: { code: error.code, message: error.message },
          },
          headOnly,
        );
        return true;
      }
      if (error instanceof SessionLiveError) {
        const status = error.code === "session_not_found" ? 404 : 429;
        if (status === 429) response.setHeader("Retry-After", "2");
        sendJson(
          response,
          status,
          {
            error: { code: error.code, message: error.message },
          },
          headOnly,
        );
        return true;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        if (request.destroyed || response.destroyed) return true;
        return noContent(response);
      }
      return false;
    },
  };
}

function parseLiveQuery(params: URLSearchParams): SessionLiveQuery {
  only(params, ["cursor", "after"]);
  const cursor = optional(params, "cursor");
  const after = optional(params, "after");
  if (cursor === undefined) invalid("cursor is required for Live updates");
  if (after === undefined) invalid("after is required for Live updates");
  if (!/^[A-Za-z0-9_-]{43}$/.test(after)) invalid("after is malformed");
  return {
    cursor: cursor as TimelineCursor,
    after: after as LiveRevision,
  };
}

function noContent(response: ServerResponse): true {
  response.statusCode = 204;
  response.end();
  return true;
}

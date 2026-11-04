import type { IncomingMessage, ServerResponse } from "node:http";

import type { SessionListQuery, UpdateRevision } from "../../shared/api-contract.js";
import type { SessionReader } from "../application/session-reader.js";
import {
  CatalogCapacityError,
  type SessionCatalogService,
} from "../catalog/session-catalog-service.js";
import { RepositoryQueryError } from "../repository/session-queries.js";
import {
  SessionUpdatesError,
  type SessionUpdatesService,
} from "../updates/session-updates-service.js";
import type { ApiRouteHandler } from "./api-route-handler.js";
import { invalid, only, optional } from "./query-params.js";
import { sendJson } from "./router.js";
import { isOpaqueId, readPathname, SESSION_ROOT, sessionPath } from "./session-path.js";

/** Shape produced by the update-revision HMAC factory (base64url SHA-256). */
const REVISION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createSessionReadRoutes(dependencies: {
  readonly sessions: SessionReader;
  readonly updates: SessionUpdatesService;
  readonly catalog: SessionCatalogService;
}): ApiRouteHandler {
  return {
    matches: () => true,
    async handle(request, response, url) {
      const pathname = readPathname(request, url);
      const headOnly = request.method === "HEAD";
      const readMethod = request.method === "GET" || headOnly;
      if (!readMethod) return false;
      if (pathname === SESSION_ROOT) {
        const query = parseListQuery(url.searchParams);
        return sendWaitResponse(request, response, headOnly, (signal) =>
          dependencies.catalog.wait(headOnly ? undefined : query.after, signal),
        );
      }
      if (!pathname.startsWith(`${SESSION_ROOT}/`)) {
        return notFound(response, headOnly);
      }
      const { id, segments } = sessionPath(pathname);
      if (!isOpaqueId(id)) return notFound(response, headOnly);
      if (segments.length === 1 && segments[0] === "messages") {
        only(url.searchParams, ["limit", "after", "wait", "stateRevision"]);
        const limit = optional(url.searchParams, "limit");
        const after = optional(url.searchParams, "after");
        const wait = optional(url.searchParams, "wait");
        const stateRevision = optional(url.searchParams, "stateRevision");
        if (wait !== undefined && wait !== "true" && wait !== "false")
          invalid("wait must be true or false");
        if (stateRevision !== undefined && !REVISION_PATTERN.test(stateRevision))
          invalid("stateRevision is malformed");
        const query = {
          ...(limit === undefined ? {} : { limit: integer(limit, "limit") }),
          ...(after === undefined ? {} : { after: integer(after, "after") }),
          wait: !headOnly && wait === "true",
          ...(stateRevision === undefined
            ? {}
            : { stateRevision: stateRevision as UpdateRevision }),
        };
        if (!query.wait) {
          // Plain reads go straight to the reader; waiter capacity bounds only long polls.
          const result = await dependencies.sessions.messages(id, query);
          if (result === null) return notFound(response, headOnly, "session_not_found");
          response.setHeader("Cache-Control", "no-store");
          sendJson(response, 200, result, headOnly);
          return true;
        }
        return sendWaitResponse(request, response, headOnly, (signal) =>
          dependencies.updates.wait(id, query, signal),
        );
      }
      if (segments.length === 0) {
        if ([...url.searchParams].length > 0) {
          invalid("session metadata does not accept query parameters");
        }
        const result = await dependencies.sessions.getSession(id);
        if (result === null) {
          return notFound(response, headOnly, "session_not_found");
        }
        sendJson(response, 200, result, headOnly);
        return true;
      }
      return notFound(response, headOnly);
    },
    mapError(error, request, response) {
      if (error instanceof SessionUpdatesError) {
        const status = error.code === "session_not_found" ? 404 : 429;
        if (status === 429) response.setHeader("Retry-After", "2");
        sendJson(
          response,
          status,
          { error: { code: error.code, message: error.message } },
          request.method === "HEAD",
        );
        return true;
      }
      if (error instanceof CatalogCapacityError) {
        response.setHeader("Retry-After", "2");
        sendJson(
          response,
          429,
          { error: { code: "catalog_capacity_exceeded", message: error.message } },
          request.method === "HEAD",
        );
        return true;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        if (!response.destroyed) {
          response.statusCode = 204;
          response.end();
        }
        return true;
      }
      if (!(error instanceof RepositoryQueryError)) return false;
      sendJson(
        response,
        400,
        { error: { code: error.code, message: error.message } },
        request.method === "HEAD",
      );
      return true;
    },
  };
}

async function sendWaitResponse(
  request: IncomingMessage,
  response: ServerResponse,
  headOnly: boolean,
  read: (signal: AbortSignal) => Promise<object | null>,
): Promise<true> {
  const abort = new AbortController();
  const disconnect = () => {
    if (!response.writableEnded) abort.abort();
  };
  request.once("aborted", disconnect);
  response.once("close", disconnect);
  response.setHeader("Cache-Control", "no-store");
  try {
    const result = await read(abort.signal);
    if (abort.signal.aborted || response.destroyed) return true;
    if (result === null) {
      response.statusCode = 204;
      response.end();
    } else sendJson(response, 200, result, headOnly);
    return true;
  } finally {
    request.removeListener("aborted", disconnect);
    response.removeListener("close", disconnect);
  }
}

function parseListQuery(params: URLSearchParams): SessionListQuery {
  only(params, ["after"]);
  const after = optional(params, "after");
  if (after !== undefined && !REVISION_PATTERN.test(after)) invalid("after is malformed");
  return after === undefined ? {} : { after };
}

function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value)) invalid(`${name} must be an integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    invalid(`${name} is outside the supported range`);
  }
  return result;
}

function notFound(response: ServerResponse, headOnly: boolean, code = "not_found"): true {
  sendJson(response, 404, { error: { code, message: "API resource not found" } }, headOnly);
  return true;
}

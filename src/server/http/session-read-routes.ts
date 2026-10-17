import type { ServerResponse } from "node:http";

import type {
  DirectiveDetailQuery,
  InternalDetailQuery,
  ItemPageQuery,
  SessionListQuery,
  TimelineCursor,
  ToolDetailQuery,
} from "../../shared/api-contract.js";
import type { SessionReader } from "../application/session-reader.js";
import {
  CatalogCapacityError,
  type SessionCatalogService,
} from "../catalog/session-catalog-service.js";
import type { SessionInteractionService } from "../interaction/interaction-service.js";
import { withLiveRevision } from "../live/live-revision.js";
import type { SessionLiveService } from "../live/session-live-service.js";
import { RepositoryQueryError } from "../repository/session-queries.js";
import type { ApiRouteHandler } from "./api-route-handler.js";
import { invalid, only, optional } from "./query-params.js";
import { sendJson } from "./router.js";
import { isOpaqueId, readPathname, SESSION_ROOT, sessionPath } from "./session-path.js";

type InteractionReader = Pick<SessionInteractionService, "describe">;

export function createSessionReadRoutes(dependencies: {
  readonly sessions: SessionReader;
  readonly live: SessionLiveService;
  readonly catalog: SessionCatalogService;
  readonly interaction?: InteractionReader;
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
        const abort = new AbortController();
        const disconnect = () => {
          if (!response.writableEnded) abort.abort();
        };
        request.once("aborted", disconnect);
        response.once("close", disconnect);
        response.setHeader("Cache-Control", "no-store");
        try {
          const result = await dependencies.catalog.wait(
            headOnly ? undefined : query.after,
            abort.signal,
          );
          if (abort.signal.aborted || response.destroyed) return true;
          if (result === null) {
            response.statusCode = 204;
            response.end();
          } else sendJson(response, 200, result, headOnly);
        } finally {
          request.removeListener("aborted", disconnect);
          response.removeListener("close", disconnect);
        }
        return true;
      }
      if (!pathname.startsWith(`${SESSION_ROOT}/`)) {
        return notFound(response, headOnly);
      }
      const { id, segments } = sessionPath(pathname);
      if (!isOpaqueId(id)) return notFound(response, headOnly);
      const itemId =
        segments.length === 3 && segments[0] === "items" ? decodeItemId(segments[1] ?? "") : "";

      if (segments.length === 0) {
        if ([...url.searchParams].length > 0) {
          invalid("session metadata does not accept query parameters");
        }
        const result = await dependencies.sessions.getSession(id);
        if (result === null) {
          return notFound(response, headOnly, "session_not_found");
        }
        const interaction = await describeInteraction(dependencies.interaction, id);
        sendJson(
          response,
          200,
          withLiveRevision(
            {
              ...result,
              interaction,
            },
            dependencies.live.revision.bind(dependencies.live),
          ),
          headOnly,
        );
        return true;
      }
      if (segments.length === 1 && segments[0] === "items") {
        const result = await dependencies.sessions.getItems(id, parseItemQuery(url.searchParams));
        if (result === null) {
          return notFound(response, headOnly, "session_not_found");
        }
        const interaction = await describeInteraction(dependencies.interaction, id);
        sendJson(
          response,
          200,
          withLiveRevision(
            {
              ...result,
              interaction,
            },
            dependencies.live.revision.bind(dependencies.live),
          ),
          headOnly,
        );
        return true;
      }
      if (segments.length === 3 && segments[0] === "items" && segments[2] === "tool") {
        const result = await dependencies.sessions.getToolDetail(
          id,
          itemId,
          parseToolQuery(url.searchParams),
        );
        if (result === null) {
          return notFound(response, headOnly, "tool_not_found");
        }
        sendJson(response, 200, result, headOnly);
        return true;
      }
      if (segments.length === 3 && segments[0] === "items" && segments[2] === "internal") {
        const result = await dependencies.sessions.getInternalDetail(
          id,
          itemId,
          parseInternalQuery(url.searchParams),
        );
        if (result === null) {
          return notFound(response, headOnly, "internal_not_found");
        }
        sendJson(response, 200, result, headOnly);
        return true;
      }
      if (segments.length === 3 && segments[0] === "items" && segments[2] === "directive") {
        const result = await dependencies.sessions.getDirectiveDetail(
          id,
          itemId,
          parseDirectiveQuery(url.searchParams),
        );
        if (result === null) {
          return notFound(response, headOnly, "directive_not_found");
        }
        sendJson(response, 200, result, headOnly);
        return true;
      }
      return notFound(response, headOnly);
    },
    mapError(error, request, response) {
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
      const status = error.code === "timeline_changed" ? 409 : 400;
      sendJson(
        response,
        status,
        {
          error: { code: error.code, message: error.message },
        },
        request.method === "HEAD",
      );
      return true;
    },
  };
}

async function describeInteraction(interaction: InteractionReader | undefined, sessionId: string) {
  if (interaction === undefined) return { supported: false as const, attachCommand: null };
  return (
    (await interaction.describe(sessionId)) ?? { supported: false as const, attachCommand: null }
  );
}

function parseListQuery(params: URLSearchParams): SessionListQuery {
  only(params, ["after"]);
  const after = optional(params, "after");
  if (after !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(after)) invalid("after is malformed");
  return after === undefined ? {} : { after };
}

function parseItemQuery(params: URLSearchParams): ItemPageQuery {
  only(params, ["limit", "cursor"]);
  const query: ItemPageQuery = {};
  const cursor = optional(params, "cursor");
  if (cursor !== undefined) query.cursor = cursor as TimelineCursor;
  const limit = optional(params, "limit");
  if (limit !== undefined) query.limit = integer(limit, "limit");
  return query;
}

function parseToolQuery(params: URLSearchParams): ToolDetailQuery {
  only(params, ["cursor"]);
  return { cursor: requiredCursor(params, "tool detail") };
}

function parseDirectiveQuery(params: URLSearchParams): DirectiveDetailQuery {
  only(params, ["cursor"]);
  return { cursor: requiredCursor(params, "directive detail") };
}

function parseInternalQuery(params: URLSearchParams): InternalDetailQuery {
  only(params, ["cursor"]);
  return { cursor: requiredCursor(params, "internal detail") };
}

function requiredCursor(params: URLSearchParams, resource: string): TimelineCursor {
  const cursor = optional(params, "cursor");
  if (cursor === undefined) invalid(`cursor is required for ${resource}`);
  return cursor as TimelineCursor;
}

function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value)) invalid(`${name} must be an integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    invalid(`${name} is outside the supported range`);
  }
  return result;
}

function decodeItemId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return invalid("item ID is malformed");
  }
  if (
    !decoded ||
    Buffer.byteLength(decoded, "utf8") > 1024 ||
    /[\u0000-\u001f\u007f-\u009f/\\]/u.test(decoded) ||
    decoded === "." ||
    decoded === ".."
  ) {
    invalid("item ID is malformed");
  }
  return decoded;
}

function notFound(response: ServerResponse, headOnly: boolean, code = "not_found"): true {
  sendJson(response, 404, { error: { code, message: "API resource not found" } }, headOnly);
  return true;
}

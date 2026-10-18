import type { ServerResponse } from "node:http";

import {
  INTERACTION_KEYS,
  type InteractionKey,
  MAX_INTERACTION_KEY_SEQUENCE_LENGTH,
} from "../../shared/api-contract.js";
import {
  SessionInteractionError,
  type SessionInteractionService,
} from "../interaction/interaction-service.js";
import { MessageValidationError, normalizeMessage } from "../interaction/message.js";
import type { ApiRouteHandler } from "./api-route-handler.js";
import { HttpQueryError } from "./query-params.js";
import { readJsonObject, RequestBodyError } from "./request-body.js";
import { sendJson } from "./router.js";
import { SESSION_ID_PATTERN, SESSION_ROOT, sessionPath } from "./session-path.js";

const INTERACTION_PATH = new RegExp(
  `^${SESSION_ROOT}/${SESSION_ID_PATTERN}/(?:terminal-preview|messages|keys|handoff-pane-binding)$`,
);

const INTERACTION_KEY_SET = new Set<string>(INTERACTION_KEYS);

type InteractionRoutesService = Pick<
  SessionInteractionService,
  "preview" | "sendMessage" | "handoffPaneBinding" | "sendKeys"
>;

export function createSessionInteractionRoutes(
  interaction?: InteractionRoutesService,
): ApiRouteHandler {
  return {
    matches: (url) => INTERACTION_PATH.test(url.pathname),
    async handle(request, response, url) {
      const {
        id,
        segments: [operation = ""],
      } = sessionPath(url.pathname);
      if (operation === "terminal-preview") {
        const headOnly = request.method === "HEAD";
        if (request.method !== "GET" && !headOnly) return false;
        if ([...url.searchParams].length > 0) {
          invalidQuery("terminal preview does not accept query parameters");
        }
        if (interaction === undefined) return interactionUnavailable(response);
        sendJson(response, 200, await interaction.preview(id), headOnly);
        return true;
      }
      if (request.method !== "POST") return false;
      if (interaction === undefined) return interactionUnavailable(response);
      if (operation === "handoff-pane-binding") {
        const body = await readJsonObject(request);
        if (Object.keys(body).length !== 0) invalidBody("Expected an empty object");
        await interaction.handoffPaneBinding(id);
        return noContent(response);
      }
      if (operation === "messages") {
        const body = await readJsonObject(request);
        if (Object.keys(body).length !== 1 || typeof body.message !== "string") {
          invalidBody("body must contain only a string message field");
        }
        normalizeMessage(body.message);
        await interaction.sendMessage(id, body.message);
        return noContent(response);
      }
      if (operation === "keys") {
        const body = await readJsonObject(request);
        if (Object.keys(body).length !== 1 || !Array.isArray(body.keys)) {
          invalidBody("body must contain only a keys array");
        }
        if (
          body.keys.length === 0 ||
          body.keys.length > MAX_INTERACTION_KEY_SEQUENCE_LENGTH ||
          !body.keys.every(isInteractionKey)
        ) {
          invalidBody(
            `keys must contain 1-${MAX_INTERACTION_KEY_SEQUENCE_LENGTH} supported interaction keys`,
          );
        }
        await interaction.sendKeys(id, body.keys);
        return noContent(response);
      }
      return false;
    },
    mapError(error, request, response) {
      const headOnly = request.method === "HEAD";
      if (error instanceof MessageValidationError && error.code === "invalid_message") {
        sendJson(
          response,
          400,
          {
            error: { code: "invalid_message", message: error.message },
          },
          headOnly,
        );
        return true;
      }
      if (error instanceof SessionInteractionError) {
        const status =
          error.code === "session_not_found"
            ? 404
            : error.code === "operation_result_unknown"
              ? 504
              : error.code === "interaction_failed"
                ? 502
                : 409;
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
      return false;
    },
  };
}

function invalidBody(message: string): never {
  throw new RequestBodyError(400, "invalid_json", message);
}

function invalidQuery(message: string): never {
  throw new HttpQueryError(message);
}

function isInteractionKey(value: unknown): value is InteractionKey {
  return typeof value === "string" && INTERACTION_KEY_SET.has(value);
}

function noContent(response: ServerResponse): true {
  response.statusCode = 204;
  response.end();
  return true;
}

function interactionUnavailable(response: ServerResponse): true {
  sendJson(response, 409, {
    error: {
      code: "interaction_not_supported",
      message: "Interaction is not enabled",
    },
  });
  return true;
}

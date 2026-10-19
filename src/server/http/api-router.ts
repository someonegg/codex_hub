import { randomUUID } from "node:crypto";

import type { SessionReader } from "../application/session-reader.js";
import type { SessionCatalogService } from "../catalog/session-catalog-service.js";
import type { SessionInteractionService } from "../interaction/interaction-service.js";
import type { OperationService } from "../management/operation-service.js";
import type { SessionUpdatesService } from "../updates/session-updates-service.js";
import { HttpQueryError } from "./query-params.js";
import { RequestBodyError } from "./request-body.js";
import { type ApiRouter, sendJson } from "./router.js";
import { createSessionInteractionRoutes } from "./session-interaction-routes.js";
import { createSessionManagementRoutes } from "./session-management-routes.js";
import { createSessionReadRoutes } from "./session-read-routes.js";
import { createSessionUpdatesRoutes } from "./session-updates-routes.js";

export interface ApiErrorLogger {
  error(message: string, context: { readonly requestId: string; readonly error: unknown }): void;
}

type InteractionApi = Pick<
  SessionInteractionService,
  "describe" | "sendMessage" | "handoffPaneBinding" | "sendKeys"
>;

export interface ApiRouterDependencies {
  readonly sessions: SessionReader;
  readonly catalog: SessionCatalogService;
  readonly updates: SessionUpdatesService;
  readonly interaction?: InteractionApi;
  readonly operations?: OperationService;
}

export interface ApiRouterOptions {
  readonly logger?: ApiErrorLogger;
  readonly requestId?: () => string;
}

const CONSOLE_ERROR_LOGGER: ApiErrorLogger = {
  error(message, context) {
    console.error(`${message} [requestId=${context.requestId}]`, context.error);
  },
};

export function createApiRouter(
  dependencies: ApiRouterDependencies,
  options: ApiRouterOptions = {},
): ApiRouter {
  const logger = options.logger ?? CONSOLE_ERROR_LOGGER;
  const requestIdFactory = options.requestId ?? randomUUID;
  const handlers = [
    createSessionManagementRoutes(dependencies.operations),
    createSessionUpdatesRoutes(dependencies.updates),
    createSessionInteractionRoutes(dependencies.interaction),
    createSessionReadRoutes(dependencies),
  ];
  const router: ApiRouter = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    const headOnly = request.method === "HEAD";
    const requestId = requestIdFactory();
    for (const handler of handlers.filter((candidate) => candidate.matches(url))) {
      try {
        if (await handler.handle(request, response, url)) return true;
      } catch (error) {
        if (error instanceof RequestBodyError || error instanceof HttpQueryError) {
          sendJson(
            response,
            error instanceof RequestBodyError ? error.status : 400,
            {
              error: {
                code: error instanceof RequestBodyError ? error.code : "invalid_query",
                message: error.message,
              },
            },
            headOnly,
          );
          return true;
        }
        if (handler.mapError(error, request, response)) return true;
        logger.error("Session API request failed", { requestId, error });
        sendJson(
          response,
          500,
          {
            error: {
              code: "internal_error",
              message: "The local session reader could not complete the request",
              requestId,
            },
          },
          headOnly,
        );
        return true;
      }
    }
    return false;
  };
  return router;
}

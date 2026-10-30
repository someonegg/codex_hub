import { join } from "node:path";

import type { SessionReader } from "../application/session-reader.js";
import type { SessionCatalogService } from "../catalog/session-catalog-service.js";
import { resolveHomeDirectory } from "../config.js";
import type { SessionInteractionService } from "../interaction/interaction-service.js";
import type { OperationService } from "../management/operation-service.js";
import type { SessionUpdatesService } from "../updates/session-updates-service.js";
import { UploadStore } from "../uploads/store.js";
import { HttpQueryError } from "./query-params.js";
import { RequestBodyError } from "./request-body.js";
import { reportRequestError, requestUrl } from "./request-errors.js";
import { type ApiRouter, sendJson } from "./router.js";
import { createSessionInteractionRoutes } from "./session-interaction-routes.js";
import { createSessionManagementRoutes } from "./session-management-routes.js";
import { createSessionReadRoutes } from "./session-read-routes.js";
import { createSessionUpdatesRoutes } from "./session-updates-routes.js";
import { createUploadRoutes } from "./upload-routes.js";

export interface ApiErrorLogger {
  error(
    message: string,
    context: {
      readonly requestId: string;
      readonly error: unknown;
      readonly method?: string;
      readonly path?: string;
    },
  ): void;
}

type InteractionApi = Pick<
  SessionInteractionService,
  "describe" | "describeSnapshot" | "sendMessage" | "handoffPaneBinding" | "sendKeys"
>;

export interface ApiRouterDependencies {
  readonly sessions: SessionReader;
  readonly catalog: SessionCatalogService;
  readonly updates: SessionUpdatesService;
  readonly interaction?: InteractionApi &
    Partial<Pick<SessionInteractionService, "captureTerminal">>;
  readonly operations?: OperationService;
  readonly uploadDirectory?: string;
  readonly uploads?: UploadStore;
}

export interface ApiRouterOptions {
  readonly logger?: ApiErrorLogger;
  readonly requestId?: () => string;
}

export function createApiRouter(
  dependencies: ApiRouterDependencies,
  options: ApiRouterOptions = {},
): ApiRouter {
  const handlers = [
    createUploadRoutes(
      dependencies.uploads ??
        new UploadStore(dependencies.uploadDirectory ?? join(resolveHomeDirectory(), "uploads")),
      dependencies.sessions,
    ),
    createSessionManagementRoutes(dependencies.operations),
    createSessionUpdatesRoutes(dependencies.updates),
    createSessionInteractionRoutes(dependencies.interaction),
    createSessionReadRoutes(dependencies),
  ];
  const router: ApiRouter = async (request, response) => {
    const url = requestUrl(request);
    if (!url.pathname.startsWith("/api/")) return false;
    const headOnly = request.method === "HEAD";
    for (const handler of handlers.filter((candidate) => candidate.matches(url))) {
      try {
        if (await handler.handle(request, response, url)) return true;
      } catch (error) {
        if (response.headersSent) {
          reportRequestError(request, response, error, options, true);
          return true;
        }
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
        reportRequestError(request, response, error, options, true);
        return true;
      }
    }
    return false;
  };
  return router;
}

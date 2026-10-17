import type { IncomingMessage, ServerResponse } from "node:http";

export interface ApiRouteHandler {
  matches(url: URL): boolean;
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
  mapError(error: unknown, request: IncomingMessage, response: ServerResponse): boolean;
}

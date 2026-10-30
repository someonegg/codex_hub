import type { IncomingMessage } from "node:http";

export const SESSION_ROOT = "/api/v1/sessions";
export { isOpaqueId, SESSION_ID_PATTERN } from "../security/opaque-id.js";
export function sessionPath(pathname: string): { id: string; segments: string[] } {
  const [id = "", ...segments] = pathname.slice(SESSION_ROOT.length + 1).split("/");
  return { id, segments };
}
export function readPathname(request: IncomingMessage, url: URL): string {
  return request.url?.startsWith("/") ? request.url.split("?")[0]! : url.pathname;
}

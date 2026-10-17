import type { IncomingMessage } from "node:http";

export const SESSION_ROOT = "/api/v1/sessions";
export const SESSION_ID_PATTERN = "[A-Za-z0-9_-]{20,100}";
export function isOpaqueId(value: string): boolean {
  return new RegExp(`^${SESSION_ID_PATTERN}$`).test(value);
}
export function sessionPath(pathname: string): { id: string; segments: string[] } {
  const [id = "", ...segments] = pathname.slice(SESSION_ROOT.length + 1).split("/");
  return { id, segments };
}
export function readPathname(request: IncomingMessage, url: URL): string {
  return request.url?.startsWith("/") ? request.url.split("?")[0]! : url.pathname;
}

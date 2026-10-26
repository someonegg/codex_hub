import type { IncomingMessage, ServerResponse } from "node:http";

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; font-src 'self' data:; form-action 'none'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
} as const;

export function applySecurityHeaders(response: ServerResponse, request: IncomingMessage): void {
  const secure = "encrypted" in request.socket && request.socket.encrypted;
  const host = request.headers.host;
  // Explicit WebSocket sources are needed by browsers that do not map 'self' to ws/wss.
  if (host && /^[a-zA-Z0-9.:[\]-]+$/.test(host)) {
    response.setHeader(
      "Content-Security-Policy",
      `${SECURITY_HEADERS["Content-Security-Policy"]}; connect-src 'self' ${secure ? "wss" : "ws"}://${host}`,
    );
  }
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!response.hasHeader(name)) response.setHeader(name, value);
  }
}

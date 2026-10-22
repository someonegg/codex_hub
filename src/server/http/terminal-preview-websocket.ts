import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import type { TerminalPreviewError, TerminalPreviewMessage } from "../../shared/api-contract.js";
import {
  SessionInteractionError,
  type SessionInteractionService,
} from "../interaction/interaction-service.js";
import { InteractionTransportError } from "../interaction/transport.js";
import { SESSION_ID_PATTERN, SESSION_ROOT } from "./session-path.js";

export interface ServerUpgradeHandler {
  handle(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

const PATH = new RegExp(`^${SESSION_ROOT}/(${SESSION_ID_PATTERN})/terminal-preview$`);
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

export function createTerminalPreviewWebSocket(
  interaction?: Pick<SessionInteractionService, "subscribePreview">,
): ServerUpgradeHandler {
  const server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 1024,
  });
  const connections = new Map<WebSocket, { alive: boolean; stop(): void }>();
  const counts = new Map<string, number>();
  let closing = false;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const heartbeat = setInterval(() => {
    for (const [socket, connection] of connections) {
      if (!connection.alive) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) {
        connection.alive = false;
        socket.ping();
      }
    }
  }, 30_000);
  heartbeat.unref();

  return {
    handle(request, socket, head) {
      socket.on("error", () => socket.destroy());
      if (closing) return reject(socket, 503, "Service Unavailable");
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        return reject(socket, 400, "Bad Request");
      }
      const match = PATH.exec(url.pathname);
      if (!match) return reject(socket, 404, "Not Found");
      if (url.search) return reject(socket, 400, "Bad Request");
      const secure = "encrypted" in request.socket && request.socket.encrypted;
      if (
        request.headers.origin &&
        request.headers.origin !== `${secure ? "https" : "http"}://${request.headers.host}`
      )
        return reject(socket, 403, "Forbidden");
      server.handleUpgrade(request, socket, head, (ws) => {
        const sessionId = match[1]!;
        const abort = new AbortController();
        const count = counts.get(sessionId) ?? 0;
        const capacityExceeded = connections.size >= 100 || count >= 10;
        let release: (() => void) | undefined;
        const stop = () => {
          abort.abort();
          release?.();
          release = undefined;
        };
        const connection = { alive: true, stop };
        connections.set(ws, connection);
        counts.set(sessionId, count + 1);
        const send = (value: TerminalPreviewMessage) => {
          if (abort.signal.aborted || ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
            stop();
            ws.close(1013, "Preview consumer is too slow");
            return;
          }
          ws.send(JSON.stringify(value), (error) => {
            if (error) {
              stop();
              ws.terminate();
            }
          });
        };
        const finish = (message: TerminalPreviewError) => {
          if (abort.signal.aborted) return;
          send(message);
          stop();
          ws.close(message.retryable ? 1013 : 1008, message.code);
        };
        const fail = (error: unknown) => finish(previewError(error));
        ws.on("error", () => {
          stop();
          ws.terminate();
        });
        ws.on("pong", () => {
          connection.alive = true;
        });
        ws.on("message", () => {
          stop();
          ws.close(1008, "Preview accepts no application messages");
        });
        ws.once("close", () => {
          stop();
          connections.delete(ws);
          const remaining = (counts.get(sessionId) ?? 1) - 1;
          if (remaining) counts.set(sessionId, remaining);
          else counts.delete(sessionId);
          if (closing && !connections.size) clearTimeout(shutdownTimer);
        });
        if (capacityExceeded) {
          finish({
            type: "error",
            code: "preview_capacity_exceeded",
            message: "Too many terminal preview connections",
            retryable: true,
          });
        } else if (!interaction) {
          fail(
            new SessionInteractionError("interaction_not_supported", "Interaction is not enabled"),
          );
        } else {
          void interaction
            .subscribePreview(sessionId, send, fail, abort.signal)
            .then((close) => {
              if (abort.signal.aborted) close();
              else release = close;
            })
            .catch(fail);
        }
      });
    },
    close() {
      if (closing) return;
      closing = true;
      clearInterval(heartbeat);
      for (const [socket, connection] of connections) {
        connection.stop();
        socket.close(1001, "Server shutting down");
      }
      if (connections.size) {
        shutdownTimer = setTimeout(() => {
          for (const socket of connections.keys()) socket.terminate();
        }, 1000);
        shutdownTimer.unref();
      }
      server.close();
    },
  };
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function previewError(error: unknown): TerminalPreviewError {
  if (error instanceof SessionInteractionError) {
    return {
      type: "error",
      code: error.code,
      message: error.message,
      retryable: ["interaction_failed", "operation_result_unknown", "session_busy"].includes(
        error.code,
      ),
    };
  }
  if (error instanceof InteractionTransportError) {
    return {
      type: "error",
      code: error.code === "disconnected" ? "interaction_not_connected" : "interaction_failed",
      message: error.message,
      retryable: error.code !== "disconnected",
    };
  }
  return {
    type: "error",
    code: "interaction_failed",
    message: "Terminal Preview is temporarily unavailable",
    retryable: true,
  };
}

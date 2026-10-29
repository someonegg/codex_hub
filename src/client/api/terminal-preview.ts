import type { TerminalPreviewFrame, TerminalPreviewMessage } from "../../shared/api-contract";

import { LocalizedError } from "../i18n/localized-error";
import { ApiClientError } from "./client";

export interface PreviewConnectionCallbacks {
  frame(value: TerminalPreviewFrame): boolean;
  failed(message: string, retryable: boolean, error?: Error): void;
}

/** A new connection always starts from a full snapshot; there is no resume cursor. */
export function connectTerminalPreview(
  sessionId: string,
  callbacks: PreviewConnectionCallbacks,
): () => void {
  const url = new URL(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/terminal-preview`,
    window.location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  let stopped = false;
  let receivedSnapshot = false;
  const close = () => {
    if (stopped) return;
    stopped = true;
    socket.close();
  };
  const failed = (error: Error, retryable: boolean) => {
    if (stopped) return;
    close();
    callbacks.failed(error.message, retryable, error);
  };
  socket.onmessage = (event) => {
    if (stopped) return;
    try {
      const value: unknown = JSON.parse(event.data);
      if (typeof value !== "object" || value === null || !("type" in value)) throw new Error();
      const message = value as TerminalPreviewMessage;
      if (message.type === "error") {
        if (
          typeof message.code !== "string" ||
          typeof message.message !== "string" ||
          typeof message.retryable !== "boolean"
        )
          throw new Error();
        failed(new ApiClientError(0, message.code, message.message), message.retryable);
      } else {
        if (
          (message.type !== "snapshot" && message.type !== "delta") ||
          (!receivedSnapshot && message.type !== "snapshot")
        )
          throw new Error();
        if (!callbacks.frame(message)) throw new Error();
        receivedSnapshot = true;
      }
    } catch {
      failed(new LocalizedError("invalidTerminalPreviewUpdateReconnecting"), true);
    }
  };
  socket.onerror = () => failed(new LocalizedError("terminalPreviewConnectionFailed"), true);
  socket.onclose = (event) =>
    failed(new LocalizedError("terminalPreviewConnectionClosed"), event.code !== 1008);
  return close;
}

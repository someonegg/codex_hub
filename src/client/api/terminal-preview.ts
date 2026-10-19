import type { TerminalPreviewFrame, TerminalPreviewMessage } from "../../shared/api-contract";

export interface PreviewConnectionCallbacks {
  frame(value: TerminalPreviewFrame): boolean;
  failed(message: string, retryable: boolean): void;
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
  const failed = (message: string, retryable: boolean) => {
    if (stopped) return;
    close();
    callbacks.failed(message, retryable);
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
        failed(message.message, message.retryable);
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
      failed("Invalid terminal preview update; reconnecting", true);
    }
  };
  socket.onerror = () => failed("Terminal preview connection failed", true);
  socket.onclose = (event) => failed("Terminal preview connection closed", event.code !== 1008);
  return close;
}

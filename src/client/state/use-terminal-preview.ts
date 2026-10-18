import { useEffect, useRef, useState } from "react";

import type { TerminalPreviewResponse } from "../../shared/api-contract";

import { api } from "../api/client";
import { createRequestChannel } from "./request-channel";
import { messageFor } from "./request-errors";
import {
  INITIAL_RETRY_MS,
  isRetryableRequestError,
  nextRetryMs,
  retryDelayMs,
} from "./retry-policy";

export function useTerminalPreview(
  sessionId: string,
  connected: boolean,
  autoExpandKey: string | null = null,
) {
  const connection = useRef(connected);
  connection.current = connected;
  const autoExpanded = useRef<{ sessionId: string; key: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<TerminalPreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [activeSession, setActiveSession] = useState(sessionId);
  if (activeSession !== sessionId) {
    setActiveSession(sessionId);
    autoExpanded.current = null;
    setExpanded(false);
    setPreview(null);
    setError(null);
    setBusy(false);
  }
  useEffect(() => {
    if (!connected || autoExpandKey === null) return;
    if (autoExpanded.current?.sessionId === sessionId && autoExpanded.current.key === autoExpandKey)
      return;
    autoExpanded.current = { sessionId, key: autoExpandKey };
    setExpanded(true);
  }, [sessionId, connected, autoExpandKey]);
  useEffect(() => {
    const visibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    if (!connected) {
      setExpanded(false);
      setBusy(false);
      setPreview(null);
      setError(null);
    }
    if (!connected || !expanded || !visible) return;
    const channel = createRequestChannel();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry = INITIAL_RETRY_MS;
    const capture = async () => {
      const request = channel.begin();
      setBusy(true);
      setError(null);
      let delay: number | null = 1000;
      try {
        const next = await api.terminalPreview(sessionId, request.signal);
        if (!request.isCurrent()) return;
        setPreview((current) =>
          current?.content === next.content && current.truncated === next.truncated
            ? current
            : next,
        );
        retry = INITIAL_RETRY_MS;
      } catch (reason) {
        if (!request.isCurrent()) return;
        setError(messageFor(reason));
        delay = isRetryableRequestError(reason) ? retryDelayMs(retry) : null;
        retry = nextRetryMs(retry);
      } finally {
        if (!disposed && request.isCurrent()) {
          setBusy(false);
          if (delay !== null) timer = setTimeout(() => void capture(), delay);
        }
      }
    };
    void capture();
    return () => {
      disposed = true;
      channel.cancel();
      clearTimeout(timer);
      setBusy(false);
    };
  }, [sessionId, connected, expanded, visible]);
  return {
    preview,
    previewBusy: busy,
    previewError: error,
    previewExpanded: expanded,
    onExpandPreview: () => {
      if (connection.current) setExpanded(true);
    },
    onTogglePreview: () => {
      if (connection.current) setExpanded((value) => !value);
    },
    onDismissPreviewError: () => setError(null),
  };
}

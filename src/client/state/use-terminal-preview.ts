import { useEffect, useRef, useState } from "react";

import type { TerminalPreviewSnapshot } from "../../shared/api-contract";

import { connectTerminalPreview } from "../api/terminal-preview";
import { INITIAL_RETRY_MS, nextRetryMs, retryDelayMs } from "./retry-policy";
import { applyPreview } from "./terminal-preview-patch";

export function useTerminalPreview(
  sessionId: string,
  connected: boolean,
  autoExpandKey: string | null = null,
) {
  const connection = useRef(connected);
  connection.current = connected;
  const autoExpanded = useRef<{ sessionId: string; key: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<TerminalPreviewSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [activeSession, setActiveSession] = useState(sessionId);
  if (activeSession !== sessionId) {
    setActiveSession(sessionId);
    autoExpanded.current = null;
    setExpanded(false);
    setPreview(null);
    setStopped(false);
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
      setStopped(false);
      setError(null);
    }
    if (!connected || !expanded || !visible) return;
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let close: (() => void) | undefined;
    let retry = INITIAL_RETRY_MS;
    const connect = () => {
      if (disposed) return;
      const current = ++generation;
      let confirmed: TerminalPreviewSnapshot | null = null;
      setBusy(true);
      setError(null);
      const failed = (message: string, retryable: boolean) => {
        if (disposed || generation !== current) return;
        ++generation;
        setBusy(false);
        setError(message);
        setStopped(true);
        if (retryable) {
          timer = setTimeout(connect, retryDelayMs(retry));
          retry = nextRetryMs(retry);
        }
      };
      try {
        close = connectTerminalPreview(sessionId, {
          frame(next) {
            if (disposed || generation !== current) return true;
            const applied = applyPreview(confirmed, next);
            if (!applied) return false;
            confirmed = applied;
            setPreview(applied);
            setStopped(false);
            setBusy(false);
            setError(null);
            retry = INITIAL_RETRY_MS;
            return true;
          },
          failed,
        });
      } catch {
        failed("Terminal preview connection failed", true);
      }
    };
    connect();
    return () => {
      disposed = true;
      ++generation;
      close?.();
      clearTimeout(timer);
      setBusy(false);
    };
  }, [sessionId, connected, expanded, visible, retryKey]);
  return {
    preview,
    previewBusy: busy,
    previewStopped: stopped,
    onRetryPreview: () => {
      if (connection.current && expanded && visible && !busy) setRetryKey((value) => value + 1);
    },
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

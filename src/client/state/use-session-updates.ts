import { useEffect, useRef } from "react";

import type {
  SessionUpdatesResponse,
  TimelineCursor,
  UpdateRevision,
} from "../../shared/api-contract";

import { api } from "../api/client";
import { createRequestChannel } from "./request-channel";
import { isAbort, isTimelineConflict } from "./request-errors";
import {
  INITIAL_RETRY_MS,
  isRetryableRequestError,
  nextRetryMs,
  waitForRetry,
} from "./retry-policy";

export interface UpdatesSnapshot {
  readonly cursor: TimelineCursor;
  readonly updateRevision: UpdateRevision;
}

interface SessionUpdatesOptions {
  readonly sessionId: string;
  readonly enabled: boolean;
  readonly snapshot: UpdatesSnapshot | null;
  readonly onUpdate: (
    response: SessionUpdatesResponse,
    expected: UpdatesSnapshot,
  ) => Promise<void> | void;
  readonly onTimelineConflict: () => void;
  readonly onError: (reason: unknown, terminal: boolean) => void;
  readonly onSuccess?: () => void;
}

export function useSessionUpdates({
  sessionId,
  enabled,
  snapshot,
  onUpdate,
  onTimelineConflict,
  onError,
  onSuccess,
}: SessionUpdatesOptions): void {
  const callbacks = useRef({ onUpdate, onTimelineConflict, onError, onSuccess });
  callbacks.current = { onUpdate, onTimelineConflict, onError, onSuccess };

  const cursor = snapshot?.cursor;
  const updateRevision = snapshot?.updateRevision;
  useEffect(() => {
    if (!enabled || cursor === undefined || updateRevision === undefined) return;
    let disposed = false;
    const channel = createRequestChannel();
    let controller: AbortController | null = null;
    let retryMs = INITIAL_RETRY_MS;
    let wakeVisible: (() => void) | null = null;

    const onVisibility = () => {
      if (document.hidden) controller?.abort();
      else wakeVisible?.();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const run = async () => {
      while (!disposed) {
        if (document.hidden) {
          await new Promise<void>((resolve) => {
            wakeVisible = resolve;
          });
          wakeVisible = null;
          if (disposed) return;
        }
        const expected = { cursor, updateRevision };
        const request = channel.begin();
        controller = request.controller;
        try {
          const response = await api.updates(
            sessionId,
            {
              cursor: expected.cursor,
              after: expected.updateRevision,
            },
            controller.signal,
          );
          if (disposed || !request.isCurrent()) continue;
          retryMs = INITIAL_RETRY_MS;
          callbacks.current.onSuccess?.();
          if (response !== null) {
            await callbacks.current.onUpdate(response, expected);
            return;
          }
        } catch (reason) {
          if (disposed) return;
          if (!request.isCurrent() || isAbort(reason)) continue;
          if (isTimelineConflict(reason)) {
            callbacks.current.onTimelineConflict();
            return;
          }
          const retryable = isRetryableRequestError(reason);
          callbacks.current.onError(reason, !retryable);
          if (!retryable) return;
          try {
            await waitForRetry(retryMs, controller.signal);
          } catch {
            if (disposed) return;
            continue;
          }
          retryMs = nextRetryMs(retryMs);
        } finally {
          controller = null;
        }
      }
    };

    void run();
    return () => {
      disposed = true;
      channel.cancel();
      wakeVisible?.();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, sessionId, cursor, updateRevision]);
}

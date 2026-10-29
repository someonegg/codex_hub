import { useEffect, useRef, useState } from "react";

import type { TimelineCursor } from "../../shared/api-contract";

import { createRequestChannel } from "./request-channel";
import { isTimelineConflict } from "./request-errors";

interface LazyDetailOptions<T> {
  enabled: boolean;
  cursor: TimelineCursor;
  load: (cursor: TimelineCursor, signal: AbortSignal) => Promise<T>;
  unavailableMessage: string;
  onTimelineConflict: () => void;
}

export function useLazyDetail<T>({
  enabled,
  cursor,
  load,
  unavailableMessage,
  onTimelineConflict,
}: LazyDetailOptions<T>) {
  const [result, setResult] = useState<{
    load: typeof load;
    detail: T;
  } | null>(null);
  const [failure, setFailure] = useState<{ message: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const channel = useRef(createRequestChannel());
  const callbacks = useRef(onTimelineConflict);
  callbacks.current = onTimelineConflict;
  // Appending timeline pages keeps the same detail scope. A new loader identifies a new item/session.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const detail = result?.load === load ? result.detail : null;
  useEffect(() => {
    if (!enabled || detail !== null) return;
    const requestChannel = channel.current;
    const request = requestChannel.begin();
    setFailure(null);
    const requestCursor = cursorRef.current;
    void load(requestCursor, request.signal)
      .then((value) => {
        if (request.isCurrent()) setResult({ load, detail: value });
      })
      .catch((reason: unknown) => {
        if (!request.isCurrent()) return;
        if (isTimelineConflict(reason)) {
          setFailure({ message: null });
          callbacks.current();
        } else setFailure({ message: reason instanceof Error ? reason.message : null });
      });
    return () => requestChannel.cancel();
  }, [detail, enabled, load, attempt]);
  return {
    detail,
    error: failure === null ? null : (failure.message ?? unavailableMessage),
    retry: () => setAttempt((value) => value + 1),
  };
}

import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionListResponse } from "../../shared/api-contract";

import { api } from "../api/client";
import { createRequestChannel } from "./request-channel";
import { messageFor } from "./request-errors";
import {
  INITIAL_RETRY_MS,
  isRetryableRequestError,
  nextRetryMs,
  waitForRetry,
} from "./retry-policy";

export function useSessionList() {
  const [list, setList] = useState<SessionListResponse | null>(null);
  const [listError, setError] = useState<string | null>(null);
  const revision = useRef<string | undefined>(undefined);
  const listRequest = useRef<AbortController | null>(null);
  const [connection, reconnect] = useState(0);
  const refresh = useCallback(() => {
    listRequest.current?.abort();
    revision.current = undefined;
    reconnect((value) => value + 1);
  }, []);

  useEffect(() => {
    const channel = createRequestChannel();
    const start = () => {
      channel.cancel();
      if (document.visibilityState === "hidden") return;
      const request = channel.begin();
      const controller = request.controller;
      listRequest.current = controller;
      void (async () => {
        let retryMs = INITIAL_RETRY_MS;
        while (!controller.signal.aborted) {
          try {
            const data = await api.sessions({ after: revision.current }, controller.signal);
            if (!request.isCurrent()) return;
            if (data) {
              revision.current = data.revision;
              setList((previous) => {
                const times = new Map(
                  previous?.sessions.map((session) => [session.id, session.updatedAt]),
                );
                return {
                  ...data,
                  sessions: data.sessions.map((session) => ({
                    ...session,
                    updatedAt: newerTime(times.get(session.id) ?? null, session.updatedAt),
                  })),
                };
              });
            }
            setError(null);
            retryMs = INITIAL_RETRY_MS;
          } catch (reason) {
            if (!request.isCurrent()) return;
            setError(messageFor(reason));
            if (!isRetryableRequestError(reason)) return;
            try {
              await waitForRetry(retryMs, controller.signal);
            } catch {
              return;
            }
            retryMs = nextRetryMs(retryMs);
          }
        }
      })();
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => {
      channel.cancel();
      document.removeEventListener("visibilitychange", start);
    };
  }, [connection]);

  const reportUpdatedAt = useCallback((id: string, updatedAt: string | null) => {
    setList((previous) => {
      if (previous === null) return previous;
      const index = previous.sessions.findIndex((session) => session.id === id);
      if (index === -1) return previous;
      const session = previous.sessions[index]!;
      const next = newerTime(session.updatedAt, updatedAt);
      if (next === session.updatedAt) return previous;
      const sessions = [...previous.sessions];
      sessions[index] = { ...session, updatedAt: next };
      return { ...previous, sessions };
    });
  }, []);
  return {
    list,
    reportUpdatedAt,
    listError,
    retryList: refresh,
    listLoading: list === null && listError === null,
    refresh,
    clearListError: () => {
      setError(null);
    },
  };
}

function newerTime(previous: string | null, incoming: string | null): string | null {
  const next = incoming === null ? NaN : Date.parse(incoming);
  if (!Number.isFinite(next)) return previous;
  const current = previous === null ? NaN : Date.parse(previous);
  return !Number.isFinite(current) || next > current ? incoming : previous;
}

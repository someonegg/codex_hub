import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionMessagesResponse } from "../../shared/api-contract";

import { api, ApiClientError } from "../api/client";
import { isAbort, messageFor } from "./request-errors";
import {
  INITIAL_RETRY_MS,
  isRetryableRequestError,
  nextRetryMs,
  waitForRetry,
} from "./retry-policy";

type Operation = "open" | "page" | "poll" | "reload" | null;
interface ActiveRequest {
  controller: AbortController;
  operation: Exclude<Operation, null>;
}
interface ReadState {
  page: SessionMessagesResponse | null;
  operation: Operation;
  error: string | null;
  retrying: boolean;
  missing: boolean;
}
const initial: ReadState = {
  page: null,
  operation: null,
  error: null,
  retrying: false,
  missing: false,
};

export function useSessionReader(sessionId: string) {
  const [state, setState] = useState(initial);
  const current = useRef(state);
  current.current = state;
  const active = useRef<ActiveRequest | null>(null);
  const suspended = useRef<Exclude<Operation, null> | null>(null);
  const [visible, setVisible] = useState(() => !document.hidden);

  const read = useCallback(
    async (operation: Exclude<Operation, null>) => {
      if (active.current) return false;
      if (document.hidden) {
        suspended.current = operation;
        return false;
      }
      suspended.current = null;
      const controller = new AbortController();
      const request = { controller, operation };
      active.current = request;
      const replace = operation === "open" || operation === "reload";
      let page = replace ? null : current.current.page;
      let recovered = false;
      let retryMs = INITIAL_RETRY_MS;
      setState((s) => ({ ...s, operation, error: null, retrying: false }));
      try {
        for (;;) {
          try {
            const result = await api.messages(
              sessionId,
              {
                after: page?.nextAfter ?? 0,
                limit: 300,
                wait: operation === "poll" && !recovered,
                stateRevision: page?.stateRevision,
              },
              controller.signal,
            );
            if (controller.signal.aborted) return false;
            let nextPage: SessionMessagesResponse | null = null;
            if (result) {
              nextPage = { ...result };
              if (!replace && !recovered) {
                nextPage.items = [...(page?.items ?? []), ...result.items];
              }
            }
            setState((s) => ({
              ...s,
              page: nextPage ?? s.page,
              operation: null,
              error: null,
              retrying: false,
              missing: false,
            }));
            return true;
          } catch (reason) {
            if (controller.signal.aborted || isAbort(reason)) return false;
            if (
              reason instanceof ApiClientError &&
              reason.code === "after_out_of_range" &&
              !recovered
            ) {
              page = null;
              recovered = true;
              continue;
            }
            if (!isRetryableRequestError(reason)) throw reason;
            setState((s) => ({ ...s, error: messageFor(reason), retrying: true }));
            await waitForRetry(retryMs, controller.signal);
            retryMs = nextRetryMs(retryMs);
          }
        }
      } catch (reason) {
        if (!controller.signal.aborted)
          setState((s) => ({
            ...s,
            operation: null,
            error: messageFor(reason),
            retrying: false,
            missing: reason instanceof ApiClientError && reason.code === "session_not_found",
          }));
        return false;
      } finally {
        if (active.current === request) active.current = null;
      }
    },
    [sessionId],
  );

  useEffect(() => {
    suspended.current = null;
    setState(initial);
    if (!document.hidden) void read("open");
    return () => {
      active.current?.controller.abort();
      active.current = null;
      suspended.current = null;
    };
  }, [read]);

  useEffect(() => {
    const visibility = () => {
      setVisible(!document.hidden);
      if (document.hidden) {
        if (active.current) suspended.current = active.current.operation;
        active.current?.controller.abort();
        active.current = null;
        setState((s) => ({ ...s, operation: null, retrying: false }));
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);

  useEffect(() => {
    if (!visible || state.operation) return;
    if (suspended.current) {
      void read(suspended.current);
      return;
    }
    if (state.error || state.page?.hasMore || state.page?.session.status === "archived") return;
    // The same request slot serializes history pagination and tail waiting.
    void read(state.page ? "poll" : "open");
  }, [read, visible, state]);

  const loadMore = useCallback(
    () => (current.current.page?.hasMore ? read("page") : Promise.resolve(false)),
    [read],
  );
  const refreshLatest = useCallback(() => {
    active.current?.controller.abort();
    active.current = null;
    return read("reload");
  }, [read]);
  return {
    context: state.page,
    items: state.page?.items ?? [],
    interaction: state.page?.interaction ?? null,
    operation: state.operation,
    readerLoading: state.operation !== null && state.operation !== "poll",
    readerError: state.error,
    readerRetrying: state.retrying,
    missing: state.missing,
    loadMore,
    retryOpen: refreshLatest,
    refreshLatest,
  };
}

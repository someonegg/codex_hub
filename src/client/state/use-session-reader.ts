import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type {
  InteractionResponse,
  ItemPageResponse,
  SessionUpdatesResponse,
} from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";

import { api, ApiClientError } from "../api/client";
import { createRequestChannel } from "./request-channel";
import { isAbort, isTimelineConflict, messageFor } from "./request-errors";
import {
  INITIAL_RETRY_MS,
  isRetryableRequestError,
  nextRetryMs,
  waitForRetry,
} from "./retry-policy";
import type { ReaderContext } from "./session-reader-state";
import { type UpdatesSnapshot, useSessionUpdates } from "./use-session-updates";

const TIMELINE_PAGE_SIZE = 300;

type ReaderOperation = "open" | "page" | "poll" | "reload" | null;

interface ReaderState {
  operation: ReaderOperation;
  context: ReaderContext | null;
  items: TimelineItem[];
  interaction: InteractionResponse | null;
  error: string | null;
  missing: boolean;
  timelineConflict: boolean;
  timelineRenderGeneration: number;
}

type ReaderAction =
  | { type: "start"; operation: Exclude<ReaderOperation, null>; preserve: boolean }
  | { type: "success"; page: ItemPageResponse; replace: boolean }
  | { type: "updates-success"; response: SessionUpdatesResponse }
  | { type: "updates-error"; error: string }
  | { type: "page-retry"; error: string }
  | { type: "failure"; error: string; missing: boolean }
  | { type: "timeline-conflict" }
  | { type: "clear-error" };

interface ActiveRequest {
  controller: AbortController;
  generation: number;
}

interface PageRequestMode {
  readonly preserveCurrent: boolean;
  readonly replaceItems: boolean;
}

const initialState: ReaderState = {
  operation: null,
  context: null,
  items: [],
  interaction: null,
  error: null,
  missing: false,
  timelineConflict: false,
  timelineRenderGeneration: 0,
};

export function useSessionReader(sessionId: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const active = useRef<ActiveRequest | null>(null);
  const channel = useRef(createRequestChannel());
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const markTimelineConflict = useCallback(() => {
    generation.current += 1;
    active.current?.controller.abort();
    active.current = null;
    dispatch({ type: "timeline-conflict" });
  }, []);

  const isCurrent = useCallback(
    (request: ActiveRequest) =>
      active.current === request &&
      request.generation === generation.current &&
      !request.controller.signal.aborted,
    [],
  );

  const requestPage = useCallback(
    async (
      operation: Exclude<ReaderOperation, null>,
      cursor: ReaderContext["cursor"] | undefined,
      mode: PageRequestMode,
    ): Promise<boolean> => {
      if (active.current !== null) return false;
      const request: ActiveRequest = {
        controller: channel.current.begin().controller,
        generation: generation.current,
      };
      active.current = request;
      dispatch({ type: "start", operation, preserve: mode.preserveCurrent });
      let retryMs = INITIAL_RETRY_MS;
      try {
        while (isCurrent(request)) {
          try {
            const page = await api.items(
              sessionId,
              {
                cursor,
                limit: TIMELINE_PAGE_SIZE,
              },
              request.controller.signal,
            );
            if (!isCurrent(request)) return false;
            dispatch({ type: "success", page, replace: mode.replaceItems });
            return true;
          } catch (reason) {
            if (!isCurrent(request) || isAbort(reason)) return false;
            if (isTimelineConflict(reason)) {
              markTimelineConflict();
              return false;
            }
            const retryablePagination =
              (operation === "page" || operation === "poll") && isRetryableRequestError(reason);
            if (!retryablePagination) throw reason;
            dispatch({ type: "page-retry", error: messageFor(reason) });
            await waitForRetry(retryMs, request.controller.signal);
            retryMs = nextRetryMs(retryMs);
          }
        }
        return false;
      } catch (reason) {
        if (!isCurrent(request) || isAbort(reason)) return false;
        const missing =
          reason instanceof ApiClientError &&
          reason.status === 404 &&
          reason.code === "session_not_found";
        dispatch({ type: "failure", error: messageFor(reason), missing });
        return false;
      } finally {
        if (active.current === request) active.current = null;
      }
    },
    [isCurrent, markTimelineConflict, sessionId],
  );

  useEffect(() => {
    generation.current += 1;
    active.current?.controller.abort();
    active.current = null;
    void requestPage("open", undefined, {
      preserveCurrent: false,
      replaceItems: true,
    });
    return () => {
      generation.current += 1;
      active.current?.controller.abort();
      active.current = null;
    };
  }, [requestPage]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (current.context === null || !current.context.hasMore || current.timelineConflict) {
      return Promise.resolve(false);
    }
    return requestPage("page", current.context.cursor, {
      preserveCurrent: true,
      replaceItems: false,
    });
  }, [requestPage]);

  const retryOpen = useCallback(
    () =>
      requestPage("open", undefined, {
        preserveCurrent: false,
        replaceItems: true,
      }),
    [requestPage],
  );

  const reloadLatest = useCallback(() => {
    active.current?.controller.abort();
    active.current = null;
    generation.current += 1;
    setAutoRefreshEnabled(true);
    return requestPage("reload", undefined, {
      preserveCurrent: true,
      replaceItems: true,
    });
  }, [requestPage]);

  const onSessionUpdates = useCallback(
    async (response: SessionUpdatesResponse, expected: UpdatesSnapshot) => {
      const current = stateRef.current;
      if (
        current.context === null ||
        current.timelineConflict ||
        current.context.cursor !== expected.cursor ||
        current.context.updateRevision !== expected.updateRevision ||
        response.cursor !== expected.cursor
      )
        return;
      if (active.current !== null) return;
      if (response.hasMore) {
        const version = generation.current;
        const loaded = await requestPage("poll", expected.cursor, {
          preserveCurrent: true,
          replaceItems: false,
        });
        if (version === generation.current && !loaded && !stateRef.current.timelineConflict)
          setAutoRefreshEnabled(false);
        return;
      }
      dispatch({ type: "updates-success", response });
    },
    [requestPage],
  );

  useSessionUpdates({
    sessionId,
    enabled:
      autoRefreshEnabled &&
      state.operation === null &&
      state.context !== null &&
      state.context.session.id === sessionId &&
      state.context.session.status !== "archived" &&
      !state.timelineConflict,
    snapshot:
      state.context === null
        ? null
        : {
            cursor: state.context.cursor,
            updateRevision: state.context.updateRevision,
          },
    onUpdate: onSessionUpdates,
    onTimelineConflict: markTimelineConflict,
    onError: (reason, terminal) => {
      dispatch({ type: "updates-error", error: messageFor(reason) });
      if (terminal) setAutoRefreshEnabled(false);
    },
    onSuccess: () => dispatch({ type: "clear-error" }),
  });

  return {
    context: state.context,
    items: state.items,
    interaction: state.interaction,
    operation: state.operation,
    readerLoading:
      state.operation === "open" || state.operation === "page" || state.operation === "reload",
    readerError: state.error,
    missing: state.missing,
    timelineConflict: state.timelineConflict,
    timelineRenderGeneration: state.timelineRenderGeneration,
    clearReaderError: () => dispatch({ type: "clear-error" }),
    loadMore,
    retryOpen,
    markTimelineConflict,
    refreshLatest: reloadLatest,
  };
}

function reducer(state: ReaderState, action: ReaderAction): ReaderState {
  switch (action.type) {
    case "start":
      return action.preserve
        ? { ...state, operation: action.operation, error: null }
        : {
            ...initialState,
            operation: action.operation,
            timelineRenderGeneration: state.timelineRenderGeneration,
          };
    case "success": {
      const context: ReaderContext = {
        session: action.page.session,
        cursor: action.page.cursor,
        hasMore: action.page.hasMore,
        updateRevision: action.page.updateRevision,
      };
      return {
        ...state,
        operation: null,
        context,
        items: action.replace ? action.page.items : appendUnique(state.items, action.page.items),
        interaction: action.page.interaction,
        error: null,
        missing: false,
        timelineConflict: false,
        timelineRenderGeneration:
          action.replace && state.timelineConflict
            ? state.timelineRenderGeneration + 1
            : state.timelineRenderGeneration,
      };
    }
    case "updates-success":
      if (state.context === null || action.response.cursor !== state.context.cursor) return state;
      return {
        ...state,
        context: {
          session: action.response.session,
          cursor: action.response.cursor,
          hasMore: action.response.hasMore,
          updateRevision: action.response.updateRevision,
        },
        interaction: action.response.interaction,
        error: null,
        missing: false,
      };
    case "updates-error":
      return { ...state, error: action.error };
    case "page-retry":
      return { ...state, error: action.error };
    case "failure":
      return { ...state, operation: null, error: action.error, missing: action.missing };
    case "timeline-conflict":
      return { ...state, operation: null, error: null, timelineConflict: true };
    case "clear-error":
      return state.error === null ? state : { ...state, error: null };
  }
}

function appendUnique(existing: TimelineItem[], incoming: TimelineItem[]): TimelineItem[] {
  const seen = new Set(existing.map((item) => item.id));
  const additions = incoming.filter((item) => !seen.has(item.id));
  return additions.length === 0 ? existing : [...existing, ...additions];
}

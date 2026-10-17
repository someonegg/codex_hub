import { useCallback, useEffect, useRef, useState } from "react";

import type { HubOperation } from "../../shared/api-contract";

import { api, ApiClientError } from "../api/client";
import { createRequestChannel } from "./request-channel";
import { messageFor } from "./request-errors";
import {
  INITIAL_RETRY_MS,
  isRetryableRequestError,
  nextRetryMs,
  retryDelayMs,
} from "./retry-policy";

type CommonState = { error: string | null; errorPhase: "submit" | "query" | null };
type State = CommonState &
  (
    | { lifecycle: "idle" | "submitting"; operation: null }
    | { lifecycle: "recovering"; operation: null; operationId: string }
    | { lifecycle: "tracking"; operation: HubOperation }
    | { lifecycle: "stopped"; operation: HubOperation | null; operationId: string }
    | { lifecycle: "terminal"; operation: HubOperation }
  );
const initial = {
  lifecycle: "idle",
  operation: null,
  error: null,
  errorPhase: null,
} satisfies State;
type Action =
  | { type: "reset"; id: string | null }
  | { type: "submit" }
  | { type: "receive"; operation: HubOperation }
  | {
      type: "failure";
      phase: "submit" | "query";
      error: string;
      missing?: boolean;
      retryable?: boolean;
    };
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return action.id ? { ...initial, lifecycle: "recovering", operationId: action.id } : initial;
    case "submit":
      return { ...initial, lifecycle: "submitting" };
    case "receive":
      return action.operation.status === "pending"
        ? { ...initial, lifecycle: "tracking", operation: action.operation }
        : { ...initial, lifecycle: "terminal", operation: action.operation };
    case "failure": {
      if (action.phase === "submit" || action.missing)
        return { ...initial, error: action.error, errorPhase: action.phase };
      const id = operationId(state);
      if (!id) return state;
      const failure = { error: action.error, errorPhase: "query" as const };
      if (!action.retryable)
        return { ...failure, lifecycle: "stopped", operation: state.operation, operationId: id };
      return state.operation
        ? { ...failure, lifecycle: "tracking", operation: state.operation }
        : { ...failure, lifecycle: "recovering", operation: null, operationId: id };
    }
  }
}

function operationId(state: State): string | null {
  if (state.lifecycle === "tracking") return state.operation.operationId;
  return "operationId" in state ? state.operationId : null;
}

interface OperationRun {
  disposed: boolean;
  querying: boolean;
  reported: boolean;
  retry: number;
  timer?: ReturnType<typeof setTimeout>;
  channel: ReturnType<typeof createRequestChannel>;
}

export function useHubOperation(scope: string, onSuccess: (operation: HubOperation) => void) {
  const key = `codex-hub.operation.${scope}`;
  const [state, setState] = useState<State>(initial);
  const current = useRef<State>(initial);
  const runtime = useRef<OperationRun | null>(null);
  const success = useRef(onSuccess);
  success.current = onSuccess;
  const query = useRef<() => Promise<void>>(async () => {});
  const commit = (run: OperationRun, action: Action) => {
    if (runtime.current !== run || run.disposed) return;
    current.current = reducer(current.current, action);
    setState(current.current);
  };
  const removeMarker = useCallback(() => {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* Optional storage. */
    }
  }, [key]);
  const receive = useCallback(
    (run: OperationRun, next: HubOperation) => {
      const terminal = next.status !== "pending";
      if (terminal) removeMarker();
      commit(run, { type: "receive", operation: next });
      if (next.status === "succeeded" && !run.reported) {
        run.reported = true;
        success.current(next);
      }
    },
    [removeMarker],
  );
  const schedule = (run: OperationRun, delay: number) => {
    clearTimeout(run.timer);
    if (
      runtime.current === run &&
      !run.disposed &&
      operationId(current.current) &&
      document.visibilityState !== "hidden"
    )
      run.timer = setTimeout(() => void query.current(), delay);
  };
  query.current = async () => {
    const run = runtime.current;
    if (
      !run ||
      run.disposed ||
      run.querying ||
      document.visibilityState === "hidden" ||
      !operationId(current.current)
    )
      return;
    clearTimeout(run.timer);
    run.querying = true;
    const request = run.channel.begin();
    let delay: number | null = null;
    try {
      const next = await api.operation(operationId(current.current)!, request.signal);
      if (!request.isCurrent() || runtime.current !== run) return;
      receive(run, next);
      run.retry = INITIAL_RETRY_MS;
      if (next.status === "pending") delay = 1000;
    } catch (reason) {
      if (!request.isCurrent() || runtime.current !== run) return;
      const missing = reason instanceof ApiClientError && reason.status === 404;
      const retryable = isRetryableRequestError(reason);
      if (missing) removeMarker();
      commit(run, {
        type: "failure",
        phase: "query",
        error: messageFor(reason),
        missing,
        retryable,
      });
      if (!missing && retryable) {
        delay = retryDelayMs(run.retry);
        run.retry = nextRetryMs(run.retry);
      }
    } finally {
      if (request.isCurrent()) run.querying = false;
      if (request.isCurrent() && delay !== null) schedule(run, delay);
    }
  };
  useEffect(() => {
    let id: string | null = null;
    try {
      id = sessionStorage.getItem(key);
    } catch {
      /* Optional storage. */
    }
    const run: OperationRun = {
      disposed: false,
      querying: false,
      reported: false,
      retry: INITIAL_RETRY_MS,
      channel: createRequestChannel(),
    };
    runtime.current = run;
    commit(run, { type: "reset", id });
    const visibility = () => {
      clearTimeout(run.timer);
      if (document.visibilityState === "hidden") {
        run.channel.cancel();
        run.querying = false;
      } else if (["recovering", "tracking"].includes(current.current.lifecycle)) {
        void query.current();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    if (id) void query.current();
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      run.disposed = true;
      run.channel.cancel();
      clearTimeout(run.timer);
    };
  }, [key]);
  const start = useCallback(
    async (submit: () => Promise<HubOperation>) => {
      const run = runtime.current;
      if (
        !run ||
        run.disposed ||
        current.current.lifecycle === "submitting" ||
        operationId(current.current)
      )
        return;
      run.reported = false;
      commit(run, { type: "submit" });
      try {
        const next = await submit();
        if (runtime.current !== run || run.disposed) return;
        try {
          sessionStorage.setItem(key, next.operationId);
        } catch {
          /* Optional storage. */
        }
        receive(run, next);
        if (next.status === "pending") schedule(run, 1000);
      } catch (reason) {
        commit(run, { type: "failure", phase: "submit", error: messageFor(reason) });
      }
    },
    [key, receive],
  );
  return {
    ...state,
    operationId: operationId(state),
    start,
    check: () => void query.current(),
    canCheck: operationId(state) !== null,
    busy: state.lifecycle === "submitting" || operationId(state) !== null,
  };
}

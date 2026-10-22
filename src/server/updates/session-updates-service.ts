import type {
  InteractionResponse,
  SessionUpdatesQuery,
  SessionUpdatesResponse,
} from "../../shared/api-contract.js";
import type { SessionReader } from "../application/session-reader.js";
import { assembleSessionResponse } from "../application/session-response.js";
import type { SessionInteractionService } from "../interaction/interaction-service.js";
import {
  createProcessUpdateRevisionFactory,
  type UpdateRevisionFactory,
  type UpdateRevisionSession,
} from "./update-revision.js";

export const UPDATES_PROBE_INTERVAL_MS = 1_500;
export const UPDATES_WAIT_TIMEOUT_MS = 25_000;
export const MAX_UPDATES_WAITERS = 100;
export const MAX_UPDATES_WAITERS_PER_SESSION = 10;

export class SessionUpdatesError extends Error {
  constructor(
    readonly code: "session_not_found" | "updates_capacity_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "SessionUpdatesError";
  }
}

export interface SessionUpdatesServiceOptions {
  readonly interaction?: Pick<SessionInteractionService, "describeSnapshot">;
  readonly createRevision?: UpdateRevisionFactory;
  readonly probeIntervalMs?: number;
  readonly waitTimeoutMs?: number;
  readonly maxWaiters?: number;
  readonly maxWaitersPerSession?: number;
  readonly now?: () => number;
}

interface WaiterEntry {
  readonly sessionId: string;
  readonly externalSignal?: AbortSignal;
  readonly externalAbort: () => void;
}

type SessionUpdatesReader = Pick<SessionReader, "getSessionUpdates">;

export class SessionUpdatesService {
  readonly #createRevision: UpdateRevisionFactory;
  readonly #probeIntervalMs: number;
  readonly #waitTimeoutMs: number;
  readonly #maxWaiters: number;
  readonly #maxWaitersPerSession: number;
  readonly #now: () => number;
  readonly #waiters = new Map<AbortController, WaiterEntry>();
  readonly #waitersBySession = new Map<string, number>();
  #closed = false;

  constructor(
    private readonly sessions: SessionUpdatesReader,
    private readonly options: SessionUpdatesServiceOptions = {},
  ) {
    this.#createRevision = options.createRevision ?? createProcessUpdateRevisionFactory();
    this.#probeIntervalMs = options.probeIntervalMs ?? UPDATES_PROBE_INTERVAL_MS;
    this.#waitTimeoutMs = options.waitTimeoutMs ?? UPDATES_WAIT_TIMEOUT_MS;
    this.#maxWaiters = options.maxWaiters ?? MAX_UPDATES_WAITERS;
    this.#maxWaitersPerSession = options.maxWaitersPerSession ?? MAX_UPDATES_WAITERS_PER_SESSION;
    this.#now = options.now ?? Date.now;
  }

  revision(session: UpdateRevisionSession, interaction: InteractionResponse) {
    return this.#createRevision(session, interaction);
  }

  async wait(
    sessionId: string,
    query: SessionUpdatesQuery,
    signal?: AbortSignal,
  ): Promise<SessionUpdatesResponse | null> {
    this.#throwIfAborted(signal);
    const initial = await this.#probe(sessionId, query);
    if (initial.updateRevision !== query.after || initial.hasMore) return initial;
    if (initial.session.status === "archived") return null;
    const waiter = this.#acquire(sessionId, signal);
    const deadline = this.#now() + this.#waitTimeoutMs;
    try {
      while (true) {
        const remaining = deadline - this.#now();
        if (remaining <= 0) return null;
        await delay(Math.min(this.#probeIntervalMs, remaining), waiter.signal);
        const current = await this.#probe(sessionId, query);
        if (current.updateRevision !== query.after || current.hasMore) return current;
      }
    } finally {
      this.#release(waiter);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.keys()) waiter.abort();
  }

  async #probe(sessionId: string, query: SessionUpdatesQuery): Promise<SessionUpdatesResponse> {
    this.#throwIfAborted();
    const snapshot = await this.sessions.getSessionUpdates(sessionId, query.cursor);
    if (snapshot === null) {
      throw new SessionUpdatesError("session_not_found", "Session not found");
    }
    return assembleSessionResponse(snapshot, this.options.interaction, this.#createRevision);
  }

  #acquire(sessionId: string, signal?: AbortSignal): AbortController {
    this.#throwIfAborted(signal);
    const sessionCount = this.#waitersBySession.get(sessionId) ?? 0;
    if (this.#waiters.size >= this.#maxWaiters || sessionCount >= this.#maxWaitersPerSession) {
      throw new SessionUpdatesError(
        "updates_capacity_exceeded",
        "Too many automatic update requests are already waiting",
      );
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort(signal.reason);
    this.#waiters.set(controller, {
      sessionId,
      externalSignal: signal,
      externalAbort: abort,
    });
    this.#waitersBySession.set(sessionId, sessionCount + 1);
    return controller;
  }

  #release(controller: AbortController): void {
    const entry = this.#waiters.get(controller);
    if (entry === undefined) return;
    this.#waiters.delete(controller);
    const { sessionId } = entry;
    const count = (this.#waitersBySession.get(sessionId) ?? 1) - 1;
    if (count === 0) this.#waitersBySession.delete(sessionId);
    else this.#waitersBySession.set(sessionId, count);
    entry.externalSignal?.removeEventListener("abort", entry.externalAbort);
  }

  #throwIfAborted(signal?: AbortSignal): void {
    if (this.#closed || signal?.aborted) throw abortError();
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

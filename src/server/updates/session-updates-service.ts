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
}

interface Waiter {
  readonly query: SessionUpdatesQuery;
  readonly finish: (value: SessionUpdatesResponse | null) => void;
  readonly fail: (error: unknown) => void;
}
type UpdatesProbe = (query: SessionUpdatesQuery) => SessionUpdatesResponse;

interface ProbeGroup {
  readonly waiters: Set<Waiter>;
  pending: Promise<UpdatesProbe> | null;
  timer?: ReturnType<typeof setTimeout>;
}
type SessionUpdatesReader = Pick<SessionReader, "readSessionUpdates">;

export class SessionUpdatesService {
  readonly #createRevision: UpdateRevisionFactory;
  readonly #probeIntervalMs: number;
  readonly #waitTimeoutMs: number;
  readonly #maxWaiters: number;
  readonly #maxWaitersPerSession: number;
  readonly #groups = new Map<string, ProbeGroup>();
  #waiterCount = 0;
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
  }

  revision(session: UpdateRevisionSession, interaction: InteractionResponse) {
    return this.#createRevision(session, interaction);
  }

  async wait(
    sessionId: string,
    query: SessionUpdatesQuery,
    signal?: AbortSignal,
  ): Promise<SessionUpdatesResponse | null> {
    if (this.#closed || signal?.aborted) throw abortError();
    let group = this.#groups.get(sessionId);
    if (
      this.#waiterCount >= this.#maxWaiters ||
      (group?.waiters.size ?? 0) >= this.#maxWaitersPerSession
    )
      throw new SessionUpdatesError(
        "updates_capacity_exceeded",
        "Too many automatic update requests are already waiting",
      );
    if (!group) {
      group = { waiters: new Set(), pending: null };
      this.#groups.set(sessionId, group);
    }
    const current = group;
    this.#waiterCount++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        current.waiters.delete(waiter);
        this.#waiterCount--;
        if (current.waiters.size === 0) {
          clearTimeout(current.timer);
          if (this.#groups.get(sessionId) === current) this.#groups.delete(sessionId);
        }
      };
      const waiter: Waiter = {
        query,
        finish: (value) => {
          if (!settled) {
            cleanup();
            resolve(value);
          }
        },
        fail: (error) => {
          if (!settled) {
            cleanup();
            reject(error);
          }
        },
      };
      const abort = () => waiter.fail(abortError());
      const timeout = setTimeout(() => waiter.finish(null), this.#waitTimeoutMs);
      current.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      // Only in-flight initial reads are reused, never completed runtime results.
      void this.#read(sessionId, current).then(
        (read) => {
          if (current.waiters.has(waiter)) this.#evaluate(waiter, read);
          this.#schedule(sessionId, current);
        },
        (error) => waiter.fail(error),
      );
    });
  }

  #evaluate(waiter: Waiter, read: UpdatesProbe) {
    try {
      const result = read(waiter.query);
      if (result.updateRevision !== waiter.query.after || result.hasMore) waiter.finish(result);
      else if (result.session.status === "archived") waiter.finish(null);
    } catch (error) {
      waiter.fail(error);
    }
  }

  #read(sessionId: string, group: ProbeGroup) {
    if (group.pending) return group.pending;
    const pending = (async () => {
      const read = await this.sessions.readSessionUpdates(sessionId);
      if (!read) throw new SessionUpdatesError("session_not_found", "Session not found");
      const assembled = await assembleSessionResponse(
        read.state,
        this.options.interaction,
        this.#createRevision,
      );
      return (query: SessionUpdatesQuery): SessionUpdatesResponse => {
        const progress = read(query.cursor);
        return { ...assembled, cursor: progress.cursor, hasMore: progress.hasMore };
      };
    })();
    group.pending = pending;
    const clearPending = () => {
      group.pending = null;
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  #schedule(sessionId: string, group: ProbeGroup) {
    if (this.#closed || !group.waiters.size || group.timer !== undefined || group.pending) return;
    group.timer = setTimeout(async () => {
      group.timer = undefined;
      // Requests joining during this read share its immutable snapshot.
      const waiters = [...group.waiters];
      try {
        const read = await this.#read(sessionId, group);
        for (const waiter of waiters) if (group.waiters.has(waiter)) this.#evaluate(waiter, read);
      } catch (error) {
        for (const waiter of waiters) waiter.fail(error);
      } finally {
        this.#schedule(sessionId, group);
      }
    }, this.#probeIntervalMs);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const group of this.#groups.values()) {
      clearTimeout(group.timer);
      for (const waiter of group.waiters) waiter.fail(abortError());
    }
  }
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

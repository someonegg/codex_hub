import type { SessionListResponse } from "../../shared/api-contract.js";
import type { SessionReader } from "../application/session-reader.js";
import {
  CATALOG_PROBE_INTERVAL_MS,
  CATALOG_WAIT_TIMEOUT_MS,
  MAX_CATALOG_WAITERS,
} from "./config.js";

export class CatalogCapacityError extends Error {}
interface Waiter {
  after: string;
  finish: (value: SessionListResponse | null) => void;
  fail: (reason: unknown) => void;
}

/** One probe loop for every waiting directory request. No loop when idle. */
export class SessionCatalogService {
  #waiters = new Set<Waiter>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #probe: Promise<SessionListResponse> | null = null;
  #closed = false;
  #probing = false;
  constructor(private readonly sessions: Pick<SessionReader, "refresh" | "list">) {}

  async wait(after?: string, signal?: AbortSignal): Promise<SessionListResponse | null> {
    this.#assertOpen(signal);
    const initial = await this.#read();
    this.#assertOpen(signal);
    if (initial.revision !== after) return initial;
    if (this.#waiters.size >= MAX_CATALOG_WAITERS)
      throw new CatalogCapacityError("Too many catalog requests are waiting; retry shortly");
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        this.#waiters.delete(waiter);
        if (this.#waiters.size === 0) {
          clearTimeout(this.#timer);
          this.#timer = undefined;
        }
      };
      const waiter: Waiter = {
        after,
        finish: (result) => {
          cleanup();
          resolve(result);
        },
        fail: (reason) => {
          cleanup();
          reject(reason);
        },
      };
      const abort = () => waiter.fail(new DOMException("Aborted", "AbortError"));
      const timeout = setTimeout(() => waiter.finish(null), CATALOG_WAIT_TIMEOUT_MS);
      this.#waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      this.#schedule();
    });
  }

  #assertOpen(signal?: AbortSignal) {
    if (this.#closed || signal?.aborted) throw new DOMException("Aborted", "AbortError");
  }
  #read(refresh = false) {
    if (this.#probe !== null) return this.#probe;
    this.#probe = (async () => {
      if (refresh) await this.sessions.refresh();
      return this.sessions.list();
    })();
    const probe = this.#probe;
    void probe.then(
      () => {
        if (this.#probe === probe) this.#probe = null;
      },
      () => {
        if (this.#probe === probe) this.#probe = null;
      },
    );
    return probe;
  }
  #schedule() {
    if (this.#closed || this.#probing || this.#timer !== undefined || this.#waiters.size === 0)
      return;
    this.#timer = setTimeout(async () => {
      this.#timer = undefined;
      this.#probing = true;
      try {
        const snapshot = await this.#read(true);
        for (const waiter of this.#waiters)
          if (waiter.after !== snapshot.revision) waiter.finish(snapshot);
      } catch (reason) {
        for (const waiter of this.#waiters) waiter.fail(reason);
      } finally {
        this.#probing = false;
        this.#schedule();
      }
    }, CATALOG_PROBE_INTERVAL_MS);
  }
  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const waiter of this.#waiters) waiter.finish(null);
  }
}

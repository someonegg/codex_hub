import { createHash, randomUUID } from "node:crypto";

import type {
  LineOperation,
  TerminalPreviewResponse,
  TerminalPreviewResult,
} from "../../shared/api-contract.js";
import { diffLines } from "./terminal-preview-diff.js";
import {
  createTmuxPreviewListener,
  type PreviewListener,
  type PreviewSubscription,
} from "./tmux-preview-listener.js";
import type { TmuxBinding } from "./transport.js";
import { InteractionTransportError } from "./transport.js";

export class PreviewCapacityError extends Error {}
interface State {
  binding: TmuxBinding;
  session: string;
  history: { baseRevision: string; revision: string; operations: LineOperation[] }[];
  guards: Map<string, () => void>;
  subscription: PreviewSubscription;
  snapshot?: TerminalPreviewResponse;
  dirty: boolean;
  listening: boolean;
  lifecycle: AbortController;
  active: number;
  task?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  idle?: ReturnType<typeof setTimeout>;
  error?: Error;
  listeners: Set<() => void>;
}
export class TerminalPreviewService {
  readonly #states = new Map<string, State>();
  readonly #identity = randomUUID();
  readonly #counts = new Map<string, number>();
  #waiters = 0;
  #closed = false;
  constructor(
    private readonly capture: (
      binding: TmuxBinding,
      assertOwner: () => void,
    ) => Promise<{ content: string; truncated: boolean }>,
    private readonly listen: PreviewListener = createTmuxPreviewListener(),
    private readonly resolveTarget?: (binding: TmuxBinding) => Promise<TmuxBinding | null>,
  ) {}

  async preview(
    session: string,
    binding: TmuxBinding,
    assertOwner: () => void,
    after?: string,
    signal?: AbortSignal,
  ): Promise<TerminalPreviewResult | null> {
    const key = JSON.stringify([binding.socketPath, binding.paneId]);
    const stateKey = JSON.stringify([session, key]);
    if (this.#closed || signal?.aborted) throw new DOMException("Aborted", "AbortError");
    let state = this.#states.get(stateKey);
    if (state && state.binding.sessionName !== binding.sessionName) {
      this.#fail(
        stateKey,
        state,
        new InteractionTransportError("command_failed", "The pane's tmux session changed"),
      );
      state = undefined;
    }
    if (!state) {
      state = {
        binding,
        session,
        history: [],
        guards: new Map(),
        subscription: undefined!,
        dirty: true,
        listening: false,
        lifecycle: new AbortController(),
        active: 0,
        listeners: new Set(),
      };
      this.#states.set(stateKey, state);
      const current = state;
      state.subscription = this.listen(
        binding,
        (pane) => {
          if (!pane || pane === binding.paneId) {
            current.dirty = true;
            this.#schedule(current);
          }
        },
        (error) =>
          this.#fail(
            stateKey,
            current,
            new InteractionTransportError("command_failed", error.message),
          ),
      );
    }
    state.guards.set(session, assertOwner);
    clearTimeout(state.idle);
    state.active++;
    const requestSignal = signal
      ? AbortSignal.any([signal, state.lifecycle.signal])
      : state.lifecycle.signal;
    try {
      await abortable(state.subscription.ready, requestSignal).catch((error: unknown) => {
        this.#check(state!, signal);
        throw error;
      });
      this.#check(state, signal);
      state.listening = true;
      assertOwner();
      if (!state.snapshot)
        await abortable(this.#capture(state), requestSignal).catch((error: unknown) => {
          this.#check(state!, signal);
          throw error;
        });
      this.#check(state, signal);
      assertOwner();
      const snapshot = () => {
        assertOwner();
        return this.#response(state!, after);
      };
      if (state.snapshot!.revision !== after) return snapshot();
      const count = this.#counts.get(session) ?? 0;
      if (this.#waiters >= 100 || count >= 10)
        throw new PreviewCapacityError("Too many terminal preview requests are waiting");
      this.#waiters++;
      this.#counts.set(session, count + 1);
      try {
        return await new Promise<TerminalPreviewResult | null>((resolve, reject) => {
          const finish = (error?: unknown, value: TerminalPreviewResult | null = null) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", aborted);
            state!.listeners.delete(changed);
            if (error) reject(error);
            else resolve(value);
          };
          const changed = () => {
            try {
              this.#check(state!, signal);
              const value = snapshot();
              if (value.revision !== after) finish(undefined, value);
            } catch (error) {
              finish(error);
            }
          };
          const aborted = () => finish(new DOMException("Aborted", "AbortError"));
          const timer = setTimeout(() => {
            try {
              assertOwner();
              finish();
            } catch (error) {
              finish(error);
            }
          }, 25000);
          state!.listeners.add(changed);
          signal?.addEventListener("abort", aborted, { once: true });
          changed();
        });
      } finally {
        this.#waiters--;
        const remaining = (this.#counts.get(session) ?? 1) - 1;
        if (remaining) this.#counts.set(session, remaining);
        else this.#counts.delete(session);
      }
    } finally {
      state.active--;
      if (!state.active && !state.error) {
        state.idle = setTimeout(() => this.#dispose(stateKey, state!), 10000);
        state.idle.unref?.();
      }
    }
  }
  invalidate(): void {
    for (const [key, state] of this.#states) {
      try {
        for (const guard of state.guards.values()) guard();
      } catch (error) {
        this.#fail(key, state, error as Error);
      }
    }
  }
  close(): void {
    this.#closed = true;
    for (const [key, state] of this.#states)
      this.#fail(key, state, new DOMException("Aborted", "AbortError"));
  }
  #response(state: State, after?: string): TerminalPreviewResult {
    const snapshot = state.snapshot!;
    if (!after || after === snapshot.revision) return snapshot;
    // Search backwards so repeated revisions use the nearest contiguous suffix.
    for (let i = state.history.length - 1; i >= 0; i--) {
      if (state.history[i]!.baseRevision !== after) continue;
      const chain = state.history.slice(i);
      let revision = after;
      for (const entry of chain) {
        if (entry.baseRevision !== revision) return snapshot;
        revision = entry.revision;
      }
      if (revision !== snapshot.revision) return snapshot;
      const delta = {
        baseRevision: after,
        revision,
        patches: chain.map(({ operations }) => ({ operations })),
        truncated: snapshot.truncated,
        capturedAt: snapshot.capturedAt,
      };
      return bytes(delta) < bytes(snapshot) ? delta : snapshot;
    }
    return snapshot;
  }
  #check(state: State, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (state.error) throw state.error;
  }
  #schedule(state: State) {
    if (!state.listening || state.task || state.timer || state.error) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.#capture(state).catch(() => {});
    }, 1000);
  }
  #capture(state: State): Promise<void> {
    if (state.task) return state.task;
    clearTimeout(state.timer);
    state.timer = undefined;
    state.dirty = false;
    const assertOwner = () => {
      for (const guard of state.guards.values()) guard();
    };
    state.task = (async () => {
      if (this.resolveTarget) {
        const current = await this.resolveTarget(state.binding);
        if (!current)
          throw new InteractionTransportError("disconnected", "The pane no longer exists");
        if (current.sessionName !== state.binding.sessionName)
          throw new InteractionTransportError("command_failed", "The pane's tmux session changed");
      }
      assertOwner();
      if (state.error) throw state.error;
      return this.capture(state.binding, assertOwner);
    })()
      .then((result) => {
        assertOwner();
        if (state.error) return;
        if (
          !state.snapshot ||
          result.content !== state.snapshot.content ||
          result.truncated !== state.snapshot.truncated
        ) {
          const previous = state.snapshot;
          const key = JSON.stringify([state.binding.socketPath, state.binding.paneId]);
          state.snapshot = {
            ...result,
            capturedAt: new Date().toISOString(),
            revision: createHash("sha256")
              .update(
                JSON.stringify([
                  this.#identity,
                  state.session,
                  key,
                  result.content,
                  result.truncated,
                ]),
              )
              .digest("base64url"),
          };
          if (previous) {
            const operations = diffLines(previous.content, result.content);
            const entry = {
              baseRevision: previous.revision,
              revision: state.snapshot.revision,
              operations: operations ?? [],
            };
            const wire = {
              baseRevision: entry.baseRevision,
              revision: entry.revision,
              patches: [{ operations: entry.operations }],
              truncated: result.truncated,
              capturedAt: state.snapshot.capturedAt,
            };
            if (operations === null || bytes(wire) > 8192 || bytes(wire) >= bytes(state.snapshot))
              state.history = [];
            else {
              state.history.push(entry);
              while (
                state.history.length > 5 ||
                state.history.reduce((sum, item) => sum + bytes(item), 0) > 32768
              )
                state.history.shift();
            }
          }
          for (const listener of [...state.listeners]) listener();
        }
      })
      .catch((error: Error) => {
        this.#fail(
          JSON.stringify([
            state.session,
            JSON.stringify([state.binding.socketPath, state.binding.paneId]),
          ]),
          state,
          error,
        );
        throw error;
      })
      .finally(() => {
        state.task = undefined;
        if (state.dirty) this.#schedule(state);
      });
    return state.task;
  }
  #fail(key: string, state: State, error: Error) {
    state.error = error;
    state.lifecycle.abort();
    for (const listener of [...state.listeners]) listener();
    this.#dispose(key, state);
  }
  #dispose(key: string, state: State) {
    state.listening = false;
    clearTimeout(state.timer);
    clearTimeout(state.idle);
    state.subscription.close();
    if (this.#states.get(key) === state) this.#states.delete(key);
  }
}

/** Cancelling one viewer must not cancel another viewer's shared capture. */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

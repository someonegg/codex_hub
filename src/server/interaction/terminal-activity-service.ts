import type { InteractionResponse } from "../../shared/api-contract.js";
import type { PreviewListener, PreviewSubscription } from "./tmux-preview-listener.js";
import type { TmuxBinding } from "./transport.js";

type Activity = Extract<InteractionResponse, { supported: true }>["activity"];
const WINDOW_MS = 5000;
const LEASE_MS = 60_000;
interface Observation {
  binding: TmuxBinding;
  subscription?: PreviewSubscription;
  readyAt?: number;
  outputAt?: number;
  expiresAt: number;
  failed: boolean;
}

/** Output activity is independent of terminal captures and connection health. */
export class TerminalActivityService {
  readonly #observations = new Map<string, Observation>();
  readonly #timer: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(
    private readonly listen: PreviewListener,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.#timer = setInterval(() => this.invalidate(() => true), 1000);
    this.#timer.unref();
  }

  read(sessionId: string, binding: TmuxBinding): Activity {
    if (this.#closed) return "unknown";
    let observation = this.#observations.get(sessionId);
    if (
      observation &&
      (observation.failed ||
        observation.expiresAt <= this.now() ||
        observation.binding.socketPath !== binding.socketPath ||
        observation.binding.paneId !== binding.paneId ||
        observation.binding.sessionName !== binding.sessionName)
    ) {
      this.remove(sessionId);
      observation = undefined;
    }
    if (!observation) {
      observation = { binding, expiresAt: this.now() + LEASE_MS, failed: false };
      this.#observations.set(sessionId, observation);
      const current = observation;
      const fail = () => {
        current.failed = true;
        current.readyAt = undefined;
        current.outputAt = undefined;
        current.subscription?.close();
      };
      try {
        current.subscription = this.listen(
          binding,
          (pane) => {
            if (!current.failed && pane === binding.paneId) current.outputAt = this.now();
          },
          fail,
        );
        if (current.failed) current.subscription.close();
        void current.subscription.ready.then(() => {
          if (!current.failed) current.readyAt = this.now();
        }, fail);
      } catch {
        fail();
      }
    }
    observation.expiresAt = this.now() + LEASE_MS;
    if (observation.failed || observation.readyAt === undefined) return "unknown";
    if (observation.outputAt !== undefined && this.now() - observation.outputAt < WINDOW_MS)
      return "working";
    return this.now() - observation.readyAt >= WINDOW_MS ? "idle" : "unknown";
  }

  remove(sessionId: string): void {
    const observation = this.#observations.get(sessionId);
    this.#observations.delete(sessionId);
    observation?.subscription?.close();
  }

  invalidate(owns: (sessionId: string, binding: TmuxBinding) => boolean): void {
    for (const [id, observation] of this.#observations)
      if (observation.expiresAt <= this.now() || !owns(id, observation.binding)) this.remove(id);
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    for (const id of this.#observations.keys()) this.remove(id);
  }
}

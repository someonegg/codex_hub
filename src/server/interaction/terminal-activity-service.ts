import type { InteractionResponse } from "../../shared/api-contract.js";
import type { PreviewListener, PreviewSubscription } from "./tmux-preview-listener.js";
import type { TmuxBinding } from "./transport.js";

type Activity = Extract<InteractionResponse, { supported: true }>["activity"];
const WINDOW_MS = 5000;
const LEASE_MS = 30 * 60_000;
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
      this.#subscribe(observation);
    }
    observation.expiresAt = this.now() + LEASE_MS;
    if (observation.failed || observation.readyAt === undefined) return "unknown";
    if (observation.outputAt !== undefined && this.now() - observation.outputAt < WINDOW_MS)
      return "working";
    return this.now() - observation.readyAt >= WINDOW_MS ? "idle" : "unknown";
  }

  #subscribe(observation: Observation): void {
    const { binding } = observation;
    const fail = () => {
      observation.failed = true;
      observation.readyAt = undefined;
      observation.outputAt = undefined;
      observation.subscription?.close();
    };
    try {
      observation.subscription = this.listen(
        binding,
        (pane) => {
          if (!observation.failed && pane === binding.paneId) observation.outputAt = this.now();
        },
        fail,
      );
      if (observation.failed) observation.subscription.close();
      void observation.subscription.ready.then(() => {
        if (!observation.failed) observation.readyAt = this.now();
      }, fail);
    } catch {
      fail();
    }
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

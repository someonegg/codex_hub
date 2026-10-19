import type { InteractionBindingAttempt } from "../domain/session-domain.js";

export interface PaneBindEvent {
  readonly sessionId: string;
  readonly time: number;
  readonly ordinal: number;
  readonly position: number;
  readonly attempt: InteractionBindingAttempt;
}

/** Retains only the latest session event and latest claim on each pane. */
export class PaneBindingManager {
  readonly #sessions = new Map<string, PaneBindEvent>();
  readonly #panes = new Map<string, PaneBindEvent>();

  submit(event: PaneBindEvent): void {
    const latest = this.#sessions.get(event.sessionId);
    if (!latest || compare(event, latest) > 0) this.#sessions.set(event.sessionId, event);
    if (!event.attempt.valid) return;
    const key = paneKey(event.attempt);
    const owner = this.#panes.get(key);
    if (!owner || compare(event, owner) > 0) this.#panes.set(key, event);
  }

  latest(sessionId: string): InteractionBindingAttempt | null {
    return this.#sessions.get(sessionId)?.attempt ?? null;
  }

  replacement(sessionId: string): string | null {
    const event = this.#sessions.get(sessionId);
    if (!event?.attempt.valid) return null;
    const owner = this.#panes.get(paneKey(event.attempt));
    return owner && compare(owner, event) !== 0 ? owner.sessionId : null;
  }

  owns(sessionId: string, pane: { socketPath: string; paneId: string }): boolean {
    const attempt = this.latest(sessionId);
    return (
      !!attempt?.valid && paneKey(attempt) === paneKey(pane) && this.replacement(sessionId) === null
    );
  }
}

function paneKey(pane: { socketPath: string; paneId: string }): string {
  return JSON.stringify([pane.socketPath, pane.paneId]);
}

function compare(left: PaneBindEvent, right: PaneBindEvent): number {
  return (
    left.time - right.time ||
    (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0) ||
    left.ordinal - right.ordinal ||
    left.position - right.position
  );
}

export const paneBindings = new PaneBindingManager();

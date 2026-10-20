import type { ResumeCapability, SessionStatus } from "../../shared/domain.js";
import type { DomainSession, InteractionBindingAttempt } from "../domain/session-domain.js";
import {
  resolveResumeDirectory,
  type SessionManagerRegistry,
} from "../management/session-manager.js";
import { type PaneBindingManager, paneBindings } from "./pane-binding-manager.js";
import type { InteractionTransport, TmuxBinding } from "./transport.js";

/** Shared, bounded observations. Errors never prove that a pane exited. */
export class SessionRuntime {
  readonly #pending = new Map<string, Promise<TmuxBinding | null>>();
  readonly #waiting: (() => void)[] = [];
  readonly #activeSockets = new Map<string, number>();
  constructor(
    private readonly transport: Pick<InteractionTransport, "resolveTarget">,
    private readonly managers: SessionManagerRegistry,
    private readonly bindings: PaneBindingManager = paneBindings,
  ) {}

  probe(attempt: InteractionBindingAttempt): Promise<TmuxBinding | null> {
    if (!attempt.valid) return Promise.reject(new Error("Invalid binding"));
    const key = JSON.stringify([attempt.socketPath, attempt.paneId]);
    const existing = this.#pending.get(key);
    if (existing) return existing;
    const query = (async () => {
      // Different panes on one socket must reach the transport together so they
      // can share one list-panes query, even when there are more than eight panes.
      while (!this.#activeSockets.has(attempt.socketPath) && this.#activeSockets.size >= 8)
        await new Promise<void>((resolve) => this.#waiting.push(resolve));
      this.#activeSockets.set(
        attempt.socketPath,
        (this.#activeSockets.get(attempt.socketPath) ?? 0) + 1,
      );
      try {
        return await this.transport.resolveTarget(attempt);
      } finally {
        const remaining = this.#activeSockets.get(attempt.socketPath)! - 1;
        if (remaining > 0) this.#activeSockets.set(attempt.socketPath, remaining);
        else {
          this.#activeSockets.delete(attempt.socketPath);
          this.#waiting.splice(0).forEach((resume) => resume());
        }
      }
    })();
    this.#pending.set(key, query);
    void query.then(
      () => this.#pending.delete(key),
      () => this.#pending.delete(key),
    );
    return query;
  }

  async evaluate(
    session: DomainSession,
    sessions: readonly DomainSession[],
    detail = true,
  ): Promise<{
    status: SessionStatus;
    resume: ResumeCapability;
  }> {
    let status: SessionStatus = session.archived ? "archived" : "normal";
    const deny = (reason: string) => ({ status, resume: { allowed: false, reason } });
    if (session.archived) return deny("Archived sessions cannot be resumed");
    const attempt = this.bindings.latest(session.id);
    if (!attempt) return deny("No pane binding has been recorded");
    if (!attempt.valid) return deny("The latest pane binding is invalid");
    const replacement = this.bindings.replacement(session.id);
    try {
      const target = await this.probe(attempt);
      if (
        attempt !== this.bindings.latest(session.id) ||
        replacement !== this.bindings.replacement(session.id)
      )
        return deny("Pane binding changed during validation");
      if (target && replacement === null) status = "live";
      if (!detail) return deny("Resume validation required");
      if (status === "live") return deny("Session is already live");
      const manager = this.managers.get(session.origin.sourceInstanceId);
      if (!session.sourceId?.trim() || !manager.isValidNativeId(session.sourceId))
        return deny("Session has no valid native identity");
      if (
        sessions.filter(
          (item) =>
            item.origin.sourceInstanceId === session.origin.sourceInstanceId &&
            item.sourceId === session.sourceId,
        ).length !== 1
      )
        return deny("Native session identity is ambiguous");
      await resolveResumeDirectory(manager, session);
      if (
        attempt !== this.bindings.latest(session.id) ||
        replacement !== this.bindings.replacement(session.id)
      )
        return deny("Pane binding changed during validation");
      return { status, resume: { allowed: true, reason: null } };
    } catch {
      status = "normal";
      return deny("Runtime or working directory validation failed");
    }
  }
}

import type {
  InteractionKey,
  InteractionResponse,
  TerminalPreviewResponse,
} from "../../shared/api-contract.js";
import type { InteractionSessionSnapshot, SessionReader } from "../application/session-reader.js";
import type { InteractionBindingAttempt } from "../domain/session-domain.js";
import { type LivePaneBindingManager, livePaneBindings } from "./live-pane-binding-manager.js";
import { normalizeMessage } from "./message.js";
import { attachCommand } from "./tmux-launcher.js";
import {
  type InteractionTransport,
  InteractionTransportError,
  type TmuxBinding,
} from "./transport.js";

export class SessionInteractionError extends Error {
  constructor(
    readonly code:
      | "session_not_found"
      | "interaction_not_supported"
      | "interaction_not_connected"
      | "operation_result_unknown"
      | "interaction_failed"
      | "session_busy",
    message: string,
  ) {
    super(message);
    this.name = "SessionInteractionError";
  }
}

interface CheckedBinding {
  readonly attempt: InteractionBindingAttempt & { readonly valid: true };
  readonly binding: TmuxBinding;
}

interface ResolvedBinding extends CheckedBinding {
  readonly bindingCommand: string;
  readonly keyBindings: NonNullable<InteractionSessionSnapshot["interaction"]>["keyBindings"];
}

type InteractionSessionReader = Pick<SessionReader, "getInteractionSession">;

export class SessionInteractionService {
  readonly #busy = new Set<string>();

  constructor(
    private readonly sessions: InteractionSessionReader,
    private readonly enabled: boolean,
    private readonly tmux: InteractionTransport,
    private readonly bindings: LivePaneBindingManager = livePaneBindings,
  ) {}

  setBusy(sessionId: string, busy: boolean) {
    if (busy) this.#busy.add(sessionId);
    else this.#busy.delete(sessionId);
  }
  async archiveTarget(sessionId: string): Promise<TmuxBinding | null> {
    const session = await this.sessions.getInteractionSession(sessionId);
    if (!session) throw new Error("Session not found");
    const attempt = this.bindings.latest(sessionId);
    if (this.bindings.replacement(sessionId) !== null) return null;
    if (!attempt?.valid) return null;
    const target = await this.tmux.archiveTarget(attempt);
    return target && this.bindings.owns(sessionId, target) ? target : null;
  }
  exitTarget(target: TmuxBinding, sessionId: string) {
    return this.tmux.exitTarget(target, () => this.#assertOwner(sessionId, target));
  }
  inspectTarget(target: TmuxBinding) {
    return this.tmux.inspect(target);
  }
  #assertAvailable(sessionId: string) {
    if (this.#busy.has(sessionId))
      throw new SessionInteractionError(
        "session_busy",
        "Session management is in progress; input is temporarily unavailable",
      );
  }

  async describe(sessionId: string): Promise<InteractionResponse | null> {
    const session = await this.sessions.getInteractionSession(sessionId);
    if (session === null) return null;
    return this.describeSnapshot(sessionId, session);
  }

  async describeSnapshot(
    sessionId: string,
    session: InteractionSessionSnapshot,
  ): Promise<InteractionResponse> {
    if (!this.#supported(session)) return { supported: false, attachCommand: null };
    const attempt = this.bindings.latest(sessionId);
    if (attempt === null) return response("unbound");
    if (!attempt.valid) {
      return response("disconnected");
    }
    const replacement = this.bindings.replacement(sessionId);
    if (replacement !== null) {
      const unchanged = () =>
        this.bindings.latest(sessionId) === attempt &&
        this.bindings.replacement(sessionId) === replacement;
      try {
        const checked = await this.#check(attempt);
        if (!unchanged()) return this.#currentState(sessionId);
        if (checked === null) return response("disconnected");
        const target = await this.sessions.getInteractionSession(replacement);
        if (!unchanged()) return this.#currentState(sessionId);
        return { ...response("superseded"), supersededBySessionId: target ? replacement : null };
      } catch {
        return unchanged() ? response("unknown") : this.#currentState(sessionId);
      }
    }
    try {
      const checked = await this.#check(attempt);
      if (this.bindings.latest(sessionId) !== attempt || !this.bindings.owns(sessionId, attempt))
        return this.#currentState(sessionId);
      return response(checked === null ? "disconnected" : "connected", checked?.binding);
    } catch {
      if (this.bindings.latest(sessionId) !== attempt || !this.bindings.owns(sessionId, attempt))
        return this.#currentState(sessionId);
      return response("unknown");
    }
  }

  #currentState(sessionId: string): InteractionResponse {
    const attempt = this.bindings.latest(sessionId);
    if (attempt === null) return response("unbound");
    if (!attempt.valid) return response("disconnected");
    return response("unknown");
  }

  #check(attempt: InteractionBindingAttempt & { valid: true }): Promise<CheckedBinding | null> {
    return this.tmux.connect(attempt).then(
      (binding) => ({ attempt, binding }),
      (error: unknown) => {
        if (error instanceof InteractionTransportError && error.code === "disconnected")
          return null;
        throw error;
      },
    );
  }

  async matchesTarget(sessionId: string, target: TmuxBinding): Promise<boolean> {
    const resolved = await this.#resolve(sessionId);
    return (
      resolved.binding.socketPath === target.socketPath && resolved.binding.paneId === target.paneId
    );
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    message = normalizeMessage(message);
    this.#assertAvailable(sessionId);
    const { binding } = await this.#resolve(sessionId);
    this.#assertAvailable(sessionId);
    await this.#perform(() =>
      this.tmux.sendMessage(binding, message, () => this.#assertInputAllowed(sessionId, binding)),
    );
  }

  async handoffPaneBinding(sessionId: string): Promise<void> {
    this.#assertAvailable(sessionId);
    const { binding, bindingCommand } = await this.#resolve(sessionId);
    this.#assertAvailable(sessionId);
    await this.#perform(() =>
      this.tmux.sendMessage(binding, bindingCommand, () =>
        this.#assertInputAllowed(sessionId, binding),
      ),
    );
  }

  async sendKeys(sessionId: string, keys: readonly InteractionKey[]): Promise<void> {
    this.#assertAvailable(sessionId);
    const { binding, keyBindings } = await this.#resolve(sessionId);
    this.#assertAvailable(sessionId);
    const mapped = keys.map((key) => keyBindings[key]);
    await this.#perform(() =>
      this.tmux.sendKeys(binding, mapped, () => this.#assertInputAllowed(sessionId, binding)),
    );
  }

  async preview(sessionId: string): Promise<TerminalPreviewResponse> {
    const { binding } = await this.#resolve(sessionId);
    const result = await this.#perform(() =>
      this.tmux.captureTerminal(binding, () => this.#assertOwner(sessionId, binding)),
    );
    return {
      ...result,
      capturedAt: new Date().toISOString(),
    };
  }

  async #resolve(sessionId: string): Promise<ResolvedBinding> {
    const session = await this.sessions.getInteractionSession(sessionId);
    if (session === null) {
      throw new SessionInteractionError("session_not_found", "Session not found");
    }
    if (!this.#supported(session)) {
      throw new SessionInteractionError(
        "interaction_not_supported",
        "Interaction is not supported for this session",
      );
    }
    const interaction = session.interaction!;
    const attempt = this.bindings.latest(sessionId);
    if (attempt === null || !attempt.valid) {
      throw new SessionInteractionError(
        "interaction_not_connected",
        "The session is not connected to a tmux pane",
      );
    }
    this.#assertOwner(sessionId, attempt);
    let checked: CheckedBinding | null;
    try {
      checked = await this.#check(attempt);
    } catch (error) {
      return this.#translateConnectionError(error);
    }
    if (checked === null) return this.#translateConnectionError(null);
    this.#assertOwner(sessionId, attempt);
    return {
      ...checked,
      keyBindings: interaction.keyBindings,
      bindingCommand: interaction.bindingCommand,
    };
  }

  #assertInputAllowed(sessionId: string, binding: TmuxBinding): void {
    this.#assertAvailable(sessionId);
    this.#assertOwner(sessionId, binding);
  }

  #assertOwner(sessionId: string, target: TmuxBinding): void {
    if (!this.bindings.owns(sessionId, target)) {
      throw new SessionInteractionError(
        "interaction_not_connected",
        "The pane binding has been superseded",
      );
    }
  }

  async #perform<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof InteractionTransportError) {
        if (error.code === "disconnected") {
          throw new SessionInteractionError(
            "interaction_not_connected",
            "The tmux target is no longer connected",
          );
        }
        if (error.code === "timeout") {
          throw new SessionInteractionError(
            "operation_result_unknown",
            "The tmux operation timed out; its result is unknown and was not retried",
          );
        }
        if (error.code === "command_failed") {
          throw new SessionInteractionError(
            "interaction_failed",
            "tmux could not complete the interaction operation",
          );
        }
      }
      throw error;
    }
  }

  #translateConnectionError(error: unknown): never {
    if (error instanceof InteractionTransportError && error.code === "timeout") {
      throw new SessionInteractionError(
        "operation_result_unknown",
        "The tmux validation timed out; its result is unknown and was not retried",
      );
    }
    throw new SessionInteractionError(
      error === null ? "interaction_not_connected" : "interaction_failed",
      error === null
        ? "The session is not connected to a valid tmux pane"
        : "tmux target validation failed",
    );
  }

  #supported(session: InteractionSessionSnapshot): boolean {
    return this.enabled && !session.archived && session.interaction !== null;
  }
}

function response(
  state: "unbound" | "disconnected" | "connected" | "unknown" | "superseded",
  binding?: TmuxBinding,
): Extract<InteractionResponse, { supported: true }> {
  return {
    supported: true,
    state,
    supersededBySessionId: null,
    attachCommand: binding?.sessionName
      ? attachCommand(binding.socketPath, binding.sessionName)
      : null,
  };
}

import type {
  InteractionKey,
  InteractionResponse,
  TerminalPreviewFrame,
} from "../../shared/api-contract.js";
import type {
  InteractionSessionReader,
  InteractionSessionSnapshot,
} from "../application/session-reader.js";
import type {
  DomainAgentInteraction,
  InteractionBindingAttempt,
  InteractionKeyStep,
  TmuxKey,
} from "../domain/session-domain.js";
import { normalizeMessage } from "./message.js";
import { type PaneBindingManager, paneBindings } from "./pane-binding-manager.js";
import { isCurrentObservation, observePaneBinding } from "./pane-observation.js";
import type { RuntimeProbe } from "./runtime-capabilities.js";
import { TerminalActivityService } from "./terminal-activity-service.js";
import { TerminalPreviewService } from "./terminal-preview-service.js";
import { attachCommand } from "./tmux-launcher.js";
import { createTmuxPreviewListener, type PreviewListener } from "./tmux-preview-listener.js";
import { validTmuxSessionName } from "./tmux-target.js";
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

interface PreparedBinding {
  readonly binding: TmuxBinding;
  readonly interruptSteps: DomainAgentInteraction["interruptSteps"];
  readonly bindingCommand: string;
  readonly keyBindings: NonNullable<InteractionSessionSnapshot["interaction"]>["keyBindings"];
}

export interface SessionInteractionOptions {
  readonly enabled: boolean;
  readonly bindings?: PaneBindingManager;
  readonly listener?: PreviewListener;
  readonly runtime?: RuntimeProbe;
}

export class SessionInteractionService {
  private readonly runtime?: RuntimeProbe;
  private readonly enabled: boolean;
  private readonly bindings: PaneBindingManager;
  readonly #busy = new Set<string>();
  readonly #activity: TerminalActivityService;
  readonly #previews: TerminalPreviewService;
  readonly #unsubscribe: () => void;

  close(): void {
    this.#unsubscribe();
    this.#previews.close();
    this.#activity.close();
  }

  constructor(
    private readonly sessions: InteractionSessionReader,
    private readonly tmux: InteractionTransport,
    options: SessionInteractionOptions,
  ) {
    const {
      enabled,
      bindings = paneBindings,
      listener = createTmuxPreviewListener(),
      runtime,
    } = options;
    this.enabled = enabled;
    this.bindings = bindings;
    this.runtime = runtime;
    this.#activity = new TerminalActivityService(listener);
    this.#previews = new TerminalPreviewService(
      (binding, assertOwner) =>
        this.#perform(() => this.tmux.captureTerminal(binding, assertOwner)),
      listener,
    );
    this.#unsubscribe = bindings.subscribe(() => {
      this.#previews.invalidate();
      this.#activity.invalidate((id, binding) => bindings.owns(id, binding));
    });
  }

  setBusy(sessionId: string, busy: boolean) {
    if (busy) this.#busy.add(sessionId);
    else this.#busy.delete(sessionId);
  }
  async resolveTarget(sessionId: string): Promise<TmuxBinding | null> {
    const session = await this.sessions.getInteractionSession(sessionId);
    if (!session) throw new Error("Session not found");
    const attempt = this.bindings.latest(sessionId);
    if (this.bindings.replacement(sessionId) !== null) return null;
    if (!attempt?.valid) return null;
    const target = await this.tmux.resolveTarget(attempt);
    return target && this.bindings.owns(sessionId, target) ? target : null;
  }
  async interruptLaunch(target: TmuxBinding, sessionId: string, assertActive: () => void) {
    const { binding, interruptSteps } = await this.#prepare(sessionId);
    if (binding.socketPath !== target.socketPath || binding.sessionName !== target.sessionName)
      throw new Error("Launch binding changed before interrupt");
    await this.tmux.sendKeys(target, interruptSteps(), () => {
      assertActive();
      this.#assertOwner(sessionId, target);
    });
  }

  sendExitKeys(
    target: TmuxBinding,
    sessionId: string,
    keys: readonly TmuxKey[],
    assertActive: () => void,
  ) {
    return this.tmux.sendKeys(target, [{ keys, delayMs: 0 }], () => {
      assertActive();
      this.#assertOwner(sessionId, target);
    });
  }
  killTarget(target: TmuxBinding, sessionId: string, assertActive: () => void) {
    return this.tmux.killSession(target, () => {
      assertActive();
      this.#assertOwner(sessionId, target);
    });
  }
  async inspectTarget(target: TmuxBinding, sessionId: string) {
    this.#assertOwner(sessionId, target);
    const state = await this.tmux.inspect(target);
    this.#assertOwner(sessionId, target);
    return state;
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
    if (!this.#supported(session)) {
      this.#activity.remove(sessionId);
      return { supported: false, tmux: null, attachCommand: null };
    }
    const observed =
      session.observation ??
      (await observePaneBinding(sessionId, this.bindings, (attempt) => this.#check(attempt)));
    if (observed.state !== "alive" || observed.replacement !== null)
      this.#activity.remove(sessionId);
    if (observed.sessionId !== sessionId || !isCurrentObservation(observed, this.bindings)) {
      this.#activity.remove(sessionId);
      return response("unknown");
    }
    switch (observed.state) {
      case "unbound":
        return response("unbound");
      case "invalid":
        return response("disconnected");
      case "unknown":
        return response("unknown");
      case "exited":
        return response("disconnected");
      case "alive": {
        if (observed.replacement === null)
          return {
            ...response("connected", observed.target),
            activity: this.#activity.read(sessionId, observed.target),
          };
        try {
          const replacement = await this.sessions.getInteractionSession(observed.replacement);
          if (!isCurrentObservation(observed, this.bindings)) return response("unknown");
          return {
            ...response("superseded"),
            supersededBySessionId: replacement ? observed.replacement : null,
          };
        } catch {
          return response("unknown");
        }
      }
    }
  }

  #check(attempt: InteractionBindingAttempt & { valid: true }): Promise<TmuxBinding | null> {
    const connection = this.runtime ? this.runtime.probe(attempt) : this.tmux.connect(attempt);
    return connection.catch((error: unknown) => {
      if (error instanceof InteractionTransportError && error.code === "disconnected") return null;
      throw error;
    });
  }

  async matchesTarget(sessionId: string, target: TmuxBinding): Promise<boolean> {
    const resolved = await this.#prepare(sessionId);
    return (
      resolved.binding.socketPath === target.socketPath &&
      resolved.binding.sessionName === target.sessionName
    );
  }

  async sendMessage(sessionId: string, message: string, requireIdle = false): Promise<void> {
    message = normalizeMessage(message);
    this.#assertAvailable(sessionId);
    const { binding } = await this.#prepare(sessionId);
    this.#assertAvailable(sessionId);
    this.#assertInputAllowed(sessionId, binding, requireIdle);
    await this.#perform(() =>
      this.tmux.sendMessage(binding, message, this.#inputGuard(sessionId, binding, requireIdle)),
    );
  }

  async handoffPaneBinding(sessionId: string): Promise<void> {
    this.#assertAvailable(sessionId);
    const { binding, bindingCommand } = await this.#prepare(sessionId);
    this.#assertAvailable(sessionId);
    await this.#perform(() =>
      this.tmux.sendMessage(binding, bindingCommand, () =>
        this.#assertInputAllowed(sessionId, binding),
      ),
    );
  }

  async sendKeys(
    sessionId: string,
    keys: readonly InteractionKey[],
    requireIdle = false,
  ): Promise<void> {
    this.#assertAvailable(sessionId);
    const { binding, keyBindings, interruptSteps } = await this.#prepare(sessionId);
    this.#assertAvailable(sessionId);
    this.#assertInputAllowed(sessionId, binding, requireIdle);
    const mapped = keys.flatMap((key): readonly InteractionKeyStep[] =>
      key === "interrupt" ? interruptSteps() : [{ keys: [keyBindings[key]], delayMs: 0 }],
    );
    await this.#perform(() =>
      this.tmux.sendKeys(binding, mapped, this.#inputGuard(sessionId, binding, requireIdle)),
    );
  }

  async captureTerminal(sessionId: string) {
    this.#assertAvailable(sessionId);
    const { binding } = await this.#prepare(sessionId);
    this.#assertAvailable(sessionId);
    return this.#previews.captureFresh(binding, () => {
      this.#assertAvailable(sessionId);
      this.#assertOwner(sessionId, binding);
    });
  }

  async subscribePreview(
    sessionId: string,
    frame: (value: TerminalPreviewFrame) => void,
    fail: (error: unknown) => void,
    signal: AbortSignal,
  ): Promise<() => void> {
    const { binding } = await this.#prepare(sessionId);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return this.#previews.subscribe(
      binding,
      () => this.#assertOwner(sessionId, binding),
      frame,
      fail,
      signal,
    );
  }

  async #prepare(sessionId: string): Promise<PreparedBinding> {
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
    if (!attempt.socketPath.startsWith("/") || !validTmuxSessionName(attempt.sessionName))
      throw new SessionInteractionError("interaction_not_connected", "Invalid tmux binding");
    return {
      binding: { socketPath: attempt.socketPath, sessionName: attempt.sessionName },
      interruptSteps: () => interaction.interruptSteps(),
      keyBindings: interaction.keyBindings,
      bindingCommand: interaction.bindingCommand,
    };
  }

  #inputGuard(sessionId: string, binding: TmuxBinding, requireIdle: boolean): () => void {
    let started = false;
    return () => {
      // Check idle at serialized transaction entry. Echo from our own paste or keys
      // must not prevent Enter or the remaining keys; ownership stays checked throughout.
      this.#assertInputAllowed(sessionId, binding, requireIdle && !started);
      started = true;
    };
  }

  #assertInputAllowed(sessionId: string, binding: TmuxBinding, requireIdle = false): void {
    this.#assertAvailable(sessionId);
    this.#assertOwner(sessionId, binding);
    if (requireIdle && this.#activity.read(sessionId, binding) !== "idle")
      throw new SessionInteractionError("session_busy", "Session must be live and idle for input");
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
    tmux: binding
      ? {
          socketPath: binding.socketPath,
          sessionName: binding.sessionName,
        }
      : null,
    state,
    activity: null,
    supersededBySessionId: null,
    attachCommand: binding ? attachCommand(binding.socketPath, binding.sessionName) : null,
  };
}

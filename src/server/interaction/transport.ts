import type { InteractionBindingAttempt, InteractionKeyStep } from "../domain/session-domain.js";

export interface TmuxBinding {
  readonly socketPath: string;
  readonly sessionName: string;
}

/** Coordinates refer to the captured visible pane, with a zero-based origin. */
export interface TerminalCursorSnapshot {
  readonly content: string;
  readonly cursorX: number;
  readonly cursorY: number;
}

export interface InteractionTransport {
  connect(attempt: InteractionBindingAttempt): Promise<TmuxBinding>;
  resolveTarget(attempt: InteractionBindingAttempt): Promise<TmuxBinding | null>;
  killSession(target: TmuxBinding, assertAvailable?: () => void): Promise<void>;
  inspect(target: TmuxBinding): Promise<"alive" | "exited">;
  sendMessage(target: TmuxBinding, message: string, assertAvailable?: () => void): Promise<void>;
  sendKeys(
    target: TmuxBinding,
    steps: readonly InteractionKeyStep[],
    assertAvailable?: () => void,
  ): Promise<void>;
  captureTerminal(
    target: TmuxBinding,
    assertAvailable?: () => void,
  ): Promise<{ readonly content: string; readonly truncated: boolean }>;
}

export class InteractionTransportError extends Error {
  constructor(
    readonly code: "disconnected" | "timeout" | "command_failed",
    message: string,
  ) {
    super(message);
    this.name = "InteractionTransportError";
  }
}

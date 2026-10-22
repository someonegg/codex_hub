import type { InteractionBindingAttempt, InteractionKeyStep } from "../domain/session-domain.js";

export interface TmuxBinding {
  readonly socketPath: string;
  readonly paneId: string;
  readonly sessionName?: string;
}

export interface InteractionTransport {
  connect(attempt: InteractionBindingAttempt): Promise<TmuxBinding>;
  resolveTarget(attempt: InteractionBindingAttempt): Promise<TmuxBinding | null>;
  killPane(target: TmuxBinding, assertAvailable?: () => void): Promise<void>;
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

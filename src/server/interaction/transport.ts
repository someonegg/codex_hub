import type { InteractionBindingAttempt, TmuxKey } from "../domain/session-domain.js";

export interface TmuxBinding {
  readonly socketPath: string;
  readonly paneId: string;
  readonly sessionName?: string;
}

export interface InteractionTransport {
  connect(attempt: InteractionBindingAttempt): Promise<TmuxBinding>;
  archiveTarget(attempt: InteractionBindingAttempt): Promise<TmuxBinding | null>;
  exitTarget(target: TmuxBinding): Promise<void>;
  inspect(target: TmuxBinding): Promise<"alive" | "exited">;
  sendMessage(target: TmuxBinding, message: string, assertAvailable?: () => void): Promise<void>;
  sendKeys(
    target: TmuxBinding,
    keys: readonly TmuxKey[],
    assertAvailable?: () => void,
  ): Promise<void>;
  captureTerminal(
    target: TmuxBinding,
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

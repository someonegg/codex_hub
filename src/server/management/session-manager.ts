import type { DomainSession, TmuxKey } from "../domain/session-domain.js";
import type { TmuxBinding } from "../interaction/transport.js";

export interface ManagementSnapshot {
  readonly sessions: readonly DomainSession[];
}

export interface SessionExitStep {
  readonly keys: readonly TmuxKey[];
  readonly delayMs: number;
}

export interface SessionExitCapability {
  exitSteps(): readonly SessionExitStep[];
}

export interface SessionManager extends SessionExitCapability {
  resolveDirectory(directory: string): Promise<{ directory: string; project: string }>;
  launch(
    operationId: string,
    directory: string,
    worktree: boolean,
    yolo: boolean,
    resumeNativeId?: string,
  ): Promise<TmuxBinding>;
  archive(nativeId: string): Promise<void>;
  delete(nativeId: string): Promise<void>;
}

/** A launch failure records whether a process may already be running. */
export class SessionLaunchError extends Error {
  constructor(
    readonly outcome: "not_started" | "unknown",
    message: string,
    readonly attachCommand: string | null = null,
    readonly target?: TmuxBinding,
  ) {
    super(message);
  }
}

export class SessionManagerRegistry {
  readonly #managers = new Map<string, SessionManager>();

  constructor(readonly defaultSourceInstanceId: string) {}

  register(sourceInstanceId: string, manager: SessionManager): this {
    if (this.#managers.has(sourceInstanceId)) {
      throw new Error(`Duplicate management source: ${sourceInstanceId}`);
    }
    this.#managers.set(sourceInstanceId, manager);
    return this;
  }

  resolveCreateSource(sourceInstanceId?: string): string {
    if (sourceInstanceId === undefined && this.#managers.size === 1)
      return this.defaultSourceInstanceId;
    if (!sourceInstanceId || !this.#managers.has(sourceInstanceId))
      throw new Error(
        sourceInstanceId
          ? "Unknown sourceInstanceId"
          : "sourceInstanceId is required when multiple homes are configured",
      );
    return sourceInstanceId;
  }

  get(sourceInstanceId: string): SessionManager {
    const manager = this.#managers.get(sourceInstanceId);
    if (!manager) {
      throw new Error(`Session source has no management capability: ${sourceInstanceId}`);
    }
    return manager;
  }
}

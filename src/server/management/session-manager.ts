import { validProjectDirectory } from "../domain/project-directory.js";
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

/** Shared launch inputs; native identities remain opaque outside their adapter. */
export interface SessionLaunchOptions {
  readonly operationId: string;
  /** Actual process working directory, resolved before launch. */
  readonly directory: string;
  readonly worktree: boolean;
  readonly yolo: boolean;
  /** Present for resume; absent for creation. */
  readonly resumeNativeId?: string;
  /** Original project association, retained even when launching in a worktree. */
  readonly projectDirectory?: string | null;
}

export interface SessionManager extends SessionExitCapability {
  isValidNativeId(nativeId: string): boolean;
  resolveDirectory(directory: string): Promise<{ directory: string }>;
  launch(options: SessionLaunchOptions): Promise<TmuxBinding>;
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

export async function resolveResumeDirectory(
  manager: SessionManager,
  session: Pick<DomainSession, "workingDirectory" | "projectDirectory">,
): Promise<{ directory: string }> {
  for (const candidate of new Set([session.workingDirectory, session.projectDirectory])) {
    if (!validProjectDirectory(candidate)) continue;
    try {
      return await manager.resolveDirectory(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  throw new Error("Session has no available working or project directory");
}

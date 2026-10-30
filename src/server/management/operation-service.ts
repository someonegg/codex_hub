import { randomUUID } from "node:crypto";

import type { CreateSessionRequest, HubOperation } from "../../shared/api-contract.js";
import type { SessionInteractionService } from "../interaction/interaction-service.js";
import { type PaneBindingManager, paneBindings } from "../interaction/pane-binding-manager.js";
import type { SessionRuntime } from "../interaction/session-runtime.js";
import { attachCommand } from "../interaction/tmux-launcher.js";
import type { UploadCleanup } from "../uploads/store.js";
import {
  AssociationError,
  type OperationContext,
  type OperationControl,
  type OperationEntry,
  type OperationStage,
  type OperationTimeouts,
} from "./operation-state.js";
import { SessionLaunchExecutor } from "./session-launch-executor.js";
import { SessionLifecycleExecutor } from "./session-lifecycle-executor.js";
import type { SessionManagerRegistry } from "./session-manager.js";
import { type ManagementSnapshot, SessionLaunchError } from "./session-manager.js";

interface RequestRecord {
  readonly fingerprint: string;
  readonly operationId: string;
}
export class ManagementError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class OperationService {
  readonly #entries = new Map<string, OperationEntry>();
  readonly #requests = new Map<string, RequestRecord>();
  readonly #active = new Map<string, OperationEntry>();
  readonly #results = new Map<string, HubOperation>();
  readonly #timer: ReturnType<typeof setInterval>;
  #closed = false;
  readonly #launch: SessionLaunchExecutor;
  readonly #lifecycle: SessionLifecycleExecutor;

  constructor(
    sessions: { managementSnapshot(): Promise<ManagementSnapshot> },
    private readonly interaction: Pick<
      SessionInteractionService,
      | "describe"
      | "matchesTarget"
      | "resolveTarget"
      | "sendExitKeys"
      | "killTarget"
      | "inspectTarget"
      | "setBusy"
    >,
    private readonly managers: SessionManagerRegistry,
    private readonly now = Date.now,
    private readonly waitMs: OperationTimeouts = {
      create: 300_000,
      exit: 30_000,
      archive: 30_000,
      delete: 30_000,
    },
    bindings: PaneBindingManager = paneBindings,
    runtime?: SessionRuntime,
    uploads?: UploadCleanup,
  ) {
    const control: OperationControl = {
      pending: (entry): entry is OperationEntry & { stage: OperationStage } => this.#pending(entry),
      transition: (entry, context, deadline) => this.#transition(entry, context, deadline),
      finish: (entry, status, error) => this.#finish(entry, status, error),
      error: (entry, error) => this.#error(entry, error),
      timeout: (entry) => this.#timeout(entry),
      observe: (entry) => this.#observe(entry),
    };
    this.#launch = new SessionLaunchExecutor(
      sessions,
      interaction,
      managers,
      bindings,
      control,
      now,
      waitMs,
      runtime,
    );
    this.#lifecycle = new SessionLifecycleExecutor(
      sessions,
      interaction,
      managers,
      control,
      now,
      waitMs,
      uploads,
    );
    this.#timer = setInterval(() => {
      void this.poll();
    }, 1_000);
    this.#timer.unref();
  }

  create(input: CreateSessionRequest): HubOperation {
    if (input.resumeSessionId !== undefined) return this.#resume(input);
    let home: string;
    try {
      home = this.managers.resolveCreateHome(input.home);
    } catch (error) {
      throw new ManagementError(400, (error as Error).message);
    }
    const fingerprint = JSON.stringify([
      home,
      "create",
      input.directory,
      input.worktree,
      input.yolo ?? false,
    ]);
    const duplicate = this.#duplicate(input.requestId, fingerprint);
    if (duplicate) return { ...duplicate };
    const entry = this.#new("create", null);
    entry.metadata.mode = "new";
    entry.home = home;
    this.#requests.set(input.requestId, { fingerprint, operationId: entry.metadata.operationId });
    void this.#launch.create(entry, input);
    return this.#project(entry);
  }

  #resume(input: Extract<CreateSessionRequest, { resumeSessionId: string }>): HubOperation {
    if (
      Object.keys(input).some((key) => !["resumeSessionId", "yolo", "requestId"].includes(key)) ||
      !input.resumeSessionId.trim()
    )
      throw new ManagementError(400, "Resume accepts only resumeSessionId, yolo and requestId");
    const sessionId = input.resumeSessionId;
    const fingerprint = JSON.stringify(["resume", sessionId, input.yolo ?? false]);
    const duplicate = this.#duplicate(input.requestId, fingerprint);
    if (duplicate) return { ...duplicate };
    if (this.#active.has(sessionId))
      throw new ManagementError(409, "Another management operation is running for this session");
    const entry = this.#new("create", sessionId);
    entry.metadata.mode = "resume";
    this.#active.set(sessionId, entry);
    this.interaction.setBusy(sessionId, true);
    this.#requests.set(input.requestId, { fingerprint, operationId: entry.metadata.operationId });
    void this.#launch.resume(entry, input);
    return this.#project(entry);
  }

  manage(type: "exit" | "archive" | "delete", sessionId: string): HubOperation {
    const active = this.#active.get(sessionId);
    if (active) {
      if (active.metadata.type !== type)
        throw new ManagementError(409, "Another management operation is running for this session");
      return this.#project(active);
    }
    const entry = this.#new(type, sessionId);
    this.#active.set(sessionId, entry);
    this.interaction.setBusy(sessionId, true);
    this.#transition(
      entry,
      { kind: "manage", phase: "resolving" },
      this.now() +
        (type === "exit" ? (this.waitMs.exit ?? this.waitMs.archive) : this.waitMs[type]),
    );
    void this.#lifecycle.manage(entry, type, sessionId);
    return this.#project(entry);
  }

  async get(id: string): Promise<HubOperation | null> {
    this.#prune();
    const operation = this.#results.get(id) ?? this.#lookup(id);
    return operation ? { ...operation } : null;
  }

  async poll(): Promise<void> {
    if (this.#closed) return;
    this.#prune();
    const checks: Promise<void>[] = [];
    for (const entry of this.#entries.values()) {
      this.#timeout(entry);
      if (!this.#pending(entry)) continue;
      const context = entry.stage;
      if (
        context.kind === "create" &&
        context.phase === "observing" &&
        this.now() - context.startedAt >= 30_000
      ) {
        this.#attach(
          entry,
          attachCommand(context.target.socketPath, `ahub-${entry.metadata.operationId}`),
        );
      }
      if (
        (context.kind === "create" && context.phase === "observing") ||
        context.kind === "exiting" ||
        ((context.kind === "archive" || context.kind === "delete") &&
          context.phase === "confirming")
      ) {
        checks.push(this.#observe(entry));
      }
    }
    await Promise.all(checks);
  }

  close() {
    clearInterval(this.#timer);
    for (const entry of this.#entries.values())
      this.#finish(entry, "unknown", "Server stopped tracking the operation");
    this.#closed = true;
  }

  #observe(entry: OperationEntry): Promise<void> {
    if (entry.checking) return entry.checking;
    entry.checking = this.#check(entry).finally(() => {
      entry.checking = undefined;
    });
    return entry.checking;
  }

  async #check(entry: OperationEntry) {
    if (!this.#pending(entry)) return;
    try {
      if (entry.stage.kind === "create") await this.#launch.observe(entry);
      else await this.#lifecycle.observe(entry);
    } catch (error) {
      // Read failures never prove disappearance or justify another command.
      if (error instanceof AssociationError) this.#finish(entry, "unknown", error.message);
    }
    this.#timeout(entry);
  }

  #transition(
    entry: OperationEntry,
    context: OperationContext,
    deadline = entry.stage?.deadline ?? null,
  ) {
    if (!this.#pending(entry)) return;
    const previous = operationPhase(entry.stage);
    entry.stage = { ...context, deadline };
    if (context.kind === "create" && context.phase === "observing")
      entry.metadata.target = context.target;
    if (previous !== operationPhase(entry.stage))
      entry.metadata.updatedAt = new Date(this.now()).toISOString();
  }
  #lookup(id: string) {
    const entry = this.#entries.get(id);
    return entry ? this.#project(entry) : undefined;
  }
  #project(entry: OperationEntry): HubOperation {
    if (entry.result) return { ...entry.result };
    const context = entry.stage;
    if (!context) throw new Error("Pending operation has no execution stage");
    return { ...entry.metadata, phase: operationPhase(context), status: "pending", error: null };
  }

  #attach(entry: OperationEntry, command: string | null) {
    if (!this.#pending(entry) || entry.metadata.attachCommand === command) return;
    entry.metadata.attachCommand = command;
    entry.metadata.updatedAt = new Date(this.now()).toISOString();
  }

  #pending(entry: OperationEntry): entry is OperationEntry & { stage: OperationStage } {
    return !this.#closed && !entry.result && entry.stage !== null;
  }
  #timeout(entry: OperationEntry) {
    if (
      this.#pending(entry) &&
      entry.stage.deadline !== null &&
      this.now() >= entry.stage.deadline
    ) {
      this.#finish(
        entry,
        "unknown",
        entry.metadata.type === "create"
          ? "No Codex session detected. Tracking has stopped. Attach to tmux or refresh the session list to check the result; creating again may start another session."
          : "Timed out; result is unknown. Refresh the session list before submitting again.",
      );
    }
  }
  #error(entry: OperationEntry, error: unknown) {
    if (error instanceof SessionLaunchError) {
      this.#attach(entry, error.attachCommand);
      if (error.target) entry.metadata.target = error.target;
      this.#finish(entry, error.outcome === "unknown" ? "unknown" : "failed", error.message);
      return;
    }
    const timedOut =
      !!error &&
      typeof error === "object" &&
      (("killed" in error && error.killed) || ("code" in error && error.code === "timeout"));
    this.#finish(
      entry,
      timedOut ? "unknown" : "failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  #finish(
    entry: OperationEntry,
    status: Exclude<HubOperation["status"], "pending">,
    error: string | null,
  ) {
    if (entry.result) return;
    const context = entry.stage;
    if (context?.kind === "create" && context.phase === "observing" && status === "unknown") {
      entry.metadata.attachCommand = attachCommand(
        context.target.socketPath,
        `ahub-${entry.metadata.operationId}`,
      );
    }
    entry.metadata.updatedAt = new Date(this.now()).toISOString();
    entry.result = Object.freeze({ ...this.#project(entry), status, error });
    entry.stage = null;
    this.#results.set(entry.metadata.operationId, entry.result);
    this.#entries.delete(entry.metadata.operationId);
    const sessionId = entry.metadata.sessionId;
    if (sessionId && this.#active.get(sessionId) === entry) {
      this.#active.delete(sessionId);
      this.interaction.setBusy(sessionId, false);
    }
  }
  #new(type: HubOperation["type"], sessionId: string | null): OperationEntry {
    if (this.#closed) throw new ManagementError(503, "Server stopped tracking operations");
    this.#prune();
    const timestamp = new Date(this.now()).toISOString();
    const entry: OperationEntry = {
      metadata: {
        attachCommand: null,
        operationId: randomUUID(),
        type,
        sessionId,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      home: this.managers.defaultHome,
      stage:
        type === "create"
          ? { kind: "create", phase: "resolving", deadline: null }
          : { kind: "manage", phase: "resolving", deadline: null },
    };
    this.#entries.set(entry.metadata.operationId, entry);
    return entry;
  }
  #duplicate(requestId: string, fingerprint: string) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId))
      throw new ManagementError(
        400,
        "requestId must contain 8–128 letters, digits, underscores or hyphens",
      );
    this.#prune();
    const record = this.#requests.get(requestId);
    if (record && record.fingerprint !== fingerprint)
      throw new ManagementError(409, "requestId was already used with different parameters");
    return record
      ? (this.#results.get(record.operationId) ?? this.#lookup(record.operationId))
      : undefined;
  }
  #prune() {
    for (const [id, operation] of this.#results) {
      if (this.now() - Date.parse(operation.updatedAt) >= 30 * 60_000) {
        this.#results.delete(id);
        for (const [requestId, record] of this.#requests) {
          if (record.operationId === id) this.#requests.delete(requestId);
        }
      }
    }
  }
}

function operationPhase(context: OperationStage): HubOperation["phase"] {
  if (context.kind === "exiting") return context.task.phase;
  if (context.kind !== "archive") return null;
  switch (context.phase) {
    case "confirming":
      return "confirming_archive";
    case "resolving_target":
      return null;
    case "archiving":
      return context.phase;
  }
}

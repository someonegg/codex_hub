import { randomUUID } from "node:crypto";

import type { CreateSessionRequest, HubOperation } from "../../shared/api-contract.js";
import type { SessionInteractionService } from "../interaction/interaction-service.js";
import {
  type LivePaneBindingManager,
  livePaneBindings,
} from "../interaction/live-pane-binding-manager.js";
import { attachCommand } from "../interaction/tmux-launcher.js";
import type { TmuxBinding } from "../interaction/transport.js";
import type { SessionManagerRegistry } from "./session-manager.js";
import { type ManagementSnapshot, SessionLaunchError } from "./session-manager.js";

type Context =
  | { kind: "create"; phase: "resolving" | "launching" }
  | { kind: "create"; phase: "observing"; target: TmuxBinding; project: string; startedAt: number }
  | { kind: "manage"; phase: "resolving" }
  | { kind: "delete"; phase: "deleting" | "confirming"; nativeId: string }
  | { kind: "archive"; phase: "resolving_target" | "archiving" | "confirming"; nativeId: string }
  | {
      kind: "archive";
      phase: "sending_exit" | "waiting_exit";
      nativeId: string;
      target: TmuxBinding;
    };
type Stage = Context & { deadline: number | null };
interface Entry {
  readonly metadata: Omit<HubOperation, "status" | "error" | "phase">;
  result?: Readonly<HubOperation>;
  sourceInstanceId: string;
  stage: Stage | null;
  checking?: Promise<void>;
}
interface RequestRecord {
  readonly fingerprint: string;
  readonly operationId: string;
}
class AssociationError extends Error {}
export class ManagementError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class OperationService {
  readonly #entries = new Map<string, Entry>();
  readonly #requests = new Map<string, RequestRecord>();
  readonly #active = new Map<string, Entry>();
  readonly #results = new Map<string, HubOperation>();
  readonly #timer: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(
    private readonly sessions: { managementSnapshot(): Promise<ManagementSnapshot> },
    private readonly interaction: Pick<
      SessionInteractionService,
      "describe" | "matchesTarget" | "archiveTarget" | "exitTarget" | "inspectTarget" | "setBusy"
    >,
    private readonly managers: SessionManagerRegistry,
    private readonly now = Date.now,
    private readonly waitMs = { create: 300_000, archive: 30_000, delete: 30_000 },
    private readonly bindings: LivePaneBindingManager = livePaneBindings,
  ) {
    this.#timer = setInterval(() => {
      void this.poll();
    }, 1_000);
    this.#timer.unref();
  }

  create(input: CreateSessionRequest): HubOperation {
    const fingerprint = JSON.stringify(["create", input.directory, input.worktree]);
    const duplicate = this.#duplicate(input.requestId, fingerprint);
    if (duplicate) return { ...duplicate };
    const entry = this.#new("create", null);
    this.#requests.set(input.requestId, { fingerprint, operationId: entry.metadata.operationId });
    void (async () => {
      try {
        const manager = this.managers.get(entry.sourceInstanceId);
        const resolved = await manager.resolveDirectory(input.directory);
        if (!this.#pending(entry)) return;
        this.#transition(entry, { kind: "create", phase: "launching" });
        const target = await manager.launch(
          entry.metadata.operationId,
          resolved.directory,
          input.worktree,
        );
        if (!this.#pending(entry)) return;
        this.#transition(
          entry,
          {
            kind: "create",
            phase: "observing",
            project: resolved.project,
            target,
            startedAt: this.now(),
          },
          this.now() + this.waitMs.create,
        );
      } catch (error) {
        this.#error(entry, error);
      }
    })();
    return this.#project(entry);
  }

  manage(type: "archive" | "delete", sessionId: string): HubOperation {
    const active = this.#active.get(sessionId);
    if (active) {
      if (active.metadata.type !== type)
        throw new ManagementError(409, "Another management operation is running for this session");
      return this.#project(active);
    }
    const entry = this.#new(type, sessionId);
    this.#active.set(sessionId, entry);
    this.interaction.setBusy(sessionId, true);
    this.#transition(entry, { kind: "manage", phase: "resolving" }, this.now() + this.waitMs[type]);
    void (async () => {
      try {
        const snapshot = await this.sessions.managementSnapshot();
        if (!this.#pending(entry)) return;
        const session = snapshot.sessions.find((item) => item.id === sessionId);
        if (!session) {
          if (type === "delete") {
            this.#finish(entry, "succeeded", null);
            return;
          }
          throw new Error("Session not found");
        }
        entry.sourceInstanceId = session.origin.sourceInstanceId;
        const manager = this.managers.get(entry.sourceInstanceId);
        if (type === "archive" && session.archived) {
          this.#finish(entry, "succeeded", null);
          return;
        }
        const nativeId = session.sourceId;
        if (!nativeId?.trim()) throw new Error("Session has no valid native identity");
        if (this.#matches(snapshot, entry, nativeId).length !== 1)
          throw new Error("Native session identity is ambiguous");
        if (type === "delete") {
          if (!session.archived) throw new Error("Only archived sessions can be deleted");
          this.#transition(entry, { kind: "delete", phase: "deleting", nativeId });
          await manager.delete(nativeId);
          if (!this.#pending(entry)) return;
          this.#transition(entry, { kind: "delete", phase: "confirming", nativeId });
        } else {
          this.#transition(entry, { kind: "archive", phase: "resolving_target", nativeId });
          const target = await this.interaction.archiveTarget(sessionId);
          if (!this.#pending(entry)) return;
          if (target) {
            this.#transition(entry, { kind: "archive", phase: "sending_exit", nativeId, target });
            try {
              await this.interaction.exitTarget(target, sessionId);
            } catch (error) {
              this.#finish(
                entry,
                "unknown",
                error instanceof Error ? error.message : String(error),
              );
              return;
            }
            if (!this.#pending(entry)) return;
            this.#transition(
              entry,
              { kind: "archive", phase: "waiting_exit", nativeId, target },
              this.now() + this.waitMs.archive,
            );
          } else {
            await this.#archive(entry, nativeId);
          }
        }
        if (this.#pending(entry)) await this.#observe(entry);
      } catch (error) {
        this.#error(entry, error);
      }
    })();
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
          attachCommand(context.target.socketPath, `codex-hub-${entry.metadata.operationId}`),
        );
      }
      if (
        (context.kind === "create" && context.phase === "observing") ||
        (context.kind === "archive" &&
          (context.phase === "waiting_exit" || context.phase === "confirming")) ||
        (context.kind === "delete" && context.phase === "confirming")
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

  #observe(entry: Entry): Promise<void> {
    if (entry.checking) return entry.checking;
    entry.checking = this.#check(entry).finally(() => {
      entry.checking = undefined;
    });
    return entry.checking;
  }

  async #check(entry: Entry) {
    if (!this.#pending(entry)) return;
    try {
      let context = entry.stage;
      if (context.kind === "archive" && context.phase === "waiting_exit") {
        const state = await this.interaction.inspectTarget(context.target);
        if (!this.#pending(entry)) return;
        if (state !== "exited") {
          this.#timeout(entry);
          return;
        }
        await this.#archive(entry, context.nativeId);
        if (!this.#pending(entry)) return;
      }
      const snapshot = await this.sessions.managementSnapshot();
      if (!this.#pending(entry)) return;
      context = entry.stage;
      if (context.kind === "create" && context.phase === "observing") {
        const matches = snapshot.sessions.filter((session) => {
          const attempt = this.bindings.latest(session.id);
          return (
            session.origin.sourceInstanceId === entry.sourceInstanceId &&
            attempt?.valid &&
            attempt.operationId === entry.metadata.operationId
          );
        });
        if (matches.length > 1)
          throw new AssociationError("Multiple sessions claimed this operation ID");
        const match = matches[0];
        if (match) {
          const attempt = this.bindings.latest(match.id);
          if (
            !attempt?.valid ||
            attempt.socketPath !== context.target.socketPath ||
            attempt.paneId !== context.target.paneId ||
            match.projectDirectory !== context.project
          ) {
            throw new AssociationError("Binding does not match the launched target/project");
          }
          const binding = await this.interaction.describe(match.id);
          if (!this.#pending(entry)) return;
          if (binding?.supported && binding.state === "unknown") return;
          if (!binding?.supported || binding.state !== "connected")
            throw new AssociationError("The new session binding failed validation");
          const matchesTarget = await this.interaction.matchesTarget(match.id, context.target);
          if (!this.#pending(entry)) return;
          if (!matchesTarget)
            throw new AssociationError("Binding does not match the launched target");
          entry.metadata.sessionId = match.id;
          this.#finish(entry, "succeeded", null);
        }
      } else if (
        (context.kind === "archive" || context.kind === "delete") &&
        context.phase === "confirming"
      ) {
        const matches = this.#matches(snapshot, entry, context.nativeId);
        if (
          (context.kind === "archive" && matches.length === 1 && matches[0]?.archived) ||
          (context.kind === "delete" && matches.length === 0)
        )
          this.#finish(entry, "succeeded", null);
      }
    } catch (error) {
      // Read failures never prove disappearance or justify another command.
      if (error instanceof AssociationError) this.#finish(entry, "unknown", error.message);
    }
    this.#timeout(entry);
  }

  async #archive(entry: Entry, nativeId: string) {
    if (!this.#pending(entry)) return;
    this.#transition(entry, { kind: "archive", phase: "archiving", nativeId }, this.now() + 25_000);
    try {
      await this.managers.get(entry.sourceInstanceId).archive(nativeId);
      if (!this.#pending(entry)) return;
      this.#transition(
        entry,
        { kind: "archive", phase: "confirming", nativeId },
        this.now() + this.waitMs.archive,
      );
    } catch (error) {
      if (!this.#pending(entry)) return;
      this.#error(entry, error);
    }
  }

  #transition(entry: Entry, context: Context, deadline = entry.stage?.deadline ?? null) {
    if (!this.#pending(entry)) return;
    const previous = this.#project(entry).phase;
    entry.stage = { ...context, deadline };
    if (previous !== this.#project(entry).phase)
      entry.metadata.updatedAt = new Date(this.now()).toISOString();
  }
  #lookup(id: string) {
    const entry = this.#entries.get(id);
    return entry ? this.#project(entry) : undefined;
  }
  #project(entry: Entry): HubOperation {
    if (entry.result) return { ...entry.result };
    const context = entry.stage;
    if (!context) throw new Error("Pending operation has no execution stage");
    const phase: HubOperation["phase"] =
      context.kind === "archive"
        ? context.phase === "confirming"
          ? "confirming_archive"
          : context.phase === "resolving_target"
            ? null
            : context.phase
        : null;
    return { ...entry.metadata, phase, status: "pending", error: null };
  }
  #attach(entry: Entry, command: string | null) {
    if (!this.#pending(entry) || entry.metadata.attachCommand === command) return;
    entry.metadata.attachCommand = command;
    entry.metadata.updatedAt = new Date(this.now()).toISOString();
  }

  #matches(snapshot: ManagementSnapshot, entry: Entry, nativeId: string) {
    return snapshot.sessions.filter(
      (session) =>
        session.origin.sourceInstanceId === entry.sourceInstanceId && session.sourceId === nativeId,
    );
  }
  #pending(entry: Entry): entry is Entry & { stage: Stage } {
    return !this.#closed && !entry.result && entry.stage !== null;
  }
  #timeout(entry: Entry) {
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
  #error(entry: Entry, error: unknown) {
    if (error instanceof SessionLaunchError) {
      this.#attach(entry, error.attachCommand);
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
  #finish(entry: Entry, status: Exclude<HubOperation["status"], "pending">, error: string | null) {
    if (entry.result) return;
    const context = entry.stage;
    if (context?.kind === "create" && context.phase === "observing" && status === "unknown") {
      entry.metadata.attachCommand = attachCommand(
        context.target.socketPath,
        `codex-hub-${entry.metadata.operationId}`,
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
  #new(type: HubOperation["type"], sessionId: string | null): Entry {
    if (this.#closed) throw new ManagementError(503, "Server stopped tracking operations");
    this.#prune();
    const timestamp = new Date(this.now()).toISOString();
    const entry: Entry = {
      metadata: {
        attachCommand: null,
        operationId: randomUUID(),
        type,
        sessionId,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      sourceInstanceId: this.managers.defaultSourceInstanceId,
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

import type { CreateSessionRequest } from "../../shared/api-contract.js";
import type { SessionInteractionService } from "../interaction/interaction-service.js";
import type { PaneBindingManager } from "../interaction/pane-binding-manager.js";
import type { RuntimeEvaluator } from "../interaction/runtime-capabilities.js";
import {
  AssociationError,
  type OperationControl,
  type OperationEntry,
  type OperationTimeouts,
} from "./operation-state.js";
import { type ManagementSnapshot, type SessionManagerRegistry } from "./session-manager.js";

/** Adapter launch and association checks; OperationService owns idempotency and occupancy. */
export class SessionLaunchExecutor {
  constructor(
    private readonly sessions: { managementSnapshot(): Promise<ManagementSnapshot> },
    private readonly interaction: Pick<SessionInteractionService, "describe" | "matchesTarget">,
    private readonly managers: SessionManagerRegistry,
    private readonly bindings: PaneBindingManager,
    private readonly control: OperationControl,
    private readonly now: () => number,
    private readonly waitMs: OperationTimeouts,
    private readonly runtime?: RuntimeEvaluator,
  ) {}
  async create(
    entry: OperationEntry,
    input: Extract<CreateSessionRequest, { projectDirectory: string }>,
  ) {
    try {
      const manager = this.managers.get(entry.home);
      const project = await manager.resolveDirectory(input.projectDirectory);
      const working =
        input.workingDirectory === undefined || input.workingDirectory === input.projectDirectory
          ? project
          : await manager.resolveDirectory(input.workingDirectory);
      if (!this.control.pending(entry)) return;
      this.control.transition(entry, { kind: "create", phase: "launching" });
      const target = await manager.launch({
        operationId: entry.metadata.operationId,
        workingDirectory: working.directory,
        worktree: input.worktree,
        yolo: input.yolo ?? false,
        projectDirectory: project.directory,
      });
      if (!this.control.pending(entry)) return;
      this.control.transition(
        entry,
        {
          kind: "create",
          phase: "observing",
          project: project.directory,
          target,
          startedAt: this.now(),
        },
        this.now() + this.waitMs.create,
      );
    } catch (error) {
      this.control.error(entry, error);
    }
  }
  async resume(
    entry: OperationEntry,
    input: Extract<CreateSessionRequest, { resumeSessionId: string }>,
  ) {
    const sessionId = input.resumeSessionId;

    try {
      if (!this.runtime) throw new Error("Resume is unavailable");
      const snapshot = await this.sessions.managementSnapshot();
      const session = snapshot.byId.get(sessionId);
      if (!session) throw new Error("Session not found");
      const attempt = this.bindings.latest(session.id);
      const replacement = this.bindings.replacement(session.id);
      const capability = await this.runtime.evaluate(session);
      if (!capability.resume.allowed) throw new Error(capability.resume.reason!);
      entry.home = session.origin.home;
      entry.resumeNativeId = session.sourceId ?? undefined;
      const manager = this.managers.get(entry.home);
      const directory = capability.directory!;
      if (
        attempt !== this.bindings.latest(session.id) ||
        replacement !== this.bindings.replacement(session.id)
      )
        throw new Error("Session binding changed during validation");
      if (!this.control.pending(entry)) return;
      this.control.transition(entry, { kind: "create", phase: "launching" });
      const target = await manager.launch({
        operationId: entry.metadata.operationId,
        workingDirectory: directory,
        worktree: false,
        yolo: input.yolo ?? false,
        resumeNativeId: session.sourceId!,
        projectDirectory: session.projectDirectory,
      });
      if (!this.control.pending(entry)) return;
      this.control.transition(
        entry,
        {
          kind: "create",
          phase: "observing",
          target,
          project: session.projectDirectory ?? directory,
          startedAt: this.now(),
        },
        this.now() + this.waitMs.create,
      );
    } catch (error) {
      this.control.error(entry, error);
    }
  }
  async observe(entry: OperationEntry) {
    const snapshot = await this.sessions.managementSnapshot();
    if (!this.control.pending(entry)) return;
    const context = entry.stage;
    if (context.kind !== "create" || context.phase !== "observing") return;

    const matches = snapshot.sessions.filter((session) => {
      const attempt = this.bindings.latest(session.id);
      return (
        session.origin.home === entry.home &&
        attempt?.valid &&
        attempt.operationId === entry.metadata.operationId
      );
    });
    if (matches.length > 1)
      throw new AssociationError("Multiple sessions claimed this operation ID");
    const match = matches[0];
    if (!match) return;
    if (
      entry.metadata.mode === "resume" &&
      (match.id !== entry.metadata.sessionId ||
        match.archived ||
        match.sourceId !== entry.resumeNativeId ||
        !match.sourceId)
    )
      throw new AssociationError("Resume did not bind the original session");
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
    if (!this.control.pending(entry)) return;
    if (binding?.supported && binding.state === "unknown") return;
    if (!binding?.supported || binding.state !== "connected")
      throw new AssociationError("The new session binding failed validation");
    const matchesTarget = await this.interaction.matchesTarget(match.id, context.target);
    if (!this.control.pending(entry)) return;
    if (!matchesTarget) throw new AssociationError("Binding does not match the launched target");
    entry.metadata.sessionId = match.id;
    this.control.finish(entry, "succeeded", null);
  }
}

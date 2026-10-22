import type { CreateSessionRequest } from "../../shared/api-contract.js";
import type { SessionInteractionService } from "../interaction/interaction-service.js";
import type { PaneBindingManager } from "../interaction/pane-binding-manager.js";
import type { SessionRuntime } from "../interaction/session-runtime.js";
import {
  AssociationError,
  type OperationControl,
  type OperationEntry,
  type OperationTimeouts,
} from "./operation-state.js";
import {
  type ManagementSnapshot,
  resolveResumeDirectory,
  type SessionManagerRegistry,
} from "./session-manager.js";

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
    private readonly runtime?: SessionRuntime,
  ) {}
  async create(entry: OperationEntry, input: Extract<CreateSessionRequest, { directory: string }>) {
    try {
      const manager = this.managers.get(entry.sourceInstanceId);
      const resolved = await manager.resolveDirectory(input.directory);
      if (!this.control.pending(entry)) return;
      this.control.transition(entry, { kind: "create", phase: "launching" });
      const target = await manager.launch({
        operationId: entry.metadata.operationId,
        directory: resolved.directory,
        worktree: input.worktree,
        yolo: input.yolo ?? false,
        projectDirectory: resolved.directory,
      });
      if (!this.control.pending(entry)) return;
      this.control.transition(
        entry,
        {
          kind: "create",
          phase: "observing",
          project: resolved.directory,
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
      let snapshot = await this.sessions.managementSnapshot();
      let session = snapshot.sessions.find((item) => item.id === sessionId);
      if (!session) throw new Error("Session not found");
      let capability = await this.runtime.evaluate(session, snapshot.sessions);
      if (!capability.resume.allowed) throw new Error(capability.resume.reason!);
      entry.sourceInstanceId = session.origin.sourceInstanceId;
      entry.resumeNativeId = session.sourceId ?? undefined;
      const manager = this.managers.get(entry.sourceInstanceId);
      const attempt = this.bindings.latest(session.id);
      const replacement = this.bindings.replacement(session.id);
      await resolveResumeDirectory(manager, session);
      // Refresh the source after asynchronous checks, then revalidate immediately before launch.
      snapshot = await this.sessions.managementSnapshot();
      const latest = snapshot.sessions.find((item) => item.id === sessionId);
      if (
        !latest ||
        latest.sourceId !== session.sourceId ||
        latest.origin.sourceInstanceId !== entry.sourceInstanceId ||
        latest.workingDirectory !== session.workingDirectory ||
        latest.projectDirectory !== session.projectDirectory ||
        attempt !== this.bindings.latest(session.id) ||
        replacement !== this.bindings.replacement(session.id)
      )
        throw new Error("Session identity or directory changed during validation");
      session = latest;
      capability = await this.runtime.evaluate(session, snapshot.sessions);
      if (!capability.resume.allowed) throw new Error(capability.resume.reason!);
      const resolved = await resolveResumeDirectory(manager, session);
      const finalSnapshot = await this.sessions.managementSnapshot();
      const finalSession = finalSnapshot.sessions.find((item) => item.id === sessionId);
      if (
        !finalSession ||
        finalSession.sourceId !== session.sourceId ||
        finalSession.origin.sourceInstanceId !== session.origin.sourceInstanceId ||
        finalSession.archived ||
        finalSession.workingDirectory !== session.workingDirectory ||
        finalSession.projectDirectory !== session.projectDirectory ||
        finalSnapshot.sessions.filter(
          (item) =>
            item.sourceId === session.sourceId &&
            item.origin.sourceInstanceId === session.origin.sourceInstanceId,
        ).length !== 1 ||
        attempt !== this.bindings.latest(session.id) ||
        replacement !== this.bindings.replacement(session.id)
      )
        throw new Error("Session identity, binding or directory changed during validation");
      if (!this.control.pending(entry)) return;
      this.control.transition(entry, { kind: "create", phase: "launching" });
      const target = await manager.launch({
        operationId: entry.metadata.operationId,
        directory: resolved.directory,
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
          project: session.projectDirectory ?? resolved.directory,
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
        session.origin.sourceInstanceId === entry.sourceInstanceId &&
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
        !match.sourceId ||
        this.#matches(snapshot, entry, match.sourceId).length !== 1)
    )
      throw new AssociationError("Resume did not bind the original unique session");
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

  #matches(snapshot: ManagementSnapshot, entry: OperationEntry, nativeId: string) {
    return snapshot.sessions.filter(
      (session) =>
        session.origin.sourceInstanceId === entry.sourceInstanceId && session.sourceId === nativeId,
    );
  }
}

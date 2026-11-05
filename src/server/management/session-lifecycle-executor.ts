import type { SessionInteractionService } from "../interaction/interaction-service.js";
import type { UploadCleanup } from "../uploads/store.js";
import {
  type OperationControl,
  type OperationEntry,
  type OperationTimeouts,
  type SessionHistoryOperation,
} from "./operation-state.js";
import { SessionExitService } from "./session-exit-service.js";
import { type ManagementSnapshot, type SessionManagerRegistry } from "./session-manager.js";

/** Exit, archive and delete execution, including confirmation of native effects. */
export class SessionLifecycleExecutor {
  readonly #exit: SessionExitService;
  constructor(
    private readonly sessions: { managementSnapshot(): Promise<ManagementSnapshot> },
    private readonly interaction: Pick<
      SessionInteractionService,
      "resolveTarget" | "sendExitKeys" | "killTarget" | "inspectTarget"
    >,
    private readonly managers: SessionManagerRegistry,
    private readonly control: OperationControl,
    private readonly now: () => number,
    private readonly waitMs: OperationTimeouts,
    private readonly uploads?: UploadCleanup,
  ) {
    this.#exit = new SessionExitService(interaction, now);
  }
  async manage(entry: OperationEntry, type: "exit" | "archive" | "delete", sessionId: string) {
    try {
      const snapshot = await this.sessions.managementSnapshot();
      if (!this.control.pending(entry)) return;
      const session = snapshot.byId.get(sessionId);
      if (!session) {
        if (type === "delete") {
          this.control.finish(entry, "succeeded", null);
          this.#cleanup(sessionId);
          return;
        }
        throw new Error("Session not found");
      }
      entry.home = session.origin.home;
      const manager = this.managers.get(entry.home);
      if (type === "archive" && typeof manager.archive !== "function")
        throw new Error(
          "operation_not_supported: Operation is not supported by this session source",
        );
      if (type === "archive" && session.archived) {
        this.control.finish(entry, "succeeded", null);
        return;
      }
      if (type === "exit") {
        await this.#startExit(entry, sessionId, null);
        return;
      }
      const nativeId = session.sourceId;
      if (!nativeId?.trim()) throw new Error("Session has no valid native identity");
      await this.#startExit(entry, sessionId, { type, nativeId });
      if (this.control.pending(entry)) await this.control.observe(entry);
    } catch (error) {
      this.control.error(entry, error);
    }
  }
  async observe(entry: OperationEntry) {
    if (!this.control.pending(entry)) return;
    let context = entry.stage;
    if (context.kind === "exiting") {
      try {
        // Refresh adapter bindings before observing or acting on the fixed target.
        await this.sessions.managementSnapshot();
        if (!this.control.pending(entry)) return;
        const phase = context.task.phase;
        const exited = await context.task.advance();
        if (!this.control.pending(entry)) return;
        if (phase !== context.task.phase)
          entry.metadata.updatedAt = new Date(this.now()).toISOString();
        if (!exited) return;
        if (context.next === null) {
          this.control.finish(entry, "succeeded", null);
          return;
        }
        await this.#nativeOperation(entry, context.next);
        if (!this.control.pending(entry)) return;
      } catch (error) {
        if (this.control.pending(entry))
          this.control.finish(
            entry,
            "unknown",
            error instanceof Error ? error.message : String(error),
          );
        return;
      }
    }
    const snapshot = await this.sessions.managementSnapshot();
    if (!this.control.pending(entry)) return;
    context = entry.stage;
    if (
      (context.kind === "archive" || context.kind === "delete") &&
      context.phase === "confirming"
    ) {
      const matches = this.#matches(snapshot, entry, context.nativeId);
      if (
        (context.kind === "archive" && matches.length === 1 && matches[0]?.archived) ||
        (context.kind === "delete" && matches.length === 0)
      ) {
        this.control.finish(entry, "succeeded", null);
        if (context.kind === "delete" && entry.metadata.sessionId)
          this.#cleanup(entry.metadata.sessionId);
      }
    }
  }
  #cleanup(id: string) {
    void Promise.resolve()
      .then(() => this.uploads?.cleanup(id))
      .catch((error) => {
        console.error("Session attachment cleanup failed", { sessionId: id, error });
      });
  }
  async #startExit(entry: OperationEntry, sessionId: string, next: SessionHistoryOperation | null) {
    const target = await this.interaction.resolveTarget(sessionId);
    if (!this.control.pending(entry)) return;
    if (!target) {
      if (next === null) this.control.finish(entry, "succeeded", null);
      else await this.#nativeOperation(entry, next);
      return;
    }
    const task = this.#exit.start(sessionId, target, this.managers.get(entry.home), () => {
      this.control.timeout(entry);
      if (!this.control.pending(entry)) throw new Error("Exit operation is no longer active");
    });
    this.control.transition(
      entry,
      { kind: "exiting", task, next },
      this.now() + (this.waitMs.exit ?? this.waitMs.archive),
    );
    await this.control.observe(entry);
  }

  async #nativeOperation(entry: OperationEntry, { type, nativeId }: SessionHistoryOperation) {
    if (!this.control.pending(entry)) return;
    this.control.transition(
      entry,
      type === "archive"
        ? { kind: type, phase: "archiving", nativeId }
        : { kind: type, phase: "deleting", nativeId },
      this.now() + 25_000,
    );
    try {
      const manager = this.managers.get(entry.home);
      if (type === "archive") await manager.archive!(nativeId);
      else await manager.delete(nativeId);
      if (!this.control.pending(entry)) return;
      this.control.transition(
        entry,
        { kind: type, phase: "confirming", nativeId },
        this.now() + this.waitMs[type],
      );
    } catch (error) {
      if (!this.control.pending(entry)) return;
      this.control.error(entry, error);
    }
  }

  #matches(snapshot: ManagementSnapshot, entry: OperationEntry, nativeId: string) {
    return snapshot.sessions.filter(
      (session) => session.origin.home === entry.home && session.sourceId === nativeId,
    );
  }
}

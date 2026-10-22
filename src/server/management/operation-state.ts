import type { HubOperation } from "../../shared/api-contract.js";
import type { TmuxBinding } from "../interaction/transport.js";
import type { SessionExitTask } from "./session-exit-service.js";

export type OperationContext =
  | { kind: "create"; phase: "resolving" | "launching" }
  | { kind: "create"; phase: "observing"; target: TmuxBinding; project: string; startedAt: number }
  | { kind: "manage"; phase: "resolving" }
  | { kind: "delete"; phase: "deleting" | "confirming"; nativeId: string }
  | { kind: "archive"; phase: "resolving_target" | "archiving" | "confirming"; nativeId: string }
  | { kind: "exiting"; task: SessionExitTask; nativeId: string | null };
export type OperationStage = OperationContext & { deadline: number | null };
export interface OperationEntry {
  readonly metadata: Omit<HubOperation, "status" | "error" | "phase">;
  result?: Readonly<HubOperation>;
  sourceInstanceId: string;
  resumeNativeId?: string;
  stage: OperationStage | null;
  checking?: Promise<void>;
}

/** Execution can advance an operation, but registration and ownership stay in OperationService. */
export interface OperationControl {
  pending(entry: OperationEntry): entry is OperationEntry & { stage: OperationStage };
  transition(entry: OperationEntry, context: OperationContext, deadline?: number): void;
  finish(
    entry: OperationEntry,
    status: Exclude<HubOperation["status"], "pending">,
    error: string | null,
  ): void;
  error(entry: OperationEntry, error: unknown): void;
  timeout(entry: OperationEntry): void;
  observe(entry: OperationEntry): Promise<void>;
}

export interface OperationTimeouts {
  create: number;
  exit?: number;
  archive: number;
  delete: number;
}

export class AssociationError extends Error {}

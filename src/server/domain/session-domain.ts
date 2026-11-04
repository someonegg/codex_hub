import type { InteractionKey } from "../../shared/interaction.js";

export type DomainSessionId = string;
export type DomainItemId = string;

export type DomainDiagnosticSeverity = "info" | "warning" | "error";

export interface DomainDiagnostic {
  readonly code: string;
  readonly severity: DomainDiagnosticSeverity;
  readonly message: string;
  readonly ordinal: number | null;
}

export interface DomainAgentIdentity {
  readonly taskName: string | null;
  readonly nickname: string | null;
  readonly role: string | null;
}

export interface DomainSessionOrigin {
  readonly sourceType: string;
  readonly home: string;
  readonly agentName: string;
  readonly agentVersion: string | null;
  readonly formatVersion: string | null;
}

export type InteractionBindingAttempt =
  | {
      readonly ordinal: number;
      readonly valid: true;
      readonly operationId?: string;
      readonly projectDirectory?: string;
      readonly taskName?: string | null;
      readonly socketPath: string;
      readonly paneId: string;
    }
  | {
      readonly ordinal: number;
      readonly valid: false;
    };

export type TmuxKey =
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "Enter"
  | "Up"
  | "Down"
  | "Left"
  | "Right"
  | "C-d"
  | "C-c"
  | "C-u"
  | "BTab"
  | "End"
  | "Escape";

export type InteractionKeyBindings = Readonly<
  Record<Exclude<InteractionKey, "interrupt">, TmuxKey>
>;

export interface InteractionKeyStep {
  readonly keys: readonly TmuxKey[];
  readonly delayMs: number;
}

export type DomainAgentInteraction = {
  /** Adapter-owned steps, executed as one ordered transport operation. */
  interruptSteps(): readonly InteractionKeyStep[];
  readonly transport: "tmux";
  readonly bindingCommand: string;
  readonly keyBindings: InteractionKeyBindings;
};

export interface DomainSession {
  readonly id: DomainSessionId;
  readonly sourceId: string | null;
  readonly origin: DomainSessionOrigin;
  readonly title: string;
  readonly workingDirectory: string | null;
  readonly projectDirectory: string | null;
  taskName?: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly archived: boolean;
  readonly isChild?: boolean;
  readonly parentId: DomainSessionId | null;
  readonly childIds: readonly DomainSessionId[];
  readonly agent: DomainAgentIdentity | null;
  readonly messageCount: number;
  readonly warningCount: number;
  readonly diagnostics: readonly DomainDiagnostic[];
}

interface DomainTimelineRecordBase {
  readonly id: DomainItemId;
  readonly ordinal: number;
  readonly timestamp: string | null;
}

export interface DomainMessageRecord extends DomainTimelineRecordBase {
  readonly kind: "message";
  readonly role: "user" | "assistant";
  readonly phase: "update" | "response" | null;
  readonly itemType: string | null;
  readonly markdown: string;
}

export interface DomainUserInputOption {
  readonly label: string;
  readonly description: string;
}

export interface DomainUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly DomainUserInputOption[];
}

export interface DomainUserInputAnswer {
  readonly questionId: string;
  readonly answers: readonly string[];
}

interface DomainUserInputRecordBase extends DomainTimelineRecordBase {
  readonly kind: "user_input";
  readonly callId: string;
}

export interface DomainUserInputRequestRecord extends DomainUserInputRecordBase {
  readonly stage: "request";
  readonly questions: readonly DomainUserInputQuestion[];
}

export interface DomainAnsweredUserInputRecord extends DomainUserInputRecordBase {
  readonly stage: "response";
  readonly outcome: "answered";
  readonly answers: readonly DomainUserInputAnswer[];
}

export interface DomainAbortedUserInputRecord extends DomainUserInputRecordBase {
  readonly stage: "response";
  readonly outcome: "aborted";
}

export interface DomainUnavailableUserInputRecord extends DomainUserInputRecordBase {
  readonly stage: "response";
  readonly outcome: "unavailable";
  readonly summary: string;
}

export type DomainUserInputRecord =
  | DomainUserInputRequestRecord
  | DomainAnsweredUserInputRecord
  | DomainAbortedUserInputRecord
  | DomainUnavailableUserInputRecord;

export type DomainTimelineRecord = DomainMessageRecord | DomainUserInputRecord;

export interface NormalizedSession {
  readonly session: DomainSession;
  readonly timeline: readonly DomainTimelineRecord[];
  readonly interaction?: DomainAgentInteraction | null;
}

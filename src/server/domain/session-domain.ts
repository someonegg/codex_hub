import type { TimelineItem } from "../../shared/domain.js";
import type { InteractionKey } from "../../shared/interaction.js";

export type DomainSessionId = string;

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
}

export type InteractionBindingAttempt =
  | {
      readonly ordinal: number;
      readonly valid: true;
      readonly operationId?: string;
      readonly projectDirectory?: string;
      readonly taskName?: string | null;
      readonly socketPath: string;
      readonly sessionName: string;
    }
  | {
      readonly ordinal: number;
      readonly valid: false;
    };

/** Ordered evidence for a session's claim on an interaction pane. */
export interface DomainBindingEvent {
  readonly sessionId: DomainSessionId;
  readonly time: number;
  readonly ordinal: number;
  readonly position: number;
  readonly attempt: InteractionBindingAttempt;
}

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
  readonly warningCount: number;
  readonly diagnostics: readonly DomainDiagnostic[];
}

export type {
  MessageItem as DomainMessageRecord,
  UserInputAnswer as DomainUserInputAnswer,
  UserInputOption as DomainUserInputOption,
  UserInputQuestion as DomainUserInputQuestion,
  UserInputItem as DomainUserInputRecord,
} from "../../shared/domain.js";

export type DomainTimelineRecord = TimelineItem;

export interface NormalizedSession {
  readonly session: DomainSession;
  readonly timeline: readonly DomainTimelineRecord[];
  readonly interaction?: DomainAgentInteraction | null;
}

export type SessionId = string;
export type ItemId = string;

export interface AgentIdentity {
  taskName: string | null;
  nickname: string | null;
  role: string | null;
}

export interface SessionOrigin {
  sourceType: string;
  home: string;
  agentName: string;
  agentVersion: string | null;
  formatVersion: string | null;
}

export type SessionStatus = "normal" | "live" | "archived";
export interface ResumeCapability {
  allowed: boolean;
  reason: string | null;
}

export interface SessionSummary {
  home: string;
  id: SessionId;
  title: string;
  projectDirectory: string | null;
  taskName?: string | null;
  status: SessionStatus;
  parentId: SessionId | null;
  isChild: boolean;
  updatedAt: string | null;
}

export interface SessionDetail {
  resume: ResumeCapability;
  id: SessionId;
  origin: SessionOrigin;
  title: string;
  workingDirectory: string | null;
  projectDirectory: string | null;
  taskName?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  status: SessionStatus;
  parentId: SessionId | null;
  childIds: SessionId[];
  agent: AgentIdentity | null;
  sourceId: string | null;
}

interface TimelineItemBase {
  readonly id: ItemId;
  readonly ordinal: number;
  readonly timestamp: string | null;
}

export interface MessageItem extends TimelineItemBase {
  readonly kind: "message";
  readonly role: "user" | "assistant";
  readonly phase: "update" | "response" | null;
  readonly itemType: "plan" | null;
  readonly markdown: string;
}

export interface UserInputOption {
  readonly label: string;
  readonly description: string;
}

export interface UserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly UserInputOption[];
}

export interface UserInputAnswer {
  readonly questionId: string;
  readonly answers: readonly string[];
}

interface UserInputItemBase extends TimelineItemBase {
  readonly kind: "user_input";
  readonly callId: string;
}

export interface UserInputRequestItem extends UserInputItemBase {
  readonly stage: "request";
  readonly questions: readonly UserInputQuestion[];
}

export interface AnsweredUserInputItem extends UserInputItemBase {
  readonly stage: "response";
  readonly outcome: "answered";
  readonly answers: readonly UserInputAnswer[];
}

export interface AbortedUserInputItem extends UserInputItemBase {
  readonly stage: "response";
  readonly outcome: "aborted";
}

export interface UnavailableUserInputItem extends UserInputItemBase {
  readonly stage: "response";
  readonly outcome: "unavailable";
  readonly summary: string;
}

export type UserInputItem =
  | UserInputRequestItem
  | AnsweredUserInputItem
  | AbortedUserInputItem
  | UnavailableUserInputItem;

export type TimelineItem = MessageItem | UserInputItem;

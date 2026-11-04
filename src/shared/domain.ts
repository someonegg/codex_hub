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
  messageCount: number;
  sourceId: string | null;
}

interface TimelineItemBase {
  id: ItemId;
  ordinal: number;
  timestamp: string | null;
}

export interface MessageItem extends TimelineItemBase {
  kind: "message";
  role: "user" | "assistant";
  phase: "update" | "response" | null;
  itemType: string | null;
  markdown: string;
}

export interface UserInputOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: UserInputOption[];
}

export interface UserInputAnswer {
  questionId: string;
  answers: string[];
}

interface UserInputItemBase extends TimelineItemBase {
  kind: "user_input";
  callId: string;
}

export interface UserInputRequestItem extends UserInputItemBase {
  stage: "request";
  questions: UserInputQuestion[];
}

export interface AnsweredUserInputItem extends UserInputItemBase {
  stage: "response";
  outcome: "answered";
  answers: UserInputAnswer[];
}

export interface AbortedUserInputItem extends UserInputItemBase {
  stage: "response";
  outcome: "aborted";
}

export interface UnavailableUserInputItem extends UserInputItemBase {
  stage: "response";
  outcome: "unavailable";
  summary: string;
}

export type UserInputItem =
  | UserInputRequestItem
  | AnsweredUserInputItem
  | AbortedUserInputItem
  | UnavailableUserInputItem;

export type TimelineItem = MessageItem | UserInputItem;

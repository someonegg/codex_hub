import type { SessionDetail, SessionSummary, TimelineItem } from "./domain.js";

export * from "./interaction.js";

declare const timelineCursorBrand: unique symbol;
export type TimelineCursor = string & { readonly [timelineCursorBrand]: true };
declare const updateRevisionBrand: unique symbol;
export type UpdateRevision = string & { readonly [updateRevisionBrand]: true };

export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export interface SessionListQuery {
  after?: string;
}

export interface SessionProject {
  id: string;
  directory: string;
}

export interface SessionHome {
  sourceInstanceId: string;
  nickname: string;
}

export interface SessionListResponse {
  homes: SessionHome[];
  revision: string;
  projects: SessionProject[];
  sessions: SessionSummary[];
}

export interface SessionDetailResponse {
  session: SessionDetail;
  interaction: InteractionResponse;
  updateRevision: UpdateRevision;
}

export interface ItemPageQuery {
  limit?: number;
  cursor?: TimelineCursor;
}

export interface ItemPageResponse {
  session: SessionDetail;
  cursor: TimelineCursor;
  hasMore: boolean;
  items: TimelineItem[];
  interaction: InteractionResponse;
  updateRevision: UpdateRevision;
}

export interface SessionUpdatesQuery {
  cursor: TimelineCursor;
  after: UpdateRevision;
}

export interface SessionUpdatesResponse {
  session: SessionDetail;
  cursor: TimelineCursor;
  hasMore: boolean;
  interaction: InteractionResponse;
  updateRevision: UpdateRevision;
}

export interface ToolDetailResponse {
  input: string | null;
  output: string | null;
  truncated: boolean;
}

export interface ToolDetailQuery {
  cursor: TimelineCursor;
}

export interface DirectiveDetailResponse {
  text: string;
  truncated: boolean;
}

export interface DirectiveDetailQuery {
  cursor: TimelineCursor;
}

export interface InternalDetailResponse {
  json: string;
  truncated: boolean;
}

export interface InternalDetailQuery {
  cursor: TimelineCursor;
}

export type InteractionState = "unknown" | "unbound" | "disconnected" | "connected" | "superseded";

export type InteractionResponse =
  | { supported: false; attachCommand: string | null }
  | {
      supported: true;
      state: InteractionState;
      supersededBySessionId: string | null;
      attachCommand: string | null;
    };

export interface TerminalPreviewResponse {
  content: string;
  truncated: boolean;
  capturedAt: string;
}

export interface HubOperation {
  mode?: "new" | "resume";
  target?: { socketPath: string; paneId: string };
  phase: "sending_exit" | "waiting_exit" | "archiving" | "confirming_archive" | null;
  attachCommand: string | null;
  operationId: string;
  type: "create" | "exit" | "archive" | "delete";
  status: "pending" | "succeeded" | "failed" | "unknown";
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}
export type CreateSessionRequest =
  | {
      resumeSessionId: string;
      sourceInstanceId?: never;
      directory?: never;
      worktree?: never;
      yolo?: boolean;
      requestId: string;
    }
  | {
      resumeSessionId?: never;
      sourceInstanceId?: string;
      directory: string;
      worktree: boolean;
      yolo?: boolean;
      requestId: string;
    };

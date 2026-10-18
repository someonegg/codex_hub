import type { SessionDetail, SessionSummary, TimelineItem } from "./domain.js";

export * from "./interaction.js";

declare const timelineCursorBrand: unique symbol;
export type TimelineCursor = string & { readonly [timelineCursorBrand]: true };
declare const liveRevisionBrand: unique symbol;
export type LiveRevision = string & { readonly [liveRevisionBrand]: true };

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

export interface SessionListResponse {
  revision: string;
  projects: SessionProject[];
  sessions: SessionSummary[];
}

export interface SessionDetailResponse {
  session: SessionDetail;
  interaction: InteractionResponse;
  liveRevision: LiveRevision;
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
  liveRevision: LiveRevision;
}

export interface SessionLiveQuery {
  cursor: TimelineCursor;
  after: LiveRevision;
}

export interface SessionLiveResponse {
  session: SessionDetail;
  cursor: TimelineCursor;
  hasMore: boolean;
  interaction: InteractionResponse;
  liveRevision: LiveRevision;
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
  phase: "sending_exit" | "waiting_exit" | "archiving" | "confirming_archive" | null;
  attachCommand: string | null;
  operationId: string;
  type: "create" | "archive" | "delete";
  status: "pending" | "succeeded" | "failed" | "unknown";
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}
export interface CreateSessionRequest {
  directory: string;
  worktree: boolean;
  requestId: string;
}

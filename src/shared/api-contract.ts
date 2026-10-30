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
  directory: string;
}

export interface SessionHome {
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

export interface InspectQuery {
  limit?: number;
  after?: number;
}

export interface InspectResponse {
  session: SessionDetail;
  live: boolean;
  interaction: InteractionResponse;
  items: TimelineItem[];
  nextAfter: number;
  hasMore: boolean;
}

export interface TerminalResponse {
  content: string;
  truncated: boolean;
  capturedAt: string;
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

export type TmuxTarget = { socketPath: string; paneId: string; sessionName: string | null };

export type InteractionResponse =
  | { supported: false; tmux?: TmuxTarget | null; attachCommand: string | null }
  | {
      supported: true;
      tmux?: TmuxTarget | null;
      state: InteractionState;
      activity: "working" | "idle" | "unknown" | null;
      supersededBySessionId: string | null;
      attachCommand: string | null;
    };

export interface TerminalPreviewSnapshot {
  revision: string;
  content: string;
  truncated: boolean;
  capturedAt: string;
}

export interface LineOperation {
  startLine: number;
  deleteCount: number;
  lines: string[];
}

export type TerminalPreviewFrame =
  | ({ type: "snapshot" } & TerminalPreviewSnapshot)
  | {
      type: "delta";
      baseRevision: string;
      revision: string;
      operations: LineOperation[];
      truncated: boolean;
      capturedAt: string;
    };

export interface TerminalPreviewError {
  type: "error";
  code: string;
  message: string;
  retryable: boolean;
}

export type TerminalPreviewMessage = TerminalPreviewFrame | TerminalPreviewError;

export interface HubOperation {
  mode?: "new" | "resume";
  target?: { socketPath: string; paneId: string; sessionName?: string | null };
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
      home?: never;
      projectDirectory?: never;
      workingDirectory?: never;
      worktree?: never;
      yolo?: boolean;
      requestId: string;
    }
  | {
      resumeSessionId?: never;
      home?: string;
      projectDirectory: string;
      workingDirectory?: string;
      worktree: boolean;
      yolo?: boolean;
      requestId: string;
    };

export interface CapabilitiesResponse {
  hosting: boolean;
}

export interface ArtifactSummary {
  id: string;
  title: string;
  updatedAt: string;
  url: string;
}

export interface ArtifactsResponse {
  projects: { directory: string; artifacts: ArtifactSummary[] }[];
}

export interface DiffResponse {
  id: string;
  title: string;
  createdAt: string;
  url: string;
  raw: string;
}

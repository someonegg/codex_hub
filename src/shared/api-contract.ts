import type { SessionDetail, SessionSummary, TimelineItem } from "./domain.js";

export * from "./interaction.js";

declare const stateRevisionBrand: unique symbol;
export type UpdateRevision = string & { readonly [stateRevisionBrand]: true };

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

export interface SessionAgent {
  runtimeName: string;
  management?: { archive: boolean };
  nickname: string;
}

export interface SessionListResponse {
  agents: SessionAgent[];
  revision: string;
  projects: SessionProject[];
  sessions: SessionSummary[];
}

export interface SessionDetailResponse {
  session: SessionDetail;
  interaction: InteractionResponse;
  stateRevision: UpdateRevision;
}

export interface SessionMessagesQuery {
  limit?: number;
  after?: number;
  wait?: boolean;
  stateRevision?: UpdateRevision;
}

export interface SessionMessagesResponse {
  session: SessionDetail;
  stateRevision: UpdateRevision;
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

export type InteractionState = "unknown" | "unbound" | "disconnected" | "connected" | "superseded";

export type TmuxTarget = { socketPath: string; sessionName: string };

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
  target?: { socketPath: string; sessionName: string };
  phase:
    | "sending_exit"
    | "waiting_exit"
    | "archiving"
    | "confirming_archive"
    | "deleting"
    | "confirming_delete"
    | null;
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
      agent?: never;
      projectDirectory?: never;
      taskName?: never;
      workingDirectory?: never;
      worktree?: never;
      yolo?: boolean;
      requestId: string;
    }
  | {
      resumeSessionId?: never;
      agent?: string;
      projectDirectory: string;
      taskName?: string;
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

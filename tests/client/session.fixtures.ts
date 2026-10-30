import type {
  ItemPageResponse,
  TimelineCursor,
  UpdateRevision,
} from "../../src/shared/api-contract";
import type {
  DirectiveItem as Directive,
  SessionDetail,
  ToolItem as Tool,
} from "../../src/shared/domain";

export const SESSION_ID = "abcdefghijklmnopqrstuvwx";
export const CHILD_ID = "zyxwvutsrqponmlkjihgfedc";
export const TIMELINE_CURSOR = "opaque.timeline.cursor" as TimelineCursor;
export const NEXT_TIMELINE_CURSOR = "opaque.timeline.next" as TimelineCursor;
export const UPDATE_REVISION = "opaque.updates.revision" as UpdateRevision;

export const baseSession: SessionDetail = {
  sourceId: "original-session-id",
  itemCount: 3,
  id: SESSION_ID,
  title: "Reader work",
  workingDirectory: "/project/reader",
  projectDirectory: "/project/reader",
  origin: {
    sourceType: "codex-jsonl",
    home: "default",
    agentName: "Codex",
    agentVersion: null,
    formatVersion: null,
  },
  createdAt: "2026-07-28T10:00:00Z",
  updatedAt: "2026-07-28T11:00:00Z",
  status: "normal" as const,
  resume: { allowed: false, reason: "No pane binding has been recorded" },
  parentId: null,
  childIds: [],
  agent: null,
  messageCount: 2,
  toolCount: 1,
};

export const listBody = {
  homes: [{ nickname: "default" }],
  revision: "a".repeat(43),
  sessions: [
    {
      home: "default",
      id: SESSION_ID,
      title: baseSession.title,
      projectId: "project-reader",
      status: "normal" as const,
      parentId: null,
      isChild: false,
      updatedAt: baseSession.updatedAt,
    },
  ],
  projects: [{ id: "project-reader", directory: "/project/reader" }],
};

export function readContext(cursor: TimelineCursor = TIMELINE_CURSOR, hasMore = true) {
  return {
    cursor,
    session: baseSession,
    hasMore,
    updateRevision: UPDATE_REVISION,
  };
}

export const toolItem: Tool = {
  kind: "tool",
  stage: "output",
  id: "tool-2",
  ordinal: 2,
  timestamp: null,
  callId: "call-reader",
  toolName: "exec",
  status: "completed",
  preview: "inspect",
  charCount: 7,
  hasDetail: true,
};

export const directiveItem: Directive = {
  kind: "directive",
  id: "directive-4",
  ordinal: 4,
  timestamp: null,
  summary: "AGENTS.md instructions",
  charCount: 1_892,
  hasDetail: true,
};

export const firstPage: ItemPageResponse = {
  ...readContext(),
  interaction: { supported: false, attachCommand: null },
  updateRevision: UPDATE_REVISION,
  items: [
    {
      kind: "message",
      id: "message-1",
      ordinal: 1,
      timestamp: null,
      role: "user",
      phase: null,
      itemType: null,
      markdown: "Hello",
    },
    toolItem,
  ],
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

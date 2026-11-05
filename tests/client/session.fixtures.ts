import type { SessionMessagesResponse, UpdateRevision } from "../../src/shared/api-contract";
import type { SessionDetail } from "../../src/shared/domain";
export const SESSION_ID = "abcdefghijklmnopqrstuvwx";
export const CHILD_ID = "zyxwvutsrqponmlkjihgfedc";
export const UPDATE_REVISION = "a".repeat(43) as UpdateRevision;
export const baseSession: SessionDetail = {
  sourceId: "original-session-id",
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
};

export const listBody = {
  homes: [{ nickname: "default" }],
  revision: "a".repeat(43),
  sessions: [
    {
      home: "default",
      id: SESSION_ID,
      title: baseSession.title,
      projectDirectory: "/project/reader",
      status: "normal" as const,
      parentId: null,
      isChild: false,
      updatedAt: baseSession.updatedAt,
    },
  ],
  projects: [{ directory: "/project/reader" }],
};

export function readContext(nextAfter = 0, hasMore = true) {
  return {
    nextAfter,
    session: baseSession,
    hasMore,
    stateRevision: UPDATE_REVISION,
  };
}

export const firstPage: SessionMessagesResponse = {
  ...readContext(),
  interaction: { supported: false, attachCommand: null },
  stateRevision: UPDATE_REVISION,
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
  ],
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

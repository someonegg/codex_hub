import { createHash } from "node:crypto";

import type {
  DirectiveDetailResponse,
  InternalDetailResponse,
  ItemPageResponse,
  SessionDetailResponse,
  SessionHome,
  SessionListResponse,
  TimelineCursor,
  ToolDetailResponse,
} from "../../shared/api-contract.js";
import type { SessionDetail, TimelineItem } from "../../shared/domain.js";
import type { DomainSession, DomainTimelineRecord } from "../domain/session-domain.js";
import type {
  DirectiveDetailResult,
  InternalDetailResult,
  ItemPageResult,
  ToolDetailResult,
} from "../repository/session-queries.js";
import { opaqueIdForParts } from "../security/opaque-id.js";

export type SessionNicknameResolver = (session: DomainSession) => string | null;

export class SessionApiMapper {
  constructor(
    private readonly resolveNickname: SessionNicknameResolver = () => null,
    private readonly homes: SessionHome[] = [],
  ) {}

  list(sessions: readonly DomainSession[]): SessionListResponse {
    const projects = new Map<string, { id: string; directory: string }>();
    const summaries = sessions
      .map((session) => {
        const directory = session.projectDirectory;
        const projectId = directory === null ? null : opaqueIdForParts("project", directory);
        const isChild = session.isChild ?? session.parentId !== null;
        if (!isChild && directory !== null && projectId !== null)
          projects.set(projectId, { id: projectId, directory });
        return {
          id: session.id,
          home: session.origin.home,
          title: this.resolveNickname(session) ?? session.title,
          projectId,
          status: session.archived ? ("archived" as const) : ("normal" as const),
          parentId: session.parentId,
          isChild,
          updatedAt: session.updatedAt,
        };
      })
      .sort((a, b) => compareIds(a.id, b.id));
    const structure = {
      homes: [...this.homes].sort((a, b) => compareIds(a.nickname, b.nickname)),
      projects: [...projects.values()].sort((a, b) => compareIds(a.id, b.id)),
      sessions: summaries.map(({ updatedAt, ...summary }) => summary),
    };
    return {
      revision: createHash("sha256").update(JSON.stringify(structure)).digest("base64url"),
      homes: structure.homes,
      projects: structure.projects,
      sessions: summaries,
    };
  }

  detail(result: DomainSession): Omit<SessionDetailResponse, "interaction" | "updateRevision"> {
    return { session: this.sessionDetail(result) };
  }

  itemPage(result: ItemPageResult): Omit<ItemPageResponse, "interaction" | "updateRevision"> {
    return {
      session: this.sessionDetail(result.context.session),
      cursor: result.context.cursor as TimelineCursor,
      hasMore: result.context.hasMore,
      items: result.items.map((item) => this.timelineItem(item)),
    };
  }

  toolDetail(result: ToolDetailResult): ToolDetailResponse {
    return {
      input: result.detail.input,
      output: result.detail.output,
      truncated: result.detail.truncated,
    };
  }

  directiveDetail(result: DirectiveDetailResult): DirectiveDetailResponse {
    return {
      text: result.detail.text,
      truncated: result.detail.truncated,
    };
  }

  internalDetail(result: InternalDetailResult): InternalDetailResponse {
    return {
      json: result.detail.json,
      truncated: result.detail.truncated,
    };
  }

  sessionDetail(session: DomainSession): SessionDetail {
    return {
      resume: { allowed: false, reason: "Runtime validation unavailable" },
      id: session.id,
      origin: { ...session.origin },
      title: session.title,
      nickname: this.resolveNickname(session),
      workingDirectory: session.workingDirectory,
      projectDirectory: session.projectDirectory,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: session.archived ? ("archived" as const) : ("normal" as const),
      parentId: session.parentId,
      childIds: [...session.childIds],
      agent: session.agent === null ? null : { ...session.agent },
      messageCount: session.messageCount,
      toolCount: session.toolCount,
      sourceId: session.sourceId,
      itemCount: session.itemCount,
    };
  }

  timelineItem(item: DomainTimelineRecord): TimelineItem {
    const base = { id: item.id, ordinal: item.ordinal, timestamp: item.timestamp };
    switch (item.kind) {
      case "message":
        return {
          ...base,
          kind: "message",
          role: item.role,
          phase: item.phase,
          itemType: item.itemType,
          markdown: item.markdown,
        };
      case "directive":
        return item.hasDetail
          ? {
              ...base,
              kind: "directive",
              hasDetail: true,
              summary: item.summary,
              charCount: item.charCount,
            }
          : { ...base, kind: "directive", hasDetail: false, text: item.text };
      case "tool": {
        const tool = {
          ...base,
          kind: "tool" as const,
          callId: item.callId,
          toolName: item.toolName,
          preview: item.preview,
          charCount: item.charCount,
          hasDetail: item.hasDetail,
        };
        return item.stage === "call"
          ? { ...tool, stage: "call" }
          : { ...tool, stage: "output", status: item.status };
      }
      case "user_input":
        if (item.stage === "request") {
          return {
            ...base,
            kind: "user_input",
            stage: "request",
            callId: item.callId,
            questions: item.questions.map((question) => ({
              id: question.id,
              header: question.header,
              question: question.question,
              options: question.options.map((option) => ({
                label: option.label,
                description: option.description,
              })),
            })),
          };
        }
        if (item.outcome === "answered") {
          return {
            ...base,
            kind: "user_input",
            stage: "response",
            callId: item.callId,
            outcome: "answered",
            answers: item.answers.map((answer) => ({
              questionId: answer.questionId,
              answers: [...answer.answers],
            })),
          };
        }
        return item.outcome === "unavailable"
          ? {
              ...base,
              kind: "user_input",
              stage: "response",
              callId: item.callId,
              outcome: "unavailable",
              summary: item.summary,
            }
          : {
              ...base,
              kind: "user_input",
              stage: "response",
              callId: item.callId,
              outcome: "aborted",
            };
      case "token":
        return {
          ...base,
          kind: "token",
          tokenUsage: {
            total: item.tokenUsage.total === null ? null : { ...item.tokenUsage.total },
            last: item.tokenUsage.last === null ? null : { ...item.tokenUsage.last },
          },
        };
      case "internal":
        return { ...base, kind: "internal", eventType: item.eventType };
    }
  }
}

function compareIds(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

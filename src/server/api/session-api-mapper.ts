import { createHash } from "node:crypto";

import type {
  SessionDetailResponse,
  SessionHome,
  SessionListResponse,
} from "../../shared/api-contract.js";
import type { SessionDetail, SessionStatus, TimelineItem } from "../../shared/domain.js";
import type { DomainSession, DomainTimelineRecord } from "../domain/session-domain.js";

export type SessionDisplayTitleResolver = (session: DomainSession) => string | null;

export class SessionApiMapper {
  constructor(
    private readonly resolveDisplayTitle: SessionDisplayTitleResolver = () => null,
    private readonly homes: SessionHome[] = [],
  ) {}

  list(
    sessions: readonly DomainSession[],
    effectiveStates?: ReadonlyMap<string, SessionStatus>,
  ): SessionListResponse {
    const projectDirectories = new Set<string>();
    const summaries = sessions
      .map((session) => {
        const projectDirectory = session.projectDirectory;
        const isChild = session.isChild ?? session.parentId !== null;
        if (!isChild && projectDirectory !== null) projectDirectories.add(projectDirectory);
        return {
          id: session.id,
          home: session.origin.home,
          title: this.resolveDisplayTitle(session) ?? session.title,
          projectDirectory,
          ...(session.taskName ? { taskName: session.taskName } : {}),
          status:
            effectiveStates?.get(session.id) ??
            (session.archived ? ("archived" as const) : ("normal" as const)),
          parentId: session.parentId,
          isChild,
          updatedAt: session.updatedAt,
        };
      })
      .sort((a, b) => compareIds(a.id, b.id));
    const structure = {
      homes: [...this.homes].sort((a, b) => compareIds(a.nickname, b.nickname)),
      projects: [...projectDirectories].sort(compareIds).map((directory) => ({ directory })),
      sessions: summaries.map(({ updatedAt, ...summary }) => summary),
    };
    return {
      revision: createHash("sha256").update(JSON.stringify(structure)).digest("base64url"),
      homes: structure.homes,
      projects: structure.projects,
      sessions: summaries,
    };
  }

  detail(result: DomainSession): Omit<SessionDetailResponse, "interaction" | "stateRevision"> {
    return { session: this.sessionDetail(result) };
  }

  sessionDetail(session: DomainSession): SessionDetail {
    return {
      resume: { allowed: false, reason: "Runtime validation unavailable" },
      id: session.id,
      origin: { ...session.origin },
      title: this.resolveDisplayTitle(session) ?? session.title,
      workingDirectory: session.workingDirectory,
      projectDirectory: session.projectDirectory,
      ...(session.taskName ? { taskName: session.taskName } : {}),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: session.archived ? ("archived" as const) : ("normal" as const),
      parentId: session.parentId,
      childIds: [...session.childIds],
      agent: session.agent === null ? null : { ...session.agent },
      messageCount: session.messageCount,
      sourceId: session.sourceId,
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
    }
  }
}

function compareIds(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

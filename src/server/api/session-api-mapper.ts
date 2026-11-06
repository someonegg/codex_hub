import { createHash } from "node:crypto";

import type { SessionAgent, SessionListResponse } from "../../shared/api-contract.js";
import type { SessionDetail, SessionStatus } from "../../shared/domain.js";
import type { DomainSession } from "../domain/session-domain.js";

export type SessionDisplayTitleResolver = (session: DomainSession) => string | null;

export class SessionApiMapper {
  constructor(
    private readonly resolveDisplayTitle: SessionDisplayTitleResolver = () => null,
    private readonly agents: SessionAgent[] = [],
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
          agent: session.origin.agent,
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
      agents: [...this.agents],
      projects: [...projectDirectories].sort(compareIds).map((directory) => ({ directory })),
      sessions: summaries.map(({ updatedAt, ...summary }) => summary),
    };
    return {
      revision: createHash("sha256").update(JSON.stringify(structure)).digest("base64url"),
      agents: structure.agents,
      projects: structure.projects,
      sessions: summaries,
    };
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
      subagent: session.subagent === null ? null : { ...session.subagent },
      sourceId: session.sourceId,
    };
  }
}

function compareIds(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

import type { SessionDetail } from "../../src/shared/domain.js";

import type { DomainSession, NormalizedSession } from "../../src/server/domain/session-domain.js";

export function sessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "session",
    origin: {
      sourceType: "test",
      sourceInstanceId: "test",
      agentName: "Test",
      agentVersion: null,
      formatVersion: null,
    },
    title: "Session",
    nickname: null,
    workingDirectory: null,
    projectDirectory: null,
    createdAt: null,
    updatedAt: null,
    status: "normal",
    resume: { allowed: false, reason: "Unavailable" },
    parentId: null,
    childIds: [],
    agent: null,
    messageCount: 0,
    toolCount: 0,
    sourceId: "session",
    itemCount: 0,
    ...overrides,
  };
}

export function domainSession(overrides: Partial<DomainSession> = {}): DomainSession {
  const { nickname: _nickname, status: _status, resume: _resume, ...session } = sessionDetail();
  return { ...session, archived: false, diagnostics: [], warningCount: 0, ...overrides };
}

export function normalizedSession(overrides: Partial<DomainSession> = {}): NormalizedSession {
  return {
    session: domainSession(overrides),
    timeline: [],
    toolDetails: new Map(),
    directiveDetails: new Map(),
    internalDetails: new Map(),
  };
}

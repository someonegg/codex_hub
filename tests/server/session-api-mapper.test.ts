import { describe, expect, it } from "vitest";

import { SessionApiMapper } from "../../src/server/api/session-api-mapper.js";
import { domainSession } from "../helpers/session-fixtures.js";

const session = domainSession({
  id: "session-one",
  sourceId: "private-source-id",
  origin: {
    sourceType: "test",
    sourceInstanceId: "test-source",
    agentName: "Test Agent",
    agentVersion: "1.0.0",
    formatVersion: null,
  },
  title: "Session one",
  workingDirectory: "/project",
  projectDirectory: "/project",
  createdAt: "2026-07-28T00:00:00Z",
  updatedAt: "2026-07-28T01:00:00Z",
  childIds: ["child"],
  agent: { taskName: "task", nickname: null, role: "worker" },
  messageCount: 1,
  warningCount: 1,
  diagnostics: [
    {
      code: "partial",
      severity: "warning",
      message: "Partial",
      ordinal: 2,
    },
  ],
  itemCount: 1,
});

describe("session API mapping", () => {
  it("maps compact catalog records and independent, immutable details", () => {
    const mapper = new SessionApiMapper();
    const catalog = mapper.list([session]);
    expect(catalog.sessions[0]).toEqual({
      id: session.id,
      sourceInstanceId: session.origin.sourceInstanceId,
      title: session.title,
      projectId: expect.any(String),
      status: "normal",
      parentId: null,
      isChild: false,
      updatedAt: session.updatedAt,
    });
    const detail = mapper.detail(session);
    detail.session.childIds.push("mutated");
    expect(detail.session).not.toHaveProperty("diagnostics");
    expect(detail.session).not.toHaveProperty("warningCount");
    expect(session.childIds).toEqual(["child"]);
    expect(session.diagnostics[0]!.message).toBe("Partial");
    expect(detail.session.origin).not.toBe(session.origin);
  });

  it("excludes child-only projects while retaining child sessions in the catalog", () => {
    const mapper = new SessionApiMapper();
    const catalog = mapper.list([
      session,
      { ...session, id: "child", parentId: session.id, projectDirectory: "/child-only" },
      {
        ...session,
        id: "orphan-child",
        isChild: true,
        projectDirectory: "/orphan-only",
      },
      { ...session, id: "shared-child", parentId: session.id },
    ]);

    expect(catalog.projects).toEqual([{ id: expect.any(String), directory: "/project" }]);
    expect(catalog.sessions).toHaveLength(4);
    expect(catalog.sessions.filter((item) => item.isChild).map((item) => item.id)).toEqual([
      "child",
      "orphan-child",
      "shared-child",
    ]);
    expect(mapper.list([{ ...session, isChild: true }]).projects).toEqual([]);
  });
});

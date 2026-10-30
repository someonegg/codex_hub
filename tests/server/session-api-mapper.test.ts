import { describe, expect, it } from "vitest";

import { SessionApiMapper } from "../../src/server/api/session-api-mapper.js";
import { domainSession } from "../helpers/session-fixtures.js";

const session = domainSession({
  id: "session-one",
  sourceId: "private-source-id",
  origin: {
    sourceType: "test",
    home: "test-source",
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
      home: session.origin.home,
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

  it("resolves display titles consistently and falls back to the original title", () => {
    const mapper = new SessionApiMapper(() => "Index title");
    const detail = mapper.detail(session).session;
    expect(mapper.list([session]).sessions[0]!.title).toBe("Index title");
    expect(detail.title).toBe("Index title");
    expect(detail).not.toHaveProperty("nickname");
    expect(new SessionApiMapper().detail(session).session.title).toBe(session.title);
  });

  it("hashes resolved titles and effective status while excluding timestamps", () => {
    const mapper = new SessionApiMapper(() => "Index title");
    const baseline = mapper.list([session]).revision;
    expect(mapper.list([{ ...session, updatedAt: "later" }]).revision).toBe(baseline);
    expect(new SessionApiMapper(() => "Renamed").list([session]).revision).not.toBe(baseline);
    const live = new Map([[session.id, "live" as const]]);
    const liveRevision = mapper.list([session], live).revision;
    expect(liveRevision).not.toBe(baseline);
    expect(mapper.list([{ ...session, archived: true }], live).revision).toBe(liveRevision);
    expect(mapper.list([session], new Map()).revision).toBe(baseline);
  });
});

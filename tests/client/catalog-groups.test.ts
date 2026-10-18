import { describe, expect, it } from "vitest";

import type { SessionListResponse } from "../../src/shared/api-contract";

import { catalogGroups, projectForSession } from "../../src/client/state/catalog-groups";

const session = (id: string, projectId: string | null, extra = {}) => ({
  id,
  sourceInstanceId: "source-instance",
  projectId,
  title: id,
  archived: false,
  parentId: null,
  isChild: false,
  updatedAt: null,
  ...extra,
});
const list: SessionListResponse = {
  revision: "revision",
  homes: [],
  projects: [
    { id: "p1", directory: "/one/app" },
    { id: "p2", directory: "/two/app" },
    { id: "empty", directory: "/empty" },
  ],
  sessions: [
    session("a", "p1"),
    session("b", "p1"),
    session("c", "p2", { archived: true }),
    session("orphan", "p2", { isChild: true }),
    session("unknown", null),
    session("child", "p1", { isChild: true, parentId: "a" }),
  ],
};
describe("project navigation derivation", () => {
  it("counts only visible main sessions, hides empty projects, and disambiguates names", () => {
    expect(
      catalogGroups(list, false).map((group) => [
        group.id,
        group.name,
        group.sessions.map((item) => item.id),
      ]),
    ).toEqual([
      [null, "Unknown project", ["unknown"]],
      ["p1", "app · /one/app", ["a", "b"]],
    ]);
    const all = catalogGroups(list, true);
    expect(all.map((group) => group.id)).toEqual([null, "p1", "p2"]);
    expect(all.find((group) => group.id === "p2")?.sessions.map((item) => item.id)).toEqual(["c"]);
  });
  it("sorts by updatedAt with deterministic ID ties and missing times last", () => {
    const groups = catalogGroups(
      {
        ...list,
        sessions: list.sessions.map((item) => ({
          ...item,
          updatedAt:
            item.id === "c"
              ? "2026-10-17T00:00:00Z"
              : item.id === "b"
                ? "2026-10-16T00:00:00Z"
                : null,
        })),
      },
      true,
    );
    expect(groups.map((group) => group.id)).toEqual(["p2", "p1", null]);
    expect(groups[1]?.sessions.map((item) => item.id)).toEqual(["b", "a"]);
    expect(
      catalogGroups(
        {
          ...list,
          sessions: list.sessions.map((item) => ({
            ...item,
            updatedAt: "2026-10-16T00:00:00Z",
          })),
        },
        false,
      )
        .find((group) => group.id === "p1")
        ?.sessions.map((item) => item.id),
    ).toEqual(["a", "b"]);
  });
});

it("locates a child under its main ancestor project and terminates broken parent chains", () => {
  const children: SessionListResponse = {
    ...list,
    sessions: [
      ...list.sessions,
      session("different-directory", "p2", { isChild: true, parentId: "a" }),
      session("cycle", "p2", { isChild: true, parentId: "cycle" }),
    ],
  };
  expect(projectForSession(children, "different-directory")).toBe("p1");
  expect(projectForSession(children, "orphan")).toBe("p2");
  expect(projectForSession(children, "cycle")).toBe("p2");
});

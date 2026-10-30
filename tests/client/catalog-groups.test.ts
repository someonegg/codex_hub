import { describe, expect, it } from "vitest";

import type { SessionListResponse } from "../../src/shared/api-contract";

import { catalogGroups, projectForSession } from "../../src/client/state/catalog-groups";

const session = (id: string, projectDirectory: string | null, extra = {}) => ({
  id,
  home: "default",
  projectDirectory,
  title: id,
  status: "normal" as const,
  parentId: null,
  isChild: false,
  updatedAt: null,
  ...extra,
});
const list: SessionListResponse = {
  revision: "revision",
  homes: [],
  projects: [{ directory: "/one/app" }, { directory: "/two/app" }, { directory: "/empty" }],
  sessions: [
    session("a", "/one/app"),
    session("b", "/one/app"),
    session("c", "/two/app", { status: "archived" as const }),
    session("orphan", "/two/app", { isChild: true }),
    session("unknown", null),
    session("child", "/one/app", { isChild: true, parentId: "a" }),
  ],
};
describe("project navigation derivation", () => {
  it("counts only visible main sessions, hides empty projects, and disambiguates names", () => {
    expect(
      catalogGroups(list, false).map((group) => [
        group.directory,
        group.name,
        group.sessions.map((item) => item.id),
      ]),
    ).toEqual([
      [null, "Unknown project", ["unknown"]],
      ["/one/app", "app · /one/app", ["a", "b"]],
    ]);
    const all = catalogGroups(list, true);
    expect(all.map((group) => group.directory)).toEqual([null, "/one/app", "/two/app"]);
    expect(
      all.find((group) => group.directory === "/two/app")?.sessions.map((item) => item.id),
    ).toEqual(["c"]);
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
    expect(groups.map((group) => group.directory)).toEqual(["/two/app", "/one/app", null]);
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
        .find((group) => group.directory === "/one/app")
        ?.sessions.map((item) => item.id),
    ).toEqual(["a", "b"]);
  });
});

it("locates a child under its main ancestor project and terminates broken parent chains", () => {
  const children: SessionListResponse = {
    ...list,
    sessions: [
      ...list.sessions,
      session("different-directory", "/two/app", { isChild: true, parentId: "a" }),
      session("cycle", "/two/app", { isChild: true, parentId: "cycle" }),
    ],
  };
  expect(projectForSession(children, "different-directory")).toBe("/one/app");
  expect(projectForSession(children, "orphan")).toBe("/two/app");
  expect(projectForSession(children, "cycle")).toBe("/two/app");
});

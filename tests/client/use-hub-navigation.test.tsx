// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import type { SessionListResponse } from "../../src/shared/api-contract";

import { useHubNavigation } from "../../src/client/state/use-hub-navigation";
import { CHILD_ID, listBody, SESSION_ID } from "./session.fixtures";

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

it("expands a directly opened session once its catalog arrives, and allows manual collapse", () => {
  window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
  const { result, rerender } = renderHook(
    ({ list }: { list: SessionListResponse | null }) => useHubNavigation(list),
    { initialProps: { list: null as SessionListResponse | null } },
  );
  expect(result.current.navigation.expanded).toEqual([]);
  rerender({ list: listBody });
  expect(result.current.navigation.expanded).toEqual(["project-reader"]);
  act(() => result.current.toggleProject("project-reader"));
  rerender({ list: { ...listBody, revision: "b".repeat(43) } });
  expect(result.current.navigation.expanded).toEqual([]);
});

it("expands a new destination when it appears in a later catalog snapshot", () => {
  const { result, rerender } = renderHook(({ list }) => useHubNavigation(list), {
    initialProps: { list: listBody },
  });
  act(() => result.current.navigate(CHILD_ID));
  expect(result.current.navigation.expanded).toEqual([]);
  rerender({
    list: {
      ...listBody,
      sessions: [...listBody.sessions, { ...listBody.sessions[0]!, id: CHILD_ID }],
    },
  });
  expect(result.current.navigation.expanded).toEqual(["project-reader"]);
});

it("opens the main ancestor's project for a child without closing other projects", () => {
  const list: SessionListResponse = {
    ...listBody,
    projects: [...listBody.projects, { id: "worktree", directory: "/project/worktree" }],
    sessions: [
      ...listBody.sessions,
      {
        ...listBody.sessions[0]!,
        id: CHILD_ID,
        parentId: SESSION_ID,
        isChild: true,
        projectId: "worktree",
      },
    ],
  };
  const { result } = renderHook(() => useHubNavigation(list));
  act(() => result.current.toggleProject("other"));
  act(() => result.current.navigate(CHILD_ID));
  expect(result.current.navigation.expanded).toEqual(["other", "project-reader"]);
});

it("reopens the destination project on browser history navigation", () => {
  const { result } = renderHook(() => useHubNavigation(listBody));
  act(() => result.current.navigate(SESSION_ID));
  act(() => result.current.toggleProject("project-reader"));
  act(() => result.current.navigate(null));
  expect(result.current.navigation.expanded).toEqual([]);
  act(() => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(result.current.navigation.expanded).toEqual(["project-reader"]);
});

it("expands Unknown project for sessions without an associated project", () => {
  const list: SessionListResponse = {
    ...listBody,
    sessions: [{ ...listBody.sessions[0]!, projectId: null }],
  };
  const { result } = renderHook(() => useHubNavigation(list));
  act(() => result.current.navigate(SESSION_ID));
  expect(result.current.navigation.expanded).toEqual(["unknown"]);
});

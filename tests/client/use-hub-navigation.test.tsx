// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import type { SessionListResponse } from "../../src/shared/api-contract";

import { browserStorage } from "../../src/client/state/browser-storage";
import { useHubNavigation } from "../../src/client/state/use-hub-navigation";
import { CHILD_ID, listBody, SESSION_ID } from "./session.fixtures";

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

it("debounces sidebar scroll saves and flushes pending positions when hidden or unmounted", () => {
  vi.useFakeTimers();
  const save = vi.spyOn(browserStorage, "setItem");
  const { result, unmount } = renderHook(() => useHubNavigation(listBody));
  const element = document.createElement("nav");
  vi.spyOn(element, "getClientRects").mockReturnValue([{ height: 100 }] as unknown as DOMRectList);
  const storedScroll = () => JSON.parse(browserStorage.getItem("ahub.navigation")!).scroll;
  save.mockClear();
  try {
    element.scrollTop = 100;
    act(() => result.current.persistScroll(element));
    act(() => vi.advanceTimersByTime(200));
    element.scrollTop = 200;
    act(() => result.current.persistScroll(element));
    act(() => vi.advanceTimersByTime(200));
    expect(save).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(50));
    expect(save).toHaveBeenCalledTimes(1);
    expect(storedScroll()).toBe(200);

    element.scrollTop = 300;
    act(() => result.current.persistScroll(element));
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(storedScroll()).toBe(300);
    hidden.mockRestore();

    element.scrollTop = 400;
    act(() => result.current.persistScroll(element));
    unmount();
    expect(storedScroll()).toBe(400);
    expect(save).toHaveBeenCalledTimes(3);
    act(() => vi.runOnlyPendingTimers());
    expect(save).toHaveBeenCalledTimes(3);
  } finally {
    unmount();
    save.mockRestore();
    vi.useRealTimers();
  }
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

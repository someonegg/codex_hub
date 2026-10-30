import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { SessionListResponse } from "../../shared/api-contract";

import { browserStorage } from "./browser-storage";
import { projectForSession } from "./catalog-groups";

const NAVIGATION_KEY = "ahub.navigation";
const SCROLL_SAVE_DELAY_MS = 250;
interface NavigationState {
  includeArchived: boolean;
  expanded: string[];
  scroll: number;
}
function readNavigation(): NavigationState {
  try {
    const value = JSON.parse(browserStorage.getItem(NAVIGATION_KEY) ?? "null");
    if (value && typeof value.includeArchived === "boolean" && Array.isArray(value.expanded))
      return value;
  } catch {
    /* Optional storage. */
  }
  return { includeArchived: false, expanded: [], scroll: 0 };
}
function saveNavigation(navigation: NavigationState) {
  try {
    browserStorage.setItem(NAVIGATION_KEY, JSON.stringify(navigation));
  } catch {
    /* Optional storage. */
  }
}
export function useHubNavigation(list: SessionListResponse | null) {
  const [uploadsOpen, setUploadsOpen] = useState(() =>
    /\/uploads\/?$/.test(window.location.pathname),
  );
  const [sessionId, setSessionId] = useState(() => sessionIdFromPath(window.location.pathname));
  const [navigation, setNavigation] = useState(readNavigation);
  const navigationRef = useRef(navigation);
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  navigationRef.current = { ...navigation, scroll: navigationRef.current.scroll };
  const sidebar = useRef<HTMLElement>(null);
  const projectNav = useRef<HTMLElement>(null);
  const navigate = (id: string | null) => {
    const path = id === null ? "/" : `/sessions/${id}`;
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setUploadsOpen(false);
    setSessionId(id);
    window.scrollTo(0, 0);
    if (id === null) {
      const target =
        sidebar.current?.querySelector<HTMLAnchorElement>(`a[href="/sessions/${sessionId}"]`) ??
        sidebar.current?.querySelector<HTMLAnchorElement>(".hub-brand a");
      requestAnimationFrame(() => target?.focus({ preventScroll: true }));
    }
  };
  useEffect(() => {
    const pop = () => {
      setSessionId(sessionIdFromPath(window.location.pathname));
      setUploadsOpen(/\/uploads\/?$/.test(window.location.pathname));
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (scrollSaveTimer.current !== null) {
      clearTimeout(scrollSaveTimer.current);
      scrollSaveTimer.current = null;
    }
    saveNavigation(navigationRef.current);
  }, [navigation]);
  useEffect(() => {
    const flushScroll = () => {
      if (scrollSaveTimer.current === null) return;
      clearTimeout(scrollSaveTimer.current);
      scrollSaveTimer.current = null;
      saveNavigation(navigationRef.current);
    };
    const onVisibilityChange = () => {
      if (document.hidden) flushScroll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flushScroll();
    };
  }, []);
  const catalogLoaded = list !== null;
  useLayoutEffect(() => {
    if (projectNav.current?.getClientRects().length)
      projectNav.current.scrollTop = navigationRef.current.scroll;
  }, [catalogLoaded, sessionId]);
  useEffect(() => {
    if (sessionId === null) document.title = "Codex Hub";
  }, [sessionId]);
  const selectedProject = projectForSession(list, sessionId);
  let projectKey: string | undefined;
  if (selectedProject !== undefined) {
    projectKey = list?.projects.find((project) => project.id === selectedProject)?.id ?? "unknown";
  }
  useEffect(() => {
    if (projectKey === undefined) return;
    setNavigation((current) =>
      current.expanded.includes(projectKey)
        ? current
        : { ...current, expanded: [...current.expanded, projectKey] },
    );
  }, [sessionId, projectKey]);
  const setIncludeArchived = (includeArchived: boolean) => {
    setNavigation((current) => ({ ...current, includeArchived }));
  };
  const toggleProject = (key: string) => {
    setNavigation((current) => ({
      ...current,
      expanded: current.expanded.includes(key)
        ? current.expanded.filter((id) => id !== key)
        : [...current.expanded, key],
    }));
  };
  const persistScroll = (element: HTMLElement) => {
    if (!element.getClientRects().length) return;
    navigationRef.current.scroll = element.scrollTop;
    if (scrollSaveTimer.current !== null) clearTimeout(scrollSaveTimer.current);
    scrollSaveTimer.current = setTimeout(() => {
      scrollSaveTimer.current = null;
      saveNavigation(navigationRef.current);
    }, SCROLL_SAVE_DELAY_MS);
  };
  return {
    sessionId,
    uploadsOpen,
    navigation,
    setIncludeArchived,
    toggleProject,
    persistScroll,
    sidebar,
    projectNav,
    navigate,
    selectedProject,
  };
}

function sessionIdFromPath(pathname: string): string | null {
  const match = /^\/sessions\/([A-Za-z0-9_-]{20,100})(?:\/uploads)?\/?$/.exec(pathname);
  return match?.[1] ?? null;
}

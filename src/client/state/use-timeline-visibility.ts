import { useCallback, useState } from "react";

import { browserStorage } from "./browser-storage";
import {
  DEFAULT_TIMELINE_VISIBILITY,
  type TimelineVisibility,
  type TimelineVisibilityKey,
} from "./timeline-visibility";

export const TIMELINE_VISIBILITY_STORAGE_KEY = "codex-sessions-reader.timeline-visibility.v1";

export function useTimelineVisibility() {
  const [visibility, setVisibilityState] = useState<TimelineVisibility>(readVisibility);

  const setVisibility = useCallback((key: TimelineVisibilityKey, visible: boolean) => {
    setVisibilityState((current) => {
      if (current[key] === visible) return current;

      const next = { ...current, [key]: visible };
      try {
        browserStorage.setItem(TIMELINE_VISIBILITY_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage can be unavailable in privacy modes; visibility still works in memory.
      }
      return next;
    });
  }, []);

  return { visibility, setVisibility };
}

function readVisibility(): TimelineVisibility {
  try {
    const stored: unknown = JSON.parse(
      browserStorage.getItem(TIMELINE_VISIBILITY_STORAGE_KEY) ?? "null",
    );
    if (!isRecord(stored)) return { ...DEFAULT_TIMELINE_VISIBILITY };

    return {
      directive: booleanOrDefault(stored.directive, DEFAULT_TIMELINE_VISIBILITY.directive),
      tools: booleanOrDefault(stored.tools, DEFAULT_TIMELINE_VISIBILITY.tools),
      token: booleanOrDefault(stored.token, DEFAULT_TIMELINE_VISIBILITY.token),
      internal: booleanOrDefault(stored.internal, DEFAULT_TIMELINE_VISIBILITY.internal),
    };
  } catch {
    return { ...DEFAULT_TIMELINE_VISIBILITY };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

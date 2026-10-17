import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  TIMELINE_VISIBILITY_STORAGE_KEY,
  useTimelineVisibility,
} from "../../src/client/state/use-timeline-visibility";

// @vitest-environment jsdom

describe("timeline visibility preference", () => {
  it("persists session flags and restores them after remounting", () => {
    const first = renderHook(() => useTimelineVisibility());

    act(() => first.result.current.setVisibility("directive", true));
    act(() => first.result.current.setVisibility("tools", true));
    act(() => first.result.current.setVisibility("token", true));
    act(() => first.result.current.setVisibility("internal", true));

    expect(JSON.parse(sessionStorage.getItem(TIMELINE_VISIBILITY_STORAGE_KEY)!)).toEqual({
      directive: true,
      tools: true,
      token: true,
      internal: true,
    });

    first.unmount();
    const restored = renderHook(() => useTimelineVisibility());
    expect(restored.result.current.visibility).toEqual({
      directive: true,
      tools: true,
      token: true,
      internal: true,
    });
  });

  it("uses defaults for malformed and missing stored fields", () => {
    sessionStorage.setItem(
      TIMELINE_VISIBILITY_STORAGE_KEY,
      JSON.stringify({
        directive: true,
        tools: "yes",
        token: false,
      }),
    );

    const partial = renderHook(() => useTimelineVisibility());
    expect(partial.result.current.visibility).toEqual({
      directive: true,
      tools: false,
      token: false,
      internal: false,
    });
    partial.unmount();

    sessionStorage.setItem(TIMELINE_VISIBILITY_STORAGE_KEY, "{not-json");
    const malformed = renderHook(() => useTimelineVisibility());
    expect(malformed.result.current.visibility).toEqual({
      directive: false,
      tools: false,
      token: false,
      internal: false,
    });
  });
});

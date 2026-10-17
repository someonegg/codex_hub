import type { TimelineItem } from "../../shared/domain";

export interface TimelineVisibility {
  directive: boolean;
  tools: boolean;
  token: boolean;
  internal: boolean;
}

export type TimelineVisibilityKey = keyof TimelineVisibility;

export const DEFAULT_TIMELINE_VISIBILITY: TimelineVisibility = {
  directive: false,
  tools: false,
  token: false,
  internal: false,
};

function isTimelineItemVisible(item: TimelineItem, visibility: TimelineVisibility): boolean {
  switch (item.kind) {
    case "message":
    case "user_input":
      return true;
    case "directive":
      return visibility.directive;
    case "tool":
      return visibility.tools;
    case "token":
      return visibility.token;
    case "internal":
      return visibility.internal;
  }
}

export function filterVisibleTimelineItems(
  items: readonly TimelineItem[],
  visibility: TimelineVisibility,
): TimelineItem[] {
  return items.filter(
    (item, index) =>
      isTimelineItemVisible(item, visibility) && !isDuplicateInlineDirective(items, index),
  );
}

function isDuplicateInlineDirective(items: readonly TimelineItem[], index: number): boolean {
  const item = items[index];
  if (item?.kind !== "directive" || item.hasDetail) return false;

  const start = Math.max(0, index - 2);
  const end = Math.min(items.length - 1, index + 2);
  for (let neighborIndex = start; neighborIndex <= end; neighborIndex += 1) {
    const neighbor = items[neighborIndex];
    if (neighbor?.kind === "message" && neighbor.markdown === item.text) return true;
  }
  return false;
}

import { memo, useCallback, useMemo, useState } from "react";

import type { TimelineCursor } from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";
import type { UserInputItem as UserInputTimelineItem } from "../../shared/domain";

import { DirectiveItem } from "./DirectiveItem";
import { EventMark } from "./EventMark";
import { InfiniteScrollSentinel } from "./InfiniteScrollSentinel";
import { InternalEventItem } from "./InternalEventItem";
import { isPlan, MessageItem } from "./MessageItem";
import { TokenItem } from "./TokenItem";
import { ToolItem } from "./ToolItem";
import { type UserInputCardEntry, UserInputItem } from "./UserInputItem";

interface TimelineProps {
  items: TimelineItem[];
  sessionId: string;
  cursor: TimelineCursor;
  hasMore: boolean;
  loading: boolean;
  readerBusy?: boolean;
  paginationEnabled?: boolean;
  paginationFrozen?: boolean;
  onLoadMore: () => void;
  onTimelineConflict: () => void;
}

export const Timeline = memo(function Timeline({
  items,
  sessionId,
  cursor,
  hasMore,
  loading,
  readerBusy = loading,
  paginationEnabled = true,
  paginationFrozen = false,
  onLoadMore,
  onTimelineConflict,
}: TimelineProps) {
  const latestPlanId = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      if (item.kind === "message" && isPlan(item)) return item.id;
    }
    return null;
  }, [items]);
  const [plans, setPlans] = useState(() => ({
    sessionId,
    latestPlanId,
    openIds: new Set(latestPlanId === null ? [] : [latestPlanId]),
  }));
  if (plans.sessionId !== sessionId || plans.latestPlanId !== latestPlanId) {
    setPlans({
      sessionId,
      latestPlanId,
      openIds: new Set(latestPlanId === null ? [] : [latestPlanId]),
    });
  }
  const togglePlan = useCallback((id: string) => {
    setPlans((current) => {
      const openIds = new Set(current.openIds);
      if (openIds.has(id)) openIds.delete(id);
      else openIds.add(id);
      return { ...current, openIds };
    });
  }, []);
  const entries = useMemo(() => projectUserInputCards(items), [items]);
  return (
    <>
      <ol className="timeline" aria-label="Session timeline">
        {entries.map((item) => (
          <li className={`trace-event ${classFor(item)}`} key={`${sessionId}:${item.id}`}>
            <EventMark item={item} />
            <TimelineContent
              item={item}
              planOpen={plans.openIds.has(item.id)}
              onTogglePlan={togglePlan}
              sessionId={sessionId}
              cursor={cursor}
              onTimelineConflict={onTimelineConflict}
            />
          </li>
        ))}
      </ol>
      {hasMore && paginationEnabled && !paginationFrozen ? (
        <InfiniteScrollSentinel
          enabled={!readerBusy}
          triggerKey={cursor}
          loading={loading}
          loadingLabel="Loading more events…"
          onLoadMore={onLoadMore}
        />
      ) : null}
    </>
  );
});

function TimelineContent({
  item,
  sessionId,
  cursor,
  onTimelineConflict,
  planOpen,
  onTogglePlan,
}: Pick<TimelineProps, "sessionId" | "cursor" | "onTimelineConflict"> & {
  item: TimelineEntry;
  planOpen: boolean;
  onTogglePlan: (id: string) => void;
}) {
  switch (item.kind) {
    case "message":
      return <MessageItem item={item} planOpen={planOpen} onTogglePlan={onTogglePlan} />;
    case "directive":
      return (
        <DirectiveItem
          item={item}
          sessionId={sessionId}
          cursor={cursor}
          onTimelineConflict={onTimelineConflict}
        />
      );
    case "tool":
      return (
        <ToolItem
          item={item}
          sessionId={sessionId}
          cursor={cursor}
          onTimelineConflict={onTimelineConflict}
        />
      );
    case "user_input":
      return <UserInputItem entry={item} />;
    case "token":
      return <TokenItem item={item} />;
    case "internal":
      return (
        <InternalEventItem
          item={item}
          sessionId={sessionId}
          cursor={cursor}
          onTimelineConflict={onTimelineConflict}
        />
      );
  }
}

function classFor(item: TimelineEntry): string {
  if (item.kind === "message") {
    if (item.role === "user") return "human";
    if (item.phase === "final") return "final";
    return "assistant";
  }
  return item.kind;
}

type TimelineEntry = Exclude<TimelineItem, UserInputTimelineItem> | UserInputCardEntry;

function projectUserInputCards(items: readonly TimelineItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const latestRequests = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "user_input") {
      entries.push(item);
      continue;
    }
    if (item.stage === "request") {
      latestRequests.set(item.callId, entries.length);
      entries.push({
        kind: "user_input",
        id: item.id,
        ordinal: item.ordinal,
        timestamp: item.timestamp,
        request: item,
        response: null,
      });
      continue;
    }
    const requestIndex = latestRequests.get(item.callId);
    const request = requestIndex === undefined ? undefined : entries[requestIndex];
    if (requestIndex !== undefined && request?.kind === "user_input") {
      entries[requestIndex] = { ...request, response: item };
    } else {
      entries.push({
        kind: "user_input",
        id: item.id,
        ordinal: item.ordinal,
        timestamp: item.timestamp,
        request: null,
        response: item,
      });
    }
  }
  return entries;
}

import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TimelineItem } from "../../shared/domain";
import type { UserInputItem as UserInputTimelineItem } from "../../shared/domain";

import { t } from "../i18n";
import { EventMark } from "./EventMark";
import { InfiniteScrollSentinel } from "./InfiniteScrollSentinel";
import { isPlan, MessageItem } from "./MessageItem";
import { type UserInputCardEntry, UserInputItem } from "./UserInputItem";

interface TimelineProps {
  items: TimelineItem[];
  sessionId: string;
  hasMore: boolean;
  loading: boolean;
  readerBusy?: boolean;
  onLoadMore: () => void;
}

export const Timeline = memo(function Timeline({
  items,
  sessionId,
  hasMore,
  loading,
  readerBusy = loading,
  onLoadMore,
}: TimelineProps) {
  useTranslation();
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
      <ol className="timeline" aria-label={t("sessionTimeline")}>
        {entries.map((item) => (
          <li className={`trace-event ${classFor(item)}`} key={`${sessionId}:${item.id}`}>
            <EventMark item={item} />
            <TimelineContent
              item={item}
              planOpen={plans.openIds.has(item.id)}
              onTogglePlan={togglePlan}
            />
          </li>
        ))}
      </ol>
      {hasMore ? (
        <InfiniteScrollSentinel
          enabled={!readerBusy}
          triggerKey={String(items.at(-1)?.ordinal ?? 0)}
          loading={loading}
          loadingLabel={t("loadingMoreMessages")}
          onLoadMore={onLoadMore}
        />
      ) : null}
    </>
  );
});

function TimelineContent({
  item,
  planOpen,
  onTogglePlan,
}: {
  item: TimelineEntry;
  planOpen: boolean;
  onTogglePlan: (id: string) => void;
}) {
  useTranslation();
  switch (item.kind) {
    case "message":
      return <MessageItem item={item} planOpen={planOpen} onTogglePlan={onTogglePlan} />;
    case "user_input":
      return <UserInputItem entry={item} />;
  }
}

function classFor(item: TimelineEntry): string {
  if (item.kind === "message") {
    if (item.role === "user") return "human";
    if (item.phase === "response") return "response";
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

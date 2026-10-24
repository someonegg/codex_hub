import { type ReactNode, useMemo, useState } from "react";

import type { InteractionResponse } from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";

import type { ReaderContext } from "../state/session-reader-state";
import {
  filterVisibleTimelineItems,
  type TimelineVisibility,
  type TimelineVisibilityKey,
} from "../state/timeline-visibility";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { PageJumpControls } from "./PageJumpControls";
import { SessionHeader } from "./SessionHeader";
import { SessionInteraction } from "./SessionInteraction";
import { Timeline } from "./Timeline";

interface SessionReaderProps {
  homeNickname?: string;
  recoveryActions?: ReactNode;
  operationStatus?: ReactNode;
  managementBusy?: boolean;
  management?: ReactNode;
  onNavigate?: (sessionId: string) => void;
  related?: ReactNode;
  context: ReaderContext;
  items: TimelineItem[];
  interaction: InteractionResponse | null;
  visibility: TimelineVisibility;
  onVisibilityChange: (key: TimelineVisibilityKey, visible: boolean) => void;
  readerLoading: boolean;
  readerBusy: boolean;
  onLoadMore: () => void;
  onTimelineConflict: () => void;
  timelineConflict: boolean;
  timelineRenderGeneration: number;
  onRefreshLatest: () => Promise<unknown>;
  error?: string | null;
  onDismissError?: () => void;
}

export function SessionReader({
  homeNickname,
  recoveryActions,
  operationStatus,
  managementBusy,
  management,
  onNavigate,
  related,
  context,
  items,
  interaction,
  visibility,
  onVisibilityChange,
  readerLoading,
  readerBusy,
  onLoadMore,
  onTimelineConflict,
  timelineConflict,
  timelineRenderGeneration,
  onRefreshLatest,
  error,
  onDismissError,
}: SessionReaderProps) {
  const [interactionPanel, setInteractionPanel] = useState<HTMLElement | null>(null);
  const visibleItems = useMemo(
    () => filterVisibleTimelineItems(items, visibility),
    [items, visibility],
  );
  const hasMore = context.hasMore;
  let latestMessage: TimelineItem | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "message" || item.kind === "user_input") {
      latestMessage = item;
      break;
    }
  }
  const previewAutoExpandKey =
    !hasMore &&
    latestMessage &&
    (latestMessage.kind === "user_input" ||
      (latestMessage.kind === "message" &&
        latestMessage.role === "assistant" &&
        latestMessage.phase === "final" &&
        latestMessage.itemType === "Plan"))
      ? latestMessage.id
      : null;
  return (
    <section className="reader" aria-labelledby="session-title">
      <SessionHeader
        homeNickname={homeNickname}
        management={management}
        session={context.session}
        visibility={visibility}
        onVisibilityChange={onVisibilityChange}
      />
      {related}
      {visibleItems.length === 0 && !readerLoading ? (
        <EmptyState title="This session has no visible events">
          {emptyStateMessage(visibility, hasMore)}
        </EmptyState>
      ) : null}
      {visibleItems.length > 0 || hasMore ? (
        <Timeline
          key={timelineRenderGeneration}
          items={visibleItems}
          sessionId={context.session.id}
          cursor={context.cursor}
          hasMore={hasMore}
          loading={readerLoading}
          readerBusy={readerBusy}
          paginationEnabled={true}
          paginationFrozen={timelineConflict}
          onLoadMore={onLoadMore}
          onTimelineConflict={onTimelineConflict}
        />
      ) : null}
      {context.session.status !== "archived" ? (
        <SessionInteraction
          key={context.session.id}
          onPanelElement={setInteractionPanel}
          recoveryActions={recoveryActions}
          operationStatus={operationStatus}
          managementBusy={managementBusy}
          interaction={interaction}
          onNavigate={onNavigate}
          sessionId={context.session.id}
          itemCount={context.session.itemCount}
          updatedAt={context.session.updatedAt}
          previewAutoExpandKey={previewAutoExpandKey}
        />
      ) : null}
      {error && onDismissError ? (
        <ErrorState title="Could not load session" message={error} onDismiss={onDismissError} />
      ) : null}
      {timelineConflict ? (
        <aside className="continuity-notice" role="alert">
          <div>
            <strong>Session content has changed</strong>
            <p>
              Your reading position has been preserved. Reload to read the latest version from the
              first page.
            </p>
          </div>
          <button type="button" disabled={readerBusy} onClick={onRefreshLatest}>
            Reload latest version
          </button>
        </aside>
      ) : null}
      <PageJumpControls interactionPanel={interactionPanel} />
    </section>
  );
}

function emptyStateMessage(visibility: TimelineVisibility, hasMore: boolean): string {
  if (hasMore) {
    return "No visible events in the loaded range. Keep scrolling or change a visibility filter.";
  }
  if (Object.values(visibility).some((visible) => !visible)) {
    return "Try showing more event types, or wait for the session to update.";
  }
  return "Wait for the session to update.";
}

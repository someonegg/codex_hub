import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { InteractionResponse } from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";

import { t } from "../i18n";
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
  useTranslation();
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
        latestMessage.phase === "response" &&
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
        <EmptyState title={t("thisSessionHasNoVisibleEvents")}>
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
        <ErrorState title={t("couldNotLoadSession")} message={error} onDismiss={onDismissError} />
      ) : null}
      {timelineConflict ? (
        <aside className="continuity-notice" role="alert">
          <div>
            <strong>{t("sessionContentHasChanged")}</strong>
            <p>
              {t("yourReadingPositionHasBeenPreservedReloadToReadTheLatestVersionFromTheFirstPage")}
            </p>
          </div>
          <button type="button" disabled={readerBusy} onClick={onRefreshLatest}>
            {t("reloadLatestVersion")}
          </button>
        </aside>
      ) : null}
      <PageJumpControls interactionPanel={interactionPanel} />
    </section>
  );
}

function emptyStateMessage(visibility: TimelineVisibility, hasMore: boolean): string {
  if (hasMore) {
    return t("noVisibleEventsInTheLoadedRangeKeepScrollingOrChangeAVisibilityFilter");
  }
  if (Object.values(visibility).some((visible) => !visible)) {
    return t("tryShowingMoreEventTypesOrWaitForTheSessionToUpdate");
  }
  return t("waitForTheSessionToUpdate");
}

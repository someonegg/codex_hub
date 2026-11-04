import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import type { InteractionResponse } from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";

import { t } from "../i18n";
import type { ReaderContext } from "../state/session-reader-state";
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
  readerLoading: boolean;
  readerBusy: boolean;
  onLoadMore: () => void;
  onRefreshLatest: () => Promise<unknown>;
  error?: string | null;
  retrying?: boolean;
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
  readerLoading,
  readerBusy,
  onLoadMore,
  onRefreshLatest,
  error,
  retrying,
}: SessionReaderProps) {
  useTranslation();
  const [interactionPanel, setInteractionPanel] = useState<HTMLElement | null>(null);
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
        onRefresh={() => void onRefreshLatest()}
        refreshing={readerLoading}
      />
      {related}
      {items.length === 0 && !readerLoading ? (
        <EmptyState title={t("thisSessionHasNoMessages")}>
          {t("waitForTheSessionToUpdate")}
        </EmptyState>
      ) : null}
      {items.length > 0 || hasMore ? (
        <Timeline
          items={items}
          sessionId={context.session.id}
          hasMore={hasMore}
          loading={readerLoading}
          readerBusy={readerBusy}
          paginationEnabled={true}
          onLoadMore={onLoadMore}
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
          previewAutoExpandKey={previewAutoExpandKey}
        />
      ) : null}
      {error ? (
        <ErrorState
          title={t("couldNotLoadSession")}
          message={error}
          retryNotice={retrying ? t("automaticallyRetrying") : undefined}
        />
      ) : null}
      <PageJumpControls interactionPanel={interactionPanel} />
    </section>
  );
}

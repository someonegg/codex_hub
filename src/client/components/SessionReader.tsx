import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SessionMessagesResponse } from "../../shared/api-contract";

import { t } from "../i18n";
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
  context: SessionMessagesResponse;
  readerLoading: boolean;
  readerBusy: boolean;
  onLoadMore: () => void;
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
  readerLoading,
  readerBusy,
  onLoadMore,
  error,
  retrying,
}: SessionReaderProps) {
  useTranslation();
  const [interactionPanel, setInteractionPanel] = useState<HTMLElement | null>(null);
  const { hasMore, items, interaction } = context;
  const latestMessage = items.at(-1) ?? null;
  const previewAutoExpandKey =
    !hasMore &&
    latestMessage &&
    (latestMessage.kind === "user_input" ||
      (latestMessage.kind === "message" &&
        latestMessage.role === "assistant" &&
        latestMessage.phase === "response" &&
        latestMessage.itemType === "plan"))
      ? latestMessage.id
      : null;
  return (
    <section className="reader" aria-labelledby="session-title">
      <SessionHeader
        homeNickname={homeNickname}
        management={management}
        session={context.session}
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

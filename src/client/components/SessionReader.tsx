import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SessionMessagesResponse } from "../../shared/api-contract";

import { t } from "../i18n";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { EventMark } from "./EventMark";
import { MessageItem } from "./MessageItem";
import { PageJumpControls } from "./PageJumpControls";
import { SessionHeader } from "./SessionHeader";
import { SessionInteraction } from "./SessionInteraction";
import { Timeline } from "./Timeline";

interface SessionReaderProps {
  agentNickname?: string;
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
  agentNickname,
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
  const [preview, setPreview] = useState<{
    sessionId: string;
    items: typeof items;
    message: string;
  } | null>(null);
  // The reader preserves the items array when a poll contains no displayable messages.
  const messagePreview =
    preview?.sessionId === context.session.id && preview.items === items ? preview : null;
  if (preview && !messagePreview) setPreview(null);
  const showMessagePreview = (message: string) => {
    const next = { sessionId: context.session.id, items, message };
    setPreview(next);
    return () => setPreview((current) => (current === next ? null : current));
  };
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
        agentNickname={agentNickname}
        management={management}
        session={context.session}
      />
      {related}
      {items.length === 0 && !readerLoading && !messagePreview ? (
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
      {messagePreview ? (
        <ol
          className="timeline message-preview"
          aria-label={t("messagePreview")}
          aria-live="polite"
        >
          <li className="trace-event human">
            <EventMark item={{ kind: "message" }} />
            <MessageItem
              preview
              item={{
                kind: "message",
                id: "preview",
                ordinal: 0,
                timestamp: null,
                role: "user",
                phase: null,
                itemType: null,
                markdown: messagePreview.message,
              }}
            />
          </li>
        </ol>
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
          onMessagePreview={showMessagePreview}
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

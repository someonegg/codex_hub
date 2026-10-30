import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SessionHome } from "../shared/api-contract";
import type { SessionSummary } from "../shared/domain";

import { ErrorState } from "./components/ErrorState";
import { ManageSession, OperationStatus, ResumeSession } from "./components/HubManagement";
import { InternalLink } from "./components/InternalLink";
import { SessionReader } from "./components/SessionReader";
import { StatusBadge } from "./components/StatusBadge";
import { t } from "./i18n";
import { browserStorage } from "./state/browser-storage";
import { useHubOperation } from "./state/use-hub-operation";
import { useSessionReader } from "./state/use-session-reader";
import { useTimelineVisibility } from "./state/use-timeline-visibility";

interface SessionPageProps {
  homes?: readonly SessionHome[];
  sessionId: string;
  sessions?: readonly SessionSummary[];
  includeArchived?: boolean;
  onNavigate?: (id: string | null) => void;
  onCatalogChanged?: () => void;
  onUpdatedAt?: (id: string, updatedAt: string | null) => void;
}

export function SessionPage({
  sessionId,
  sessions = [],
  homes = [],
  includeArchived = false,
  onNavigate,
  onCatalogChanged,
  onUpdatedAt,
}: SessionPageProps) {
  useTranslation();
  const children = sessions.filter(
    (session) =>
      session.parentId === sessionId && (includeArchived || session.status !== "archived"),
  );
  const childSessionsKey = `ahub.child-sessions.${sessionId}`;
  const [childrenExpanded, setChildrenExpanded] = useState(
    () => browserStorage.getItem(childSessionsKey) === "true",
  );
  const focused = useRef(false);
  const timelineVisibility = useTimelineVisibility();
  const reader = useSessionReader(sessionId);
  const [managementOperation, setManagementOperation] = useState(false);
  const operation = useHubOperation(sessionId, (op) => {
    onCatalogChanged?.();
    if (op.type === "delete") onNavigate?.(null);
    else void reader.refreshLatest();
  });
  const showManagementStatus = operation.operation
    ? operation.operation.type === "archive" || operation.operation.type === "delete"
    : managementOperation;
  const sessionTitle = reader.context === null ? null : reader.context.session.title;

  const parentId = reader.context?.session.parentId ?? null;
  const parent = sessions.find((session) => session.id === parentId);
  const displayedId = reader.context?.session.id;
  const updatedAt = reader.context?.session.updatedAt;
  useEffect(() => {
    if (displayedId !== undefined && updatedAt !== undefined) onUpdatedAt?.(displayedId, updatedAt);
  }, [displayedId, updatedAt, onUpdatedAt]);

  useEffect(() => {
    document.title = sessionTitle === null ? "Codex Hub" : `${sessionTitle} · Codex Hub`;
  }, [sessionTitle]);

  useEffect(() => {
    if (sessionTitle !== null && !focused.current) {
      focused.current = true;
      document.getElementById("session-title")?.focus({ preventScroll: true });
    }
  }, [sessionTitle]);

  return (
    <div className="reader-page">
      {reader.context ? (
        <SessionReader
          homeNickname={homes.length > 1 ? reader.context.session.origin.home : undefined}
          managementBusy={operation.busy}
          operationStatus={
            !showManagementStatus ? <OperationStatus controller={operation} /> : null
          }
          recoveryActions={
            !(reader.interaction?.supported && reader.interaction.state === "connected") ? (
              <ResumeSession
                key={sessionId}
                session={reader.context.session}
                controller={operation}
                onStart={() => setManagementOperation(false)}
              />
            ) : null
          }
          management={
            <ManageSession
              key={sessionId}
              interaction={reader.interaction}
              controller={operation}
              showStatus={showManagementStatus}
              onStart={() => setManagementOperation(true)}
              session={reader.context.session}
              onDeleted={() => {
                onCatalogChanged?.();
                onNavigate?.(null);
              }}
              onChanged={() => {
                void reader.refreshLatest();
                onCatalogChanged?.();
              }}
            />
          }
          related={
            <>
              {parentId !== null ? (
                <nav className="parent-session child-sessions" aria-label={t("parentSession")}>
                  <InternalLink
                    href={`/sessions/${parentId}`}
                    onNavigate={onNavigate ? () => onNavigate(parentId) : undefined}
                  >
                    {t("parentSessionLabel")}
                    {parent ? (
                      <>
                        {" "}
                        · {parent.title} <StatusBadge status={parent.status} />
                      </>
                    ) : null}
                  </InternalLink>
                </nav>
              ) : null}
              {children.length ? (
                <details
                  className="child-session-group"
                  open={childrenExpanded}
                  onToggle={(event) => {
                    const open = event.currentTarget.open;
                    setChildrenExpanded(open);
                    browserStorage.setItem(childSessionsKey, String(open));
                  }}
                >
                  <summary>
                    {t("childSessionsLabel")} {children.length}
                  </summary>
                  <nav className="child-sessions" aria-label={t("childSessions")}>
                    {children.map((session) => (
                      <InternalLink
                        key={session.id}
                        href={`/sessions/${session.id}`}
                        onNavigate={onNavigate ? () => onNavigate(session.id) : undefined}
                      >
                        {session.title}
                        <StatusBadge status={session.status} />
                      </InternalLink>
                    ))}
                  </nav>
                </details>
              ) : null}
            </>
          }
          context={reader.context}
          items={reader.items}
          interaction={reader.interaction}
          onNavigate={onNavigate}
          visibility={timelineVisibility.visibility}
          onVisibilityChange={timelineVisibility.setVisibility}
          readerLoading={reader.readerLoading}
          readerBusy={reader.operation !== null}
          onLoadMore={reader.loadMore}
          onTimelineConflict={reader.markTimelineConflict}
          timelineConflict={reader.timelineConflict}
          timelineRenderGeneration={reader.timelineRenderGeneration}
          onRefreshLatest={reader.refreshLatest}
          error={reader.readerError}
          onDismissError={reader.clearReaderError}
        />
      ) : reader.readerError ? (
        <section className="reader">
          <ErrorState
            title={reader.missing ? t("sessionNotFound") : t("couldNotLoadSession")}
            message={reader.readerError}
          />
          {reader.missing ? (
            <InternalLink href="/" onNavigate={onNavigate ? () => onNavigate(null) : undefined}>
              {t("backToHome")}
            </InternalLink>
          ) : (
            <button
              className="load-more"
              type="button"
              disabled={reader.operation !== null}
              onClick={() => void reader.retryOpen()}
            >
              {t("retryOpeningSession")}
            </button>
          )}
        </section>
      ) : (
        <section className="reader reader-welcome">
          <p className="loading" role="status">
            {t("openingSession")}
          </p>
        </section>
      )}
    </div>
  );
}

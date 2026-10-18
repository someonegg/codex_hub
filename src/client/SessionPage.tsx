import { useEffect, useRef } from "react";

import type { SessionHome } from "../shared/api-contract";
import type { SessionSummary } from "../shared/domain";

import { ErrorState } from "./components/ErrorState";
import { ManageSession } from "./components/HubManagement";
import { InternalLink } from "./components/InternalLink";
import { SessionReader } from "./components/SessionReader";
import { sessionDisplayTitle } from "./session-title";
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
  const children = sessions.filter(
    (session) => session.parentId === sessionId && (includeArchived || !session.archived),
  );
  const focused = useRef(false);
  const timelineVisibility = useTimelineVisibility();
  const reader = useSessionReader(sessionId);
  const sessionTitle = reader.context === null ? null : sessionDisplayTitle(reader.context.session);

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
          management={
            <ManageSession
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
              {homes.length > 1 ? (
                <p className="session-home">
                  Home:{" "}
                  {
                    homes.find(
                      (home) =>
                        home.sourceInstanceId === reader.context!.session.origin.sourceInstanceId,
                    )?.nickname
                  }
                </p>
              ) : null}
              {parentId !== null ? (
                <nav className="parent-session child-sessions" aria-label="Parent session">
                  <InternalLink
                    href={`/sessions/${parentId}`}
                    onNavigate={onNavigate ? () => onNavigate(parentId) : undefined}
                  >
                    ← Parent session
                    {parent ? ` · ${parent.title}${parent.archived ? " · Archived" : ""}` : ""}
                  </InternalLink>
                </nav>
              ) : null}
              {children.length ? (
                <details className="child-session-group">
                  <summary>Child sessions · {children.length}</summary>
                  <nav className="child-sessions" aria-label="Child sessions">
                    {children.map((session) => (
                      <InternalLink
                        key={session.id}
                        href={`/sessions/${session.id}`}
                        onNavigate={onNavigate ? () => onNavigate(session.id) : undefined}
                      >
                        {session.title}
                        {session.archived ? " · Archived" : ""}
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
            title={reader.missing ? "Session not found" : "Could not load session"}
            message={reader.readerError}
          />
          {reader.missing ? (
            <InternalLink href="/" onNavigate={onNavigate ? () => onNavigate(null) : undefined}>
              Back to home
            </InternalLink>
          ) : (
            <button
              className="load-more"
              type="button"
              disabled={reader.operation !== null}
              onClick={() => void reader.retryOpen()}
            >
              Retry opening session
            </button>
          )}
        </section>
      ) : (
        <section className="reader reader-welcome">
          <p className="loading" role="status">
            Opening session…
          </p>
        </section>
      )}
    </div>
  );
}

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { SessionDetail } from "../../shared/domain";

import { formatDate, t } from "../i18n";
import { StatusBadge } from "./StatusBadge";
import { UploadHistoryLink } from "./UploadHistoryLink";

interface SessionHeaderProps {
  homeNickname?: string;
  management?: ReactNode;
  session: SessionDetail;
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function SessionHeader({
  homeNickname,
  management,
  session,
  onRefresh,
  refreshing,
}: SessionHeaderProps) {
  useTranslation();
  const updatedAt = formatTimestamp(session.updatedAt);

  return (
    <header className="reader-header">
      <div>
        <div className="session-title-row">
          <h2 id="session-title" tabIndex={-1}>
            {session.title}
          </h2>
          {management}
        </div>
        <div className="session-metadata">
          <StatusBadge status={session.status} />
          <span>{session.origin.agentName}</span>
          {homeNickname !== undefined ? (
            <>
              <span>·</span>
              <span>
                {t("homeLabel")} {homeNickname}
              </span>
            </>
          ) : null}
          <span>·</span>
          <span>{updatedAt}</span>
          <span>·</span>
          <UploadHistoryLink sessionId={session.id} className="session-uploads-link" />
        </div>
        <div className="reader-controls">
          {onRefresh ? (
            <button type="button" disabled={refreshing} onClick={onRefresh}>
              {t("refresh")}
            </button>
          ) : null}
          <details className="session-information" key={session.id}>
            <summary>{t("sessionInformation")}</summary>
            <div className="session-information-content">
              {session.taskName ? (
                <p className="session-meta">
                  {t("task")} <span>{session.taskName}</span>
                </p>
              ) : null}
              <p className="session-meta">
                {t("projectDirectory")} <code>{session.projectDirectory ?? t("unavailable")}</code>
              </p>
              <p className="session-meta">
                {t("workingDirectory")} <code>{session.workingDirectory ?? t("unavailable")}</code>
              </p>
              <p className="session-origin">{sessionOriginLabel(session.origin)}</p>
              <p className="session-source-id">
                {t("originalSessionID")} <code>{session.sourceId ?? t("unavailable")}</code>
              </p>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}

function formatTimestamp(value: string | null): string {
  if (value === null) return t("timeUnavailable");
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? t("timeUnavailable")
    : formatDate(date, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

function sessionOriginLabel(origin: SessionDetail["origin"]): string {
  let label = origin.agentName;
  if (origin.agentVersion !== null) label += ` ${origin.agentVersion}`;
  return label;
}

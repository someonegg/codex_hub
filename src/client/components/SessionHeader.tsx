import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { SessionDetail } from "../../shared/domain";

import type { PlainMessageKey } from "../i18n";
import { formatDate, t } from "../i18n";
import type { TimelineVisibility, TimelineVisibilityKey } from "../state/timeline-visibility";
import { StatusBadge } from "./StatusBadge";
import { UploadHistoryLink } from "./UploadHistoryLink";

interface SessionHeaderProps {
  homeNickname?: string;
  management?: ReactNode;
  session: SessionDetail;
  visibility: TimelineVisibility;
  onVisibilityChange: (key: TimelineVisibilityKey, visible: boolean) => void;
}

export function SessionHeader({
  homeNickname,
  management,
  session,
  visibility,
  onVisibilityChange,
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
          <span>{t("events", { count: session.itemCount })}</span>
          <span>·</span>
          <UploadHistoryLink sessionId={session.id} className="session-uploads-link" />
        </div>
        <div className="reader-controls">
          <details className="session-information" key={session.id}>
            <summary>{t("sessionInformation")}</summary>
            <div className="session-information-content">
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
          <div className="event-toggles" role="group" aria-label={t("timelineEventVisibility")}>
            {VISIBILITY_TOGGLES.map(({ key, label }) => (
              <label className="check-row event-toggle" key={key}>
                <input
                  type="checkbox"
                  checked={visibility[key]}
                  onChange={(event) => onVisibilityChange(key, event.target.checked)}
                />
                {t(label)}
              </label>
            ))}
          </div>
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

const VISIBILITY_TOGGLES: Array<{
  key: TimelineVisibilityKey;
  label: PlainMessageKey;
}> = [
  { key: "directive", label: "directiveEvent" },
  { key: "tools", label: "toolEvent" },
  { key: "token", label: "tokenEvent" },
  { key: "internal", label: "internalEvent" },
];

function sessionOriginLabel(origin: SessionDetail["origin"]): string {
  let label = origin.agentName;
  if (origin.agentVersion !== null) label += ` ${origin.agentVersion}`;
  if (origin.formatVersion !== null) label += ` · format ${origin.formatVersion}`;
  return label;
}

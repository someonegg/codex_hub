import type { ReactNode } from "react";

import type { SessionDetail } from "../../shared/domain";

import { sessionDisplayTitle } from "../session-title";
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

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function SessionHeader({
  homeNickname,
  management,
  session,
  visibility,
  onVisibilityChange,
}: SessionHeaderProps) {
  const updatedAt = formatTimestamp(session.updatedAt);

  return (
    <header className="reader-header">
      <div>
        <div className="session-title-row">
          <h2 id="session-title" tabIndex={-1}>
            {sessionDisplayTitle(session)}
          </h2>
          {management}
        </div>
        <div className="session-metadata">
          <StatusBadge status={session.status} />
          <span>{session.origin.agentName}</span>
          {homeNickname !== undefined ? (
            <>
              <span>·</span>
              <span>Home: {homeNickname}</span>
            </>
          ) : null}
          <span>·</span>
          <span>{updatedAt}</span>
          <span>·</span>
          <span>{session.itemCount} events</span>
          <span>·</span>
          <UploadHistoryLink sessionId={session.id} className="session-uploads-link" />
        </div>
        <div className="reader-controls">
          <details className="session-information" key={session.id}>
            <summary>Session information</summary>
            <div className="session-information-content">
              <p className="session-meta">
                Project Directory · <code>{session.projectDirectory ?? "Unavailable"}</code>
              </p>
              <p className="session-meta">
                Working Directory · <code>{session.workingDirectory ?? "Unavailable"}</code>
              </p>
              <p className="session-origin">{sessionOriginLabel(session.origin)}</p>
              <p className="session-source-id">
                Original session ID · <code>{session.sourceId ?? "Unavailable"}</code>
              </p>
            </div>
          </details>
          <div className="event-toggles" role="group" aria-label="Timeline event visibility">
            {VISIBILITY_TOGGLES.map(({ key, label }) => (
              <label className="check-row event-toggle" key={key}>
                <input
                  type="checkbox"
                  checked={visibility[key]}
                  onChange={(event) => onVisibilityChange(key, event.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}

function formatTimestamp(value: string | null): string {
  if (value === null) return "Time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Time unavailable" : DATE_FORMAT.format(date);
}

const VISIBILITY_TOGGLES: Array<{
  key: TimelineVisibilityKey;
  label: string;
}> = [
  { key: "directive", label: "directive" },
  { key: "tools", label: "tool" },
  { key: "token", label: "token" },
  { key: "internal", label: "internal" },
];

function sessionOriginLabel(origin: SessionDetail["origin"]): string {
  let label = origin.agentName;
  if (origin.agentVersion !== null) label += ` ${origin.agentVersion}`;
  if (origin.formatVersion !== null) label += ` · format ${origin.formatVersion}`;
  return label;
}

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TimelineCursor, ToolDetailResponse } from "../../shared/api-contract";
import type { ToolItem as Tool } from "../../shared/domain";

import { api } from "../api/client";
import { t } from "../i18n";
import { useLazyDetail } from "../state/use-lazy-detail";
import { CharacterCount } from "./CharacterCount";
import { EventDetail } from "./EventDetail";
import { EventTime } from "./EventTime";

interface ToolItemProps {
  item: Tool;
  sessionId: string;
  cursor: TimelineCursor;
  onTimelineConflict: () => void;
}

export function ToolItem({ item, sessionId, cursor, onTimelineConflict }: ToolItemProps) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const loadDetail = useCallback(
    (requestCursor: TimelineCursor, signal: AbortSignal): Promise<ToolDetailResponse> =>
      api.tool(sessionId, item.id, { cursor: requestCursor }, signal),
    [item.id, sessionId],
  );
  const { detail, error, retry } = useLazyDetail({
    enabled: open && item.hasDetail,
    cursor,
    load: loadDetail,
    unavailableMessage: t("toolDetailUnavailable"),
    onTimelineConflict,
  });

  return (
    <article className="tool-body">
      <p className="event-label">
        {item.stage === "call"
          ? t("toolCall", { ordinal: item.ordinal })
          : t("toolOutput", {
              status: t(item.status === "completed" ? "toolCompleted" : "toolFailed"),
              ordinal: item.ordinal,
            })}
        <EventTime timestamp={item.timestamp} />
      </p>
      <p className="detail-summary">
        <strong>{item.toolName}</strong>
        {item.preview ? ` — ${item.preview}` : ""}
        {item.hasDetail ? <CharacterCount value={item.charCount} /> : null}
      </p>
      <p className="tool-call-id">
        {t("callID")} <code>{item.callId}</code>
      </p>
      {item.hasDetail ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? t("hideToolDetail") : t("showToolDetail")}
        </button>
      ) : (
        <p className="muted">{t("noDetailAvailable")}</p>
      )}
      {open ? (
        <EventDetail
          loading={detail === null && error === null}
          loadingMessage={t("loadingToolDetail")}
          error={error}
          onRetry={retry}
        >
          {detail ? (
            <>
              {detail.input !== null ? (
                <>
                  <h4>{t("input")}</h4>
                  <pre>{detail.input}</pre>
                </>
              ) : null}
              {item.stage === "output" && detail.output !== null ? (
                <>
                  <h4>{t("output")}</h4>
                  <pre>{detail.output}</pre>
                </>
              ) : null}
              {detail.truncated ? (
                <p className="truncated">{t("detailWasTruncatedForSafeDisplay")}</p>
              ) : null}
            </>
          ) : null}
        </EventDetail>
      ) : null}
    </article>
  );
}

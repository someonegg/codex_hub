import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import type { InternalDetailResponse, TimelineCursor } from "../../shared/api-contract";
import type { InternalEventItem as Internal } from "../../shared/domain";

import { api } from "../api/client";
import { t } from "../i18n";
import { useLazyDetail } from "../state/use-lazy-detail";
import { EventDetail } from "./EventDetail";
import { EventTime } from "./EventTime";

interface InternalEventItemProps {
  item: Internal;
  sessionId: string;
  cursor: TimelineCursor;
  onTimelineConflict: () => void;
}

export function InternalEventItem({
  item,
  sessionId,
  cursor,
  onTimelineConflict,
}: InternalEventItemProps) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const loadDetail = useCallback(
    (requestCursor: TimelineCursor, signal: AbortSignal): Promise<InternalDetailResponse> =>
      api.internal(sessionId, item.id, { cursor: requestCursor }, signal),
    [item.id, sessionId],
  );
  const { detail, error, retry } = useLazyDetail({
    enabled: open,
    cursor,
    load: loadDetail,
    unavailableMessage: t("internalEventUnavailable"),
    onTimelineConflict,
  });

  return (
    <article className="internal-event-body">
      <p className="event-label">
        {t("internal")} {item.ordinal}
        <EventTime timestamp={item.timestamp} />
      </p>
      <p>
        <strong>{item.eventType}</strong>
      </p>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? t("hideJSON") : t("showJSON")}
      </button>
      {open ? (
        <EventDetail
          loading={detail === null && error === null}
          loadingMessage={t("loadingInternalEvent")}
          error={error}
          onRetry={retry}
        >
          {detail ? (
            <>
              <pre>{detail.json}</pre>
              {detail.truncated ? (
                <p className="truncated">{t("jSONWasTruncatedForSafeDisplay")}</p>
              ) : null}
            </>
          ) : null}
        </EventDetail>
      ) : null}
    </article>
  );
}

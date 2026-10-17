import { useCallback, useState } from "react";

import type { InternalDetailResponse, TimelineCursor } from "../../shared/api-contract";
import type { InternalEventItem as Internal } from "../../shared/domain";

import { api } from "../api/client";
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
    unavailableMessage: "Internal event unavailable",
    onTimelineConflict,
  });

  return (
    <article className="internal-event-body">
      <p className="event-label">
        Internal · {item.ordinal}
        <EventTime timestamp={item.timestamp} />
      </p>
      <p>
        <strong>{item.eventType}</strong>
      </p>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Hide JSON" : "Show JSON"}
      </button>
      {open ? (
        <EventDetail
          loading={detail === null && error === null}
          loadingMessage="Loading internal event…"
          error={error}
          onRetry={retry}
        >
          {detail ? (
            <>
              <pre>{detail.json}</pre>
              {detail.truncated ? (
                <p className="truncated">JSON was truncated for safe display.</p>
              ) : null}
            </>
          ) : null}
        </EventDetail>
      ) : null}
    </article>
  );
}

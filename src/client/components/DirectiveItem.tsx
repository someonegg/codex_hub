import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DirectiveDetailResponse, TimelineCursor } from "../../shared/api-contract";
import type { DirectiveItem as Directive } from "../../shared/domain";

import { api } from "../api/client";
import { t } from "../i18n";
import { useLazyDetail } from "../state/use-lazy-detail";
import { CharacterCount } from "./CharacterCount";
import { EventDetail } from "./EventDetail";
import { EventTime } from "./EventTime";

interface DirectiveItemProps {
  item: Directive;
  sessionId: string;
  cursor: TimelineCursor;
  onTimelineConflict: () => void;
}

export function DirectiveItem({ item, sessionId, cursor, onTimelineConflict }: DirectiveItemProps) {
  useTranslation();
  if (!item.hasDetail) {
    return <InlineDirective item={item} />;
  }
  return (
    <LazyDirective
      item={item}
      sessionId={sessionId}
      cursor={cursor}
      onTimelineConflict={onTimelineConflict}
    />
  );
}

function InlineDirective({ item }: { item: Extract<Directive, { hasDetail: false }> }) {
  useTranslation();
  return (
    <article className="directive-body">
      <p className="event-label">
        {t("directive")} {item.ordinal}
        <EventTime timestamp={item.timestamp} />
      </p>
      <pre className="directive-block">{item.text}</pre>
    </article>
  );
}

function LazyDirective({
  item,
  sessionId,
  cursor,
  onTimelineConflict,
}: DirectiveItemProps & { item: Extract<Directive, { hasDetail: true }> }) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const loadDetail = useCallback(
    (requestCursor: TimelineCursor, signal: AbortSignal): Promise<DirectiveDetailResponse> =>
      api.directive(sessionId, item.id, { cursor: requestCursor }, signal),
    [item.id, sessionId],
  );
  const { detail, error, retry } = useLazyDetail({
    enabled: open,
    cursor,
    load: loadDetail,
    unavailableMessage: t("directiveUnavailable"),
    onTimelineConflict,
  });

  return (
    <article className="directive-body">
      <p className="event-label">
        {t("directive")} {item.ordinal}
        <EventTime timestamp={item.timestamp} />
      </p>
      <p className="detail-summary">
        <strong>{item.summary}</strong>
        <CharacterCount value={item.charCount} />
      </p>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? t("hideDirective") : t("showDirective")}
      </button>
      {open ? (
        <EventDetail
          loading={detail === null && error === null}
          loadingMessage={t("loadingDirective")}
          error={error}
          onRetry={retry}
        >
          {detail ? (
            <>
              <pre>{detail.text}</pre>
              {detail.truncated ? (
                <p className="truncated">{t("directiveWasTruncatedForSafeDisplay")}</p>
              ) : null}
            </>
          ) : null}
        </EventDetail>
      ) : null}
    </article>
  );
}

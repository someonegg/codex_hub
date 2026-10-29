import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { isPreviewableUploadType, type UploadAttachment } from "../../shared/uploads";

import { api } from "../api/client";
import { formatDate, formatNumber, t } from "../i18n";
import { LocalizedError } from "../i18n/localized-error";
import { useSessionDraft } from "../state/session-drafts";
import { InternalLink } from "./InternalLink";
import { RequestError } from "./RequestError";

export function UploadsPage({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const { i18n } = useTranslation();
  useEffect(() => {
    document.title = t("uploadHistoryCodexHub");
  }, [i18n.resolvedLanguage]);
  const [items, setItems] = useState<UploadAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  const { removeAttachment } = useSessionDraft(sessionId);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .uploads(sessionId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setItems(result.items);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason : new LocalizedError("unableToLoadUploads"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [sessionId, retry]);
  return (
    <section className="uploads-page">
      <InternalLink href={`/sessions/${encodeURIComponent(sessionId)}`} onNavigate={onBack}>
        {t("backToSession")}
      </InternalLink>
      <h1>{t("uploadHistory")}</h1>
      <p>{t("allSuccessfulUploadsAreRetainedIncludingFilesRemovedFromDrafts")}</p>
      {items.map((item) => (
        <UploadEntry
          key={item.id}
          item={item}
          onDeleted={() => {
            setItems((current) => current.filter((entry) => entry.id !== item.id));
            removeAttachment(item.id);
          }}
        />
      ))}
      {loading ? <p role="status">{t("loadingUploads")}</p> : null}
      {!!error ? (
        <div role="alert">
          <p>
            <RequestError error={error} />
          </p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            {t("retry")}
          </button>
        </div>
      ) : null}
      {!loading && !error && !items.length ? <p>{t("noUploadsYet")}</p> : null}
    </section>
  );
}
function UploadEntry({ item, onDeleted }: { item: UploadAttachment; onDeleted: () => void }) {
  useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [broken, setBroken] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    controller.current = new AbortController();
    return () => controller.current?.abort();
  }, []);
  const deleteUpload = () => {
    setBusy(true);
    setError(null);
    api
      .deleteUpload(item.sessionId, item.id, controller.current!.signal)
      .then(() => {
        if (!controller.current!.signal.aborted) onDeleted();
      })
      .catch((reason) => {
        if (!controller.current!.signal.aborted)
          setError(reason instanceof Error ? reason : new LocalizedError("deleteFailed"));
      })
      .finally(() => {
        if (!controller.current!.signal.aborted) setBusy(false);
      });
  };
  const url = `/api/v1/sessions/${encodeURIComponent(item.sessionId)}/uploads/${encodeURIComponent(item.id)}/content`;
  const image = isPreviewableUploadType(item.type);
  return (
    <article className="upload-entry">
      <strong>{item.filename}</strong>
      <p>
        {t("uploadBytes", { size: formatNumber(item.size) })} ·{" "}
        <time dateTime={item.uploadedAt}>
          {formatDate(new Date(item.uploadedAt), { dateStyle: "short", timeStyle: "medium" })}
        </time>
      </p>
      {image && !broken ? (
        <button
          type="button"
          className={`upload-preview${expanded ? " expanded" : ""}`}
          aria-expanded={expanded}
          aria-label={t(expanded ? "collapseFile" : "expandFile", { filename: item.filename })}
          onClick={() => setExpanded((value) => !value)}
        >
          <img src={url} alt={item.filename} onError={() => setBroken(true)} />
        </button>
      ) : null}
      {broken ? <p>{t("previewUnavailableDownloadTheFileBelow")}</p> : null}
      <div className="upload-actions">
        <a href={`${url}?download=1`} download={item.filename}>
          {t("download")}
        </a>
        {!confirming ? (
          <button type="button" onClick={() => setConfirming(true)}>
            {t("delete")}
          </button>
        ) : (
          <>
            <p>{t("deleteThisFile")}</p>
            <button type="button" disabled={busy} onClick={deleteUpload}>
              {busy ? t("deleting") : t("confirmDelete")}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
              {t("cancel")}
            </button>
          </>
        )}
      </div>
      {!!error ? (
        <p role="alert">
          <RequestError error={error} />
        </p>
      ) : null}
    </article>
  );
}

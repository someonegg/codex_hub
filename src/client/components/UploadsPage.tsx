import { useEffect, useRef, useState } from "react";

import { isPreviewableUploadType, type UploadAttachment } from "../../shared/uploads";

import { api } from "../api/client";
import { useSessionDraft } from "../state/session-drafts";
import { InternalLink } from "./InternalLink";

export function UploadsPage({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const [items, setItems] = useState<UploadAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const { removeAttachment } = useSessionDraft(sessionId);
  useEffect(() => {
    document.title = "Upload history · Codex Hub";
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
          setError(reason instanceof Error ? reason.message : "Unable to load uploads");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [sessionId, retry]);
  return (
    <section className="uploads-page">
      <InternalLink href={`/sessions/${encodeURIComponent(sessionId)}`} onNavigate={onBack}>
        ← Back to session
      </InternalLink>
      <h1>Upload history</h1>
      <p>All successful uploads are retained, including files removed from drafts.</p>
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
      {loading ? <p role="status">Loading uploads…</p> : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : null}
      {!loading && !error && !items.length ? <p>No uploads yet.</p> : null}
    </section>
  );
}
function UploadEntry({ item, onDeleted }: { item: UploadAttachment; onDeleted: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [broken, setBroken] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
          setError(reason instanceof Error ? reason.message : "Delete failed");
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
        {item.size.toLocaleString()} bytes ·{" "}
        <time dateTime={item.uploadedAt}>{new Date(item.uploadedAt).toLocaleString()}</time>
      </p>
      {image && !broken ? (
        <button
          type="button"
          className={`upload-preview${expanded ? " expanded" : ""}`}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${item.filename}`}
          onClick={() => setExpanded((value) => !value)}
        >
          <img src={url} alt={item.filename} onError={() => setBroken(true)} />
        </button>
      ) : null}
      {broken ? <p>Preview unavailable. Download the file below.</p> : null}
      <div className="upload-actions">
        <a href={`${url}?download=1`} download={item.filename}>
          Download
        </a>
        {!confirming ? (
          <button type="button" onClick={() => setConfirming(true)}>
            Delete
          </button>
        ) : (
          <>
            <p>Delete this file?</p>
            <button type="button" disabled={busy} onClick={deleteUpload}>
              {busy ? "Deleting…" : "Confirm delete"}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        )}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </article>
  );
}

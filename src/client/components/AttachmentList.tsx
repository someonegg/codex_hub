import { useEffect, useRef, useState } from "react";

import type { DraftAttachment } from "../state/session-drafts";

export function AttachmentList({
  attachments,
  disabled,
  onRemove,
}: {
  attachments: readonly DraftAttachment[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  return (
    <ul className="interaction-attachments" aria-label="Pending attachments">
      {attachments.map((attachment) => (
        <Attachment
          key={attachment.id}
          attachment={attachment}
          disabled={disabled}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}

function Attachment({
  attachment,
  disabled,
  onRemove,
}: {
  attachment: DraftAttachment;
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  const { file } = attachment;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (
      !file.type.startsWith("image/") &&
      !/\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?|hei[cf])$/i.test(file.name)
    )
      return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  useEffect(() => {
    if (expanded) dialog.current?.showModal();
    else dialog.current?.close();
  }, [expanded]);
  return (
    <li className="interaction-attachment">
      {url && !failed ? (
        <button
          type="button"
          className="attachment-thumbnail"
          aria-label={`Preview ${file.name}`}
          onClick={() => setExpanded(true)}
        >
          <img src={url} alt={file.name} onError={() => setFailed(true)} />
        </button>
      ) : (
        <span className="attachment-file-icon" aria-hidden="true">
          <svg
            width="32"
            height="40"
            viewBox="0 0 24 30"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M4 2h10l6 6v20H4zM14 2v7h6M8 15h8M8 20h8" />
          </svg>
        </span>
      )}
      <span className="attachment-name" title={file.name}>
        {file.name}
      </span>
      {failed ? <span className="attachment-preview-error">Preview unavailable</span> : null}
      <button
        type="button"
        className="attachment-remove"
        aria-label={`Remove ${file.name}`}
        disabled={disabled}
        onClick={() => onRemove(attachment.id)}
      >
        ×
      </button>
      <dialog
        ref={dialog}
        className="attachment-preview-dialog"
        aria-label={`Preview ${file.name}`}
        onCancel={() => setExpanded(false)}
        onClose={() => setExpanded(false)}
      >
        <button
          type="button"
          className="dialog-close"
          aria-label="Close image preview"
          onClick={() => setExpanded(false)}
        >
          ×
        </button>
        {expanded ? <p>{file.name}</p> : null}
        {expanded && url ? <img src={url} alt={file.name} /> : null}
      </dialog>
    </li>
  );
}

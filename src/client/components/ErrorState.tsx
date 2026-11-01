import { useTranslation } from "react-i18next";

import { t } from "../i18n";
import { RequestError } from "./RequestError";
export function ErrorState({
  title,
  message,
  onDismiss,
  onRetry,
  retryLabel,
  retryNotice,
}: {
  title: string;
  message: string;
  onDismiss?: () => void;
  onRetry?: () => void;
  retryLabel?: string;
  retryNotice?: string;
}) {
  useTranslation();
  return (
    <div className="error-state" role="alert">
      <strong>{title}</strong>
      <p>
        <RequestError error={message} />
      </p>
      {retryNotice ? <p role="status">{retryNotice}</p> : null}
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          {retryLabel ?? t("retry")}
        </button>
      ) : null}
      {onDismiss ? (
        <button
          className="error-dismiss"
          type="button"
          aria-label={t("dismiss")}
          onClick={onDismiss}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  );
}

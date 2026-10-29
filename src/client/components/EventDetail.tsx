import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { t } from "../i18n";
import { RequestError } from "./RequestError";

interface EventDetailProps {
  loading: boolean;
  loadingMessage: string;
  error: string | null;
  onRetry: () => void;
  children: ReactNode;
}

export function EventDetail({
  loading,
  loadingMessage,
  error,
  onRetry,
  children,
}: EventDetailProps) {
  useTranslation();
  return (
    <div className="event-detail">
      {loading ? <p role="status">{loadingMessage}</p> : null}
      {error ? (
        <div role="alert">
          <p>
            <RequestError error={error} />
          </p>
          <button type="button" onClick={onRetry}>
            {t("retryLoadingDetail")}
          </button>
        </div>
      ) : null}
      {children}
    </div>
  );
}

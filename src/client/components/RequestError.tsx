import { useTranslation } from "react-i18next";

import { ApiClientError } from "../api/client";
import { locale, type PlainMessageKey, t } from "../i18n";
import { LocalizedError } from "../i18n/localized-error";

const errorKeys = {
  not_found: "requestNotFound",
  interaction_not_connected: "requestDisconnected",
  timeline_changed: "requestConflict",
  payload_too_large: "requestTooLarge",
  upload_too_large: "requestTooLarge",
} as const;

/** Keep native diagnostics intact; only the application explanation is translated. */
export function RequestError({ error, summary }: { error: unknown; summary?: PlainMessageKey }) {
  useTranslation();
  if (error instanceof LocalizedError) return <>{t(error.key)}</>;
  const detail = error instanceof Error ? error.message : String(error);
  if (locale() === "en-US") return <>{detail}</>;
  const key =
    summary ??
    (error instanceof ApiClientError && Object.hasOwn(errorKeys, error.code)
      ? errorKeys[error.code as keyof typeof errorKeys]
      : "requestFailed");
  return (
    <>
      {t(key)}{" "}
      <span className="request-error-detail">
        {t("requestDetails")}:<code>{detail}</code>
      </span>
    </>
  );
}

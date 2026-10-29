import { useTranslation } from "react-i18next";

import type { SessionStatus } from "../../shared/domain";

import { t } from "../i18n";
export function StatusBadge({ status }: { status: SessionStatus }) {
  useTranslation();
  return status === "normal" ? null : (
    <span className={`session-status ${status === "live" ? "live-label" : "archive-label"}`}>
      {status === "live" ? t("live") : t("archived")}
    </span>
  );
}

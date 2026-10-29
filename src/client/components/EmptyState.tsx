import type { PropsWithChildren } from "react";
import { useTranslation } from "react-i18next";

import { t } from "../i18n";

export function EmptyState({ title, children }: PropsWithChildren<{ title: string }>) {
  useTranslation();
  return (
    <div className="empty-state">
      <p className="eyebrow">{t("nothingToShow")}</p>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

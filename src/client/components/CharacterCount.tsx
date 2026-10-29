import { useTranslation } from "react-i18next";

import { t } from "../i18n";
export function CharacterCount({ value }: { value: number }) {
  useTranslation();
  return <span className="character-count">{t("characters", { count: value })}</span>;
}

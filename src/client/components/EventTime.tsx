import { useTranslation } from "react-i18next";

import { formatDate } from "../i18n";

export function EventTime({ timestamp }: { timestamp: string | null }) {
  useTranslation();
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <>
      {" "}
      ·{" "}
      <time dateTime={timestamp}>
        {formatDate(date, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        })}
      </time>
    </>
  );
}

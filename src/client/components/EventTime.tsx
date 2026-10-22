const EVENT_DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export function EventTime({ timestamp }: { timestamp: string | null }) {
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <>
      {" "}
      · <time dateTime={timestamp}>{EVENT_DATE_TIME_FORMAT.format(date)}</time>
    </>
  );
}

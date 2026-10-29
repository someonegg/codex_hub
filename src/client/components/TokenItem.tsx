import { useTranslation } from "react-i18next";

import type { TokenItem as Token, TokenUsageCounters } from "../../shared/domain";

import type { PlainMessageKey } from "../i18n";
import { formatNumber, t } from "../i18n";
import { EventTime } from "./EventTime";

export function TokenItem({ item }: { item: Token }) {
  useTranslation();
  return (
    <article className="token-body">
      <p className="event-label">
        {t("token")} {item.ordinal}
        <EventTime timestamp={item.timestamp} />
      </p>
      <div className="token-usage">
        <TokenUsageGroup label={t("total")} counters={item.tokenUsage.total} />
        <TokenUsageGroup label={t("last")} counters={item.tokenUsage.last} />
      </div>
    </article>
  );
}

const TOKEN_FIELDS: Array<[keyof TokenUsageCounters, PlainMessageKey]> = [
  ["totalTokens", "totalTokens"],
  ["inputTokens", "input"],
  ["cachedInputTokens", "cachedInput"],
  ["cacheWriteInputTokens", "cacheWriteInput"],
  ["outputTokens", "output"],
  ["reasoningOutputTokens", "reasoningOutput"],
];

interface TokenUsageGroupProps {
  label: string;
  counters: TokenUsageCounters | null;
}

function TokenUsageGroup({ label, counters }: TokenUsageGroupProps) {
  useTranslation();
  return (
    <section aria-label={t("tokenUsage", { label })}>
      <h4>{label}</h4>
      {counters === null ? (
        <p className="token-usage-unavailable">{t("unavailable")}</p>
      ) : (
        <dl>
          {TOKEN_FIELDS.map(([field, fieldLabel]) => {
            const value = counters[field];
            if (value === null) return null;

            return (
              <div key={field}>
                <dt>{t(fieldLabel)}</dt>
                <dd>{formatNumber(value)}</dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}

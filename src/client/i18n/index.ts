import { initReactI18next } from "react-i18next";
import i18next from "i18next";

import { en, settingsEn, settingsZh, zh } from "./messages";
import { namespaceFor, partitionMessages } from "./namespaces";

export const languageOptions = [
  { value: "en", label: "English", locale: "en-US" },
  { value: "zh-CN", label: "简体中文", locale: "zh-CN" },
] as const;
export const languages = languageOptions.map(({ value }) => value);
export type Language = (typeof languageOptions)[number]["value"];
export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && languages.includes(value as Language);
}
void i18next.use(initReactI18next).init({
  lng: "en",
  initAsync: false,
  returnNull: false,
  returnEmptyString: false,
  fallbackLng: "en",
  supportedLngs: [...languages],
  resources: {
    en: { settings: settingsEn, ...partitionMessages(en) },
    "zh-CN": { settings: settingsZh, ...partitionMessages(zh) },
  },
  defaultNS: "common",
  interpolation: { escapeValue: false },
});
export function applyLanguage(language: Language) {
  if (i18next.resolvedLanguage !== language) void i18next.changeLanguage(language);
  document.documentElement.lang = language;
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("metaDescription"));
}

export type MessageKey = keyof typeof en | "events" | "filesChanged";
type Template<K extends MessageKey> = K extends keyof typeof en
  ? (typeof en)[K]
  : K extends "events"
    ? (typeof en)["events_other"]
    : (typeof en)["filesChanged_other"];
type ParameterName<S extends string> = S extends `${infer Name}, number` ? Name : S;
type ParameterNames<S extends string> = S extends `${string}{{${infer Name}}}${infer Rest}`
  ? ParameterName<Name> | ParameterNames<Rest>
  : never;
export type PlainMessageKey = {
  [K in MessageKey]: ParameterNames<Template<K>> extends never ? K : never;
}[MessageKey];
type Values<K extends MessageKey> = Record<ParameterNames<Template<K>>, string | number>;

export function t<K extends MessageKey>(
  key: K,
  ...args: ParameterNames<Template<K>> extends never
    ? [values?: Record<string, unknown>]
    : [values: Values<K>]
): string {
  const options: Record<string, unknown> = {
    ...args[0],
    ns: namespaceFor.get(key) ?? namespaceFor.get(`${key}_other`) ?? "common",
  };
  return i18next.t(key as string, options);
}
export function locale(): string {
  return languageOptions.find(({ value }) => value === i18next.resolvedLanguage)?.locale ?? "en-US";
}
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(locale()).format(value);
}
export function formatDate(
  value: Date,
  options?: Intl.DateTimeFormatOptions,
  language = locale(),
): string {
  return new Intl.DateTimeFormat(language, options).format(value);
}

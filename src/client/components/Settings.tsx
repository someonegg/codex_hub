import { useRef } from "react";
import { useTranslation } from "react-i18next";

import type { SessionHome } from "../../shared/api-contract";

import { isLanguage, languageOptions } from "../i18n";
import { updatePreferences, usePreferences } from "../state/preferences";

export function Settings({ homes }: { homes: readonly SessionHome[] }) {
  const { t } = useTranslation("settings");
  const preferences = usePreferences();
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          dialog.current?.showModal();
          dialog.current?.querySelector("h2")?.focus({ preventScroll: true });
        }}
      >
        {t("title")}
      </button>
      <dialog ref={dialog} className="create-session settings-dialog" aria-label={t("title")}>
        <button
          type="button"
          className="dialog-close"
          aria-label={t("close")}
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
        <h2 tabIndex={-1}>{t("title")}</h2>
        <div className="dialog-body">
          <label>
            {t("language")}
            <select
              value={preferences.language}
              onChange={(event) => {
                const value = event.target.value;
                if (isLanguage(value)) updatePreferences({ language: value });
              }}
            >
              {languageOptions.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("theme")}
            <select
              value={preferences.theme}
              onChange={(event) =>
                updatePreferences({ theme: event.target.value === "warm" ? "warm" : "mist" })
              }
            >
              <option value="mist">{t("mist")}</option>
              <option value="warm">{t("paper")}</option>
            </select>
          </label>
          <fieldset className="settings-launch" aria-label={t("launch")}>
            <label>
              {t("home")}
              <select
                value={preferences.defaultHome}
                onChange={(event) => updatePreferences({ defaultHome: event.target.value })}
              >
                <option value="">{t("auto")}</option>
                {preferences.defaultHome &&
                !homes.some((home) => home.sourceInstanceId === preferences.defaultHome) ? (
                  <option value={preferences.defaultHome}>{t("unavailable")}</option>
                ) : null}
                {homes.map((home) => (
                  <option key={home.sourceInstanceId} value={home.sourceInstanceId}>
                    {home.nickname}
                  </option>
                ))}
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={preferences.worktree}
                onChange={(event) => updatePreferences({ worktree: event.target.checked })}
              />
              {t("worktree")}
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={preferences.yolo}
                onChange={(event) => updatePreferences({ yolo: event.target.checked })}
              />
              {t("yolo")}
            </label>
          </fieldset>
          <label className="check-row">
            <input
              type="checkbox"
              checked={preferences.enterToSend}
              onChange={(event) => updatePreferences({ enterToSend: event.target.checked })}
            />
            {t("enter")}
          </label>
        </div>
      </dialog>
    </>
  );
}

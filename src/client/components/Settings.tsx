import { useRef } from "react";

import type { SessionHome } from "../../shared/api-contract";

import { updatePreferences, usePreferences } from "../state/preferences";

export function Settings({ homes }: { homes: readonly SessionHome[] }) {
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
        Settings
      </button>
      <dialog ref={dialog} className="create-session settings-dialog" aria-label="Settings">
        <button
          type="button"
          className="dialog-close"
          aria-label="Close settings"
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
        <h2 tabIndex={-1}>Settings</h2>
        <div className="dialog-body">
          <label>
            Theme
            <select
              value={preferences.theme}
              onChange={(event) =>
                updatePreferences({ theme: event.target.value === "warm" ? "warm" : "mist" })
              }
            >
              <option value="mist">Mist</option>
              <option value="warm">Paper</option>
            </select>
          </label>
          <fieldset className="settings-launch" aria-label="Session launch defaults">
            <label>
              Default Home
              <select
                value={preferences.defaultHome}
                onChange={(event) => updatePreferences({ defaultHome: event.target.value })}
              >
                <option value="">Auto</option>
                {preferences.defaultHome &&
                !homes.some((home) => home.sourceInstanceId === preferences.defaultHome) ? (
                  <option value={preferences.defaultHome}>Unavailable home</option>
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
              Enable worktree by default
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={preferences.yolo}
                onChange={(event) => updatePreferences({ yolo: event.target.checked })}
              />
              Enable YOLO by default
            </label>
          </fieldset>
        </div>
      </dialog>
    </>
  );
}

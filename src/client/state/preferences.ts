import { useSyncExternalStore } from "react";

export interface Preferences {
  defaultHome: string;
  theme: "mist" | "warm";
  worktree: boolean;
  yolo: boolean;
}
const key = "ahub.preferences.v1";
const defaults: Preferences = { defaultHome: "", theme: "mist", worktree: false, yolo: false };
function read(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") ?? {};
    return {
      defaultHome: typeof value.defaultHome === "string" ? value.defaultHome : "",
      theme: value.theme === "warm" ? "warm" : "mist",
      worktree: value.worktree === true,
      yolo: value.yolo === true,
    };
  } catch {
    return defaults;
  }
}
let current = read();
const listeners = new Set<() => void>();
export function initializeTheme() {
  document.documentElement.dataset.theme = current.theme;
}
export function updatePreferences(patch: Partial<Preferences>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(key, JSON.stringify(current));
  } catch {
    /* Keep settings usable without storage. */
  }
  initializeTheme();
  listeners.forEach((listener) => listener());
}
window.addEventListener("storage", (event) => {
  if (event.key !== key && event.key !== null) return;
  current = read();
  initializeTheme();
  listeners.forEach((listener) => listener());
});
export function usePreferences() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => current,
  );
}

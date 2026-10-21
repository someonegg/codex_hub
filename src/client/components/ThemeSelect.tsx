import { useState } from "react";

const STORAGE_KEY = "codex-hub.theme";

type Theme = "classic" | "warm";

function savedTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "warm" ? "warm" : "classic";
  } catch {
    return "classic";
  }
}

export function initializeTheme() {
  document.documentElement.dataset.theme = savedTheme();
}

export function ThemeSelect() {
  const [theme, setTheme] = useState(savedTheme);
  return (
    <label className="theme-select">
      <span>Theme</span>
      <select
        aria-label="Theme"
        value={theme}
        onChange={(event) => {
          const next = event.target.value === "warm" ? "warm" : "classic";
          setTheme(next);
          document.documentElement.dataset.theme = next;
          try {
            localStorage.setItem(STORAGE_KEY, next);
          } catch {
            /* Keep the selection usable when storage is unavailable. */
          }
        }}
      >
        <option value="classic">Mist</option>
        <option value="warm">Paper</option>
      </select>
    </label>
  );
}

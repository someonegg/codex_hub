import { useState } from "react";

const STORAGE_KEY = "codex-hub.theme";

type Theme = "mist" | "warm";

function savedTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "warm" ? "warm" : "mist";
  } catch {
    return "mist";
  }
}

export function initializeTheme() {
  document.documentElement.dataset.theme = savedTheme();
}

export function ThemeSelect() {
  const [theme, setTheme] = useState(savedTheme);
  return (
    <label className="theme-select">
      <select
        aria-label="Theme"
        value={theme}
        onChange={(event) => {
          const next = event.target.value === "warm" ? "warm" : "mist";
          setTheme(next);
          document.documentElement.dataset.theme = next;
          try {
            localStorage.setItem(STORAGE_KEY, next);
          } catch {
            /* Keep the selection usable when storage is unavailable. */
          }
        }}
      >
        <option value="mist">Mist</option>
        <option value="warm">Paper</option>
      </select>
    </label>
  );
}

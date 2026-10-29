const key = "ahub.browser-state.v1";

function read(): Record<string, string> | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return null;
  }
}

let memory: Record<string, string> = read() ?? {};
let pending: Record<string, string> = {};

function refresh() {
  const stored = read();
  if (stored !== null) memory = { ...stored, ...pending };
}

/** Centralized tab-local persistence with in-memory fallback. */
export const browserStorage = {
  getItem(name: string): string | null {
    refresh();
    return typeof memory[name] === "string" ? memory[name] : null;
  },
  setItem(name: string, value: string) {
    refresh();
    memory = { ...memory, [name]: value };
    pending = { ...pending, [name]: value };
    try {
      sessionStorage.setItem(key, JSON.stringify(memory));
      pending = {};
    } catch {
      // Unsaved values override persisted snapshots until a later write succeeds.
      return;
    }
  },
};

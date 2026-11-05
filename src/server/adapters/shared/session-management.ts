import { realpath, stat } from "node:fs/promises";

import { validProjectDirectory } from "../../domain/project-directory.js";
import type { InteractionKeyBindings } from "../../domain/session-domain.js";

export async function resolveDirectory(input: string) {
  if (!validProjectDirectory(input)) throw new Error("Directory must be an absolute local path");
  const directory = await realpath(input);
  if (!(await stat(directory)).isDirectory())
    throw Object.assign(new Error("Path is not a directory"), { code: "ENOTDIR" });
  return { directory };
}
export const DEFAULT_KEY_BINDINGS = {
  enter: "Enter",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  BTab: "BTab",
  "0": "0",
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
} as const satisfies InteractionKeyBindings;
export function interruptSteps() {
  return [
    { keys: ["C-u"], delayMs: 0 },
    { keys: ["Escape"], delayMs: 100 },
  ] as const;
}
export function exitSteps() {
  return [
    { keys: ["C-c"] as const, delayMs: 0 },
    { keys: ["C-c"] as const, delayMs: 1000 },
    { keys: ["C-c"] as const, delayMs: 1000 },
  ];
}

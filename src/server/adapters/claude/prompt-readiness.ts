import type { TerminalCursorSnapshot } from "../../interaction/transport.js";

/** Allow cursor drift within columns 1–5 and two rows of the prompt. */
export function claudePromptPosition(snapshot: TerminalCursorSnapshot | null): number | null {
  if (!snapshot || snapshot.cursorX < 1 || snapshot.cursorX > 5) return null;
  const lines = snapshot.content.split("\n");
  for (let row = Math.max(0, snapshot.cursorY - 2); row <= snapshot.cursorY + 2; row++) {
    if (/^❯[^\S\r\n\u2028\u2029]*$/u.test(lines[row] ?? "")) return row;
  }
  return null;
}

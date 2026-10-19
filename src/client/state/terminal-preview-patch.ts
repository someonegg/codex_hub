import type { TerminalPreviewResponse, TerminalPreviewResult } from "../../shared/api-contract.js";

export function applyPreview(
  current: TerminalPreviewResponse | null,
  next: TerminalPreviewResult,
): TerminalPreviewResponse | null {
  if (typeof next.content === "string") return next as TerminalPreviewResponse;
  if (!current || next.baseRevision !== current.revision || !Array.isArray(next.patches))
    return null;
  let lines = current.content.split("\n");
  for (const patch of next.patches) {
    if (!patch || !Array.isArray(patch.operations)) return null;
    let boundary = lines.length;
    for (const op of patch.operations) {
      if (
        !op ||
        !Number.isSafeInteger(op.startLine) ||
        !Number.isSafeInteger(op.deleteCount) ||
        op.startLine < 0 ||
        op.deleteCount < 0 ||
        op.startLine + op.deleteCount > boundary ||
        !Array.isArray(op.lines) ||
        op.lines.some((line) => typeof line !== "string" || line.includes("\n"))
      )
        return null;
      boundary = op.startLine;
      lines = lines
        .slice(0, op.startLine)
        .concat(op.lines, lines.slice(op.startLine + op.deleteCount));
    }
  }
  return {
    content: lines.join("\n"),
    revision: next.revision,
    truncated: next.truncated,
    capturedAt: next.capturedAt,
  };
}

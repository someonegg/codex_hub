import type { TerminalPreviewSnapshot } from "../../shared/api-contract.js";

export function applyPreview(
  current: TerminalPreviewSnapshot | null,
  value: unknown,
): TerminalPreviewSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const next = value as Record<string, unknown>;
  if (
    typeof next.revision !== "string" ||
    typeof next.truncated !== "boolean" ||
    typeof next.capturedAt !== "string"
  )
    return null;
  if (next.type === "snapshot") {
    return typeof next.content === "string"
      ? {
          content: next.content,
          revision: next.revision,
          truncated: next.truncated,
          capturedAt: next.capturedAt,
        }
      : null;
  }
  if (
    next.type !== "delta" ||
    !current ||
    next.baseRevision !== current.revision ||
    !Array.isArray(next.operations)
  )
    return null;
  let lines = current.content.split("\n");
  let boundary = lines.length;
  let previousStart = Infinity;
  for (const op of next.operations) {
    if (
      !op ||
      !Number.isSafeInteger(op.startLine) ||
      !Number.isSafeInteger(op.deleteCount) ||
      op.startLine < 0 ||
      op.deleteCount < 0 ||
      op.startLine >= previousStart ||
      op.startLine + op.deleteCount > boundary ||
      !Array.isArray(op.lines) ||
      op.lines.some((line: unknown) => typeof line !== "string" || line.includes("\n"))
    )
      return null;
    boundary = op.startLine;
    previousStart = op.startLine;
    lines = lines
      .slice(0, op.startLine)
      .concat(op.lines, lines.slice(op.startLine + op.deleteCount));
  }
  return {
    content: lines.join("\n"),
    revision: next.revision,
    truncated: next.truncated,
    capturedAt: next.capturedAt,
  };
}

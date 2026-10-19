import type { LineOperation } from "../../shared/api-contract.js";

/** Bounded Myers search. Trace stores only frontiers, never historical snapshots. */
export function diffLines(before: string, after: string): LineOperation[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  let work = 0;
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  for (let d = 0; d <= 256; d++) {
    trace.push(frontier);
    const next = new Map<number, number>();
    for (let k = -d; k <= d; k += 2) {
      if (++work > 1_000_000) return null;
      let x =
        k === -d || (k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1))
          ? (frontier.get(k + 1) ?? 0)
          : (frontier.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length) {
        if (++work > 1_000_000) return null;
        if (a[x] !== b[y]) break;
        x++;
        y++;
      }
      next.set(k, x);
      if (x >= a.length && y >= b.length) {
        const edits: { x: number; line?: string }[] = [];
        for (let depth = d; depth > 0; depth--) {
          const previous = trace[depth]!;
          const diagonal = x - y;
          const pk =
            diagonal === -depth ||
            (diagonal !== depth &&
              (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1))
              ? diagonal + 1
              : diagonal - 1;
          const px = previous.get(pk)!;
          const py = px - pk;
          while (x > px && y > py) {
            x--;
            y--;
          }
          if (x === px) {
            y--;
            edits.push({ x, line: b[y]! });
          } else {
            x--;
            edits.push({ x });
          }
        }
        const operations: LineOperation[] = [];
        for (const edit of edits.reverse()) {
          let op = operations.at(-1);
          if (!op || edit.x !== op.startLine + op.deleteCount) {
            op = { startLine: edit.x, deleteCount: 0, lines: [] };
            operations.push(op);
          }
          if (edit.line === undefined) op.deleteCount++;
          else op.lines.push(edit.line);
        }
        return operations.reverse();
      }
    }
    frontier = next;
  }
  return null;
}

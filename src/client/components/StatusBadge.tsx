import type { SessionStatus } from "../../shared/domain";
export function StatusBadge({ status }: { status: SessionStatus }) {
  return status === "normal" ? null : (
    <span className={status === "live" ? "live-label" : "archive-label"}>
      {status === "live" ? "Live" : "Archived"}
    </span>
  );
}

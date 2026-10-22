import type { SessionStatus } from "../../shared/domain";
export function StatusBadge({ status }: { status: SessionStatus }) {
  return status === "normal" ? null : (
    <span className={`session-status ${status === "live" ? "live-label" : "archive-label"}`}>
      {status === "live" ? "Live" : "Archived"}
    </span>
  );
}

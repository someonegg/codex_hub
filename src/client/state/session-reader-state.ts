import type { TimelineCursor, UpdateRevision } from "../../shared/api-contract";
import type { SessionDetail } from "../../shared/domain";

export interface ReaderContext {
  cursor: TimelineCursor;
  session: SessionDetail;
  hasMore: boolean;
  updateRevision: UpdateRevision;
}

import type {
  DirectiveDetailQuery,
  DirectiveDetailResponse,
  InternalDetailQuery,
  InternalDetailResponse,
  ItemPageQuery,
  ItemPageResponse,
  SessionDetailResponse,
  SessionListResponse,
  TimelineCursor,
  ToolDetailQuery,
  ToolDetailResponse,
} from "../../shared/api-contract.js";
import type { SessionId } from "../../shared/domain.js";
import type { DomainAgentInteraction } from "../domain/session-domain.js";
import type { RuntimeObservation } from "../interaction/pane-observation.js";

export interface SessionReader {
  list(): Promise<SessionListResponse>;
  getSession(id: SessionId): Promise<SessionReadDetailResponse | null>;
  getItems(id: SessionId, query: ItemPageQuery): Promise<SessionItemPageResponse | null>;
  getSessionUpdates(id: SessionId, cursor: TimelineCursor): Promise<SessionUpdatesSnapshot | null>;
  getToolDetail(
    id: SessionId,
    itemId: string,
    query: ToolDetailQuery,
  ): Promise<ToolDetailResponse | null>;
  getDirectiveDetail(
    id: SessionId,
    itemId: string,
    query: DirectiveDetailQuery,
  ): Promise<DirectiveDetailResponse | null>;
  getInternalDetail(
    id: SessionId,
    itemId: string,
    query: InternalDetailQuery,
  ): Promise<InternalDetailResponse | null>;
  refresh(): Promise<void>;
  getInteractionSession(id: SessionId): Promise<InteractionSessionSnapshot | null>;
}

export type SessionReadDetailResponse = Omit<
  SessionDetailResponse,
  "interaction" | "updateRevision"
> & { readonly interactionSession: InteractionSessionSnapshot };

export type SessionItemPageResponse = Omit<ItemPageResponse, "interaction" | "updateRevision"> & {
  readonly interactionSession: InteractionSessionSnapshot;
};

export interface SessionUpdatesSnapshot {
  readonly session: SessionDetailResponse["session"];
  readonly cursor: TimelineCursor;
  readonly hasMore: boolean;
  readonly interactionSession: InteractionSessionSnapshot;
}

export interface InteractionSessionSnapshot {
  readonly observation?: RuntimeObservation;
  readonly archived: boolean;
  readonly interaction: DomainAgentInteraction | null;
}

import type {
  DirectiveDetailQuery,
  DirectiveDetailResponse,
  InspectQuery,
  InspectResponse,
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

/** Cursor checks remain bound to the same published snapshot as runtime state. */
export type SessionUpdatesRead = ((cursor: TimelineCursor) => SessionUpdatesSnapshot) & {
  readonly state: Pick<SessionUpdatesSnapshot, "session" | "interactionSession">;
};

export interface SessionReader {
  readSessionUpdates(id: SessionId): Promise<SessionUpdatesRead | null>;
  inspect(id: SessionId, query: InspectQuery): Promise<SessionInspectResponse | null>;
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

export type SessionInspectResponse = Omit<InspectResponse, "live" | "interaction"> & {
  readonly interactionSession: InteractionSessionSnapshot;
};

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

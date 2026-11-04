import type {
  SessionDetailResponse,
  SessionListResponse,
  SessionMessagesQuery,
  SessionMessagesResponse,
} from "../../shared/api-contract.js";
import type { SessionId } from "../../shared/domain.js";
import type { DomainAgentInteraction } from "../domain/session-domain.js";
import type { RuntimeObservation } from "../interaction/pane-observation.js";

/** One assembled read of a session: shared public state plus a page reader over its snapshot. */
export interface SessionMessagesRead {
  readonly state: SessionDetailResponse;
  readonly page: (query: SessionMessagesQuery) => SessionMessagesResponse;
}

export interface InteractionSessionReader {
  getInteractionSession(id: SessionId): Promise<InteractionSessionSnapshot | null>;
}

export interface SessionReader extends InteractionSessionReader {
  readMessages(id: SessionId): Promise<SessionMessagesRead | null>;
  messages(id: SessionId, query: SessionMessagesQuery): Promise<SessionMessagesResponse | null>;
  list(): Promise<SessionListResponse>;
  getSession(id: SessionId): Promise<SessionDetailResponse | null>;
  refresh(): Promise<void>;
}

export interface InteractionSessionSnapshot {
  readonly observation?: RuntimeObservation;
  readonly archived: boolean;
  readonly interaction: DomainAgentInteraction | null;
}

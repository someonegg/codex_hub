import type {
  SessionDetailResponse,
  SessionListResponse,
  SessionMessagesQuery,
  SessionMessagesResponse,
} from "../../shared/api-contract.js";
import type { SessionId } from "../../shared/domain.js";
import type { DomainAgentInteraction } from "../domain/session-domain.js";
import type { RuntimeObservation } from "../interaction/pane-observation.js";
export type SessionMessagesRead = ((query: SessionMessagesQuery) => SessionMessagesReadResponse) & {
  readonly state: SessionReadDetailResponse;
};
export interface SessionReader {
  readMessages(id: SessionId): Promise<SessionMessagesRead | null>;
  messages(id: SessionId, query: SessionMessagesQuery): Promise<SessionMessagesReadResponse | null>;
  list(): Promise<SessionListResponse>;
  getSession(id: SessionId): Promise<SessionReadDetailResponse | null>;
  refresh(): Promise<void>;
  getInteractionSession(id: SessionId): Promise<InteractionSessionSnapshot | null>;
}
export type SessionMessagesReadResponse = Omit<
  SessionMessagesResponse,
  "live" | "interaction" | "stateRevision"
> & { readonly interactionSession: InteractionSessionSnapshot };
export type SessionReadDetailResponse = Omit<
  SessionDetailResponse,
  "interaction" | "stateRevision"
> & { readonly interactionSession: InteractionSessionSnapshot };
export interface InteractionSessionSnapshot {
  readonly observation?: RuntimeObservation;
  readonly archived: boolean;
  readonly interaction: DomainAgentInteraction | null;
}

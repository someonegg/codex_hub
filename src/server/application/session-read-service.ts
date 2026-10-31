import type {
  DirectiveDetailQuery,
  DirectiveDetailResponse,
  InternalDetailQuery,
  InternalDetailResponse,
  ItemPageQuery,
  SessionHome,
  SessionListResponse,
  SessionMessagesQuery,
  TimelineCursor,
  ToolDetailQuery,
  ToolDetailResponse,
} from "../../shared/api-contract.js";
import type { SessionDetail, SessionId } from "../../shared/domain.js";
import { SessionApiMapper, type SessionDisplayTitleResolver } from "../api/session-api-mapper.js";
import type { RuntimeReader } from "../interaction/runtime-capabilities.js";
import {
  CatalogSnapshotStore,
  type CatalogSnapshotStoreDependencies,
  DEFAULT_CATALOG_FRESHNESS_MS,
} from "../repository/catalog-snapshot-store.js";
import { SessionQueries } from "../repository/session-queries.js";
import type { SessionSource } from "../source/session-source.js";
import type {
  InteractionSessionSnapshot,
  SessionItemPageResponse,
  SessionReadDetailResponse,
  SessionReader,
  SessionUpdatesRead,
  SessionUpdatesSnapshot,
} from "./session-reader.js";

export interface SessionReadServiceDependencies extends CatalogSnapshotStoreDependencies {
  readonly freshnessMs?: number;
  readonly now?: () => number;
  readonly runtime?: RuntimeReader;
  readonly homes?: SessionHome[];
  readonly resolveDisplayTitle?: SessionDisplayTitleResolver;
}

export class SessionReadService implements SessionReader {
  private readonly runtime?: RuntimeReader;
  readonly #store: CatalogSnapshotStore;
  readonly #queries: SessionQueries;
  readonly #mapper: SessionApiMapper;

  constructor(sources: readonly SessionSource[], options: SessionReadServiceDependencies = {}) {
    const {
      resolveDisplayTitle,
      homes,
      freshnessMs = DEFAULT_CATALOG_FRESHNESS_MS,
      now = performance.now.bind(performance),
      runtime,
      ...storeDependencies
    } = options;
    this.runtime = runtime;
    this.#mapper = new SessionApiMapper(resolveDisplayTitle, homes);
    this.#store = new CatalogSnapshotStore(sources, freshnessMs, now, storeDependencies);
    this.#queries = new SessionQueries();
  }

  async managementSnapshot() {
    const snapshot = await this.#store.refresh();
    const byId = new Map(
      [...snapshot.sessions].map(([id, value]) => [id, value.normalized.session]),
    );
    return { sessions: [...byId.values()], byId };
  }

  async refresh(): Promise<void> {
    await this.#store.refresh();
  }

  async list(): Promise<SessionListResponse> {
    const snapshot = await this.#store.current();
    const sessions = [...snapshot.sessions.values()].map(({ normalized }) => normalized.session);
    if (!this.runtime) return this.#mapper.list(sessions);
    const states = await Promise.all(
      sessions.map((session) => this.runtime!.evaluate(session, false)),
    );
    const byId = new Map(sessions.map((session, index) => [session.id, states[index]!.status]));
    return this.#mapper.list(sessions, byId);
  }

  async getSession(id: SessionId): Promise<SessionReadDetailResponse | null> {
    const snapshot = await this.#store.current();
    const result = this.#queries.session(snapshot, id);
    if (result === null) return null;
    const response = this.#mapper.detail(result);
    const interactionSession = await this.#runtimeDetail(response.session, snapshot);
    return { ...response, interactionSession };
  }

  async messages(id: SessionId, query: SessionMessagesQuery) {
    const snapshot = await this.#store.current();
    const result = this.#queries.messages(snapshot, id, query);
    if (!result) return null;
    const session = this.#mapper.sessionDetail(result.session);
    const interactionSession = await this.#runtimeDetail(session, snapshot);
    return {
      ...result,
      session,
      items: result.items.map((item) => this.#mapper.timelineItem(item)),
      interactionSession,
    };
  }

  async getItems(id: SessionId, query: ItemPageQuery): Promise<SessionItemPageResponse | null> {
    const snapshot = await this.#store.current();
    const result = this.#queries.items(snapshot, id, query);
    if (result === null) return null;
    const response = this.#mapper.itemPage(result);
    const interactionSession = await this.#runtimeDetail(response.session, snapshot);
    return { ...response, interactionSession };
  }

  async getSessionUpdates(
    id: SessionId,
    cursor: TimelineCursor,
  ): Promise<SessionUpdatesSnapshot | null> {
    const read = await this.readSessionUpdates(id);
    return read?.(cursor) ?? null;
  }

  async readSessionUpdates(id: SessionId): Promise<SessionUpdatesRead | null> {
    const snapshot = await this.#store.current();
    const current = snapshot.sessions.get(id);
    if (!current) return null;
    const session = this.#mapper.sessionDetail(current.normalized.session);
    const interactionSession = await this.#runtimeDetail(session, snapshot);
    const read = (cursor: TimelineCursor): SessionUpdatesSnapshot => {
      const context = this.#queries.updates(snapshot, id, cursor)!;
      return {
        session,
        cursor: context.cursor as TimelineCursor,
        hasMore: context.hasMore,
        interactionSession,
      };
    };
    return Object.assign(read, { state: { session, interactionSession } });
  }

  async getToolDetail(
    id: SessionId,
    itemId: string,
    query: ToolDetailQuery,
  ): Promise<ToolDetailResponse | null> {
    const snapshot = await this.#store.current();
    const result = this.#queries.toolDetail(snapshot, id, itemId, query);
    return result === null ? null : this.#mapper.toolDetail(result);
  }

  async getDirectiveDetail(
    id: SessionId,
    itemId: string,
    query: DirectiveDetailQuery,
  ): Promise<DirectiveDetailResponse | null> {
    const snapshot = await this.#store.current();
    const result = this.#queries.directiveDetail(snapshot, id, itemId, query);
    return result === null ? null : this.#mapper.directiveDetail(result);
  }

  async getInternalDetail(
    id: SessionId,
    itemId: string,
    query: InternalDetailQuery,
  ): Promise<InternalDetailResponse | null> {
    const snapshot = await this.#store.current();
    const result = this.#queries.internalDetail(snapshot, id, itemId, query);
    return result === null ? null : this.#mapper.internalDetail(result);
  }

  async #runtimeDetail(
    detail: SessionDetail,
    snapshot: Awaited<ReturnType<CatalogSnapshotStore["current"]>>,
  ) {
    const normalized = snapshot.sessions.get(detail.id)!.normalized;
    const interactionSession: InteractionSessionSnapshot = {
      archived: normalized.session.archived,
      interaction: normalized.interaction ?? null,
    };
    if (!this.runtime) return interactionSession;
    const observation = normalized.session.archived
      ? undefined
      : await this.runtime.observe(detail.id);
    const { status, resume } = await this.runtime.evaluate(normalized.session, true, observation);
    Object.assign(detail, { status, resume });
    return { ...interactionSession, observation };
  }

  async getInteractionSession(id: SessionId): Promise<InteractionSessionSnapshot | null> {
    const snapshot = await this.#store.current();
    const normalized = snapshot.sessions.get(id)?.normalized;
    return normalized === undefined
      ? null
      : {
          archived: normalized.session.archived,
          interaction: normalized.interaction ?? null,
        };
  }
}

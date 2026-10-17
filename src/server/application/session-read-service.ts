import type {
  DirectiveDetailQuery,
  DirectiveDetailResponse,
  InternalDetailQuery,
  InternalDetailResponse,
  ItemPageQuery,
  SessionListResponse,
  TimelineCursor,
  ToolDetailQuery,
  ToolDetailResponse,
} from "../../shared/api-contract.js";
import type { SessionId } from "../../shared/domain.js";
import { SessionApiMapper, type SessionNicknameResolver } from "../api/session-api-mapper.js";
import {
  CatalogSnapshotStore,
  type CatalogSnapshotStoreDependencies,
  DEFAULT_CATALOG_FRESHNESS_MS,
} from "../repository/catalog-snapshot-store.js";
import { SessionQueries } from "../repository/session-queries.js";
import type { SessionSource } from "../source/session-source.js";
import type {
  InteractionSessionSnapshot,
  LiveSessionSnapshot,
  SessionItemPageResponse,
  SessionReadDetailResponse,
  SessionReader,
} from "./session-reader.js";

export interface SessionReadServiceDependencies extends CatalogSnapshotStoreDependencies {
  readonly resolveNickname?: SessionNicknameResolver;
}

export class SessionReadService implements SessionReader {
  readonly #store: CatalogSnapshotStore;
  readonly #queries: SessionQueries;
  readonly #mapper: SessionApiMapper;

  constructor(
    sources: readonly SessionSource[],
    freshnessMs = DEFAULT_CATALOG_FRESHNESS_MS,
    now: () => number = performance.now.bind(performance),
    dependencies: SessionReadServiceDependencies = {},
  ) {
    const { resolveNickname, ...storeDependencies } = dependencies;
    this.#mapper = new SessionApiMapper(resolveNickname);
    this.#store = new CatalogSnapshotStore(sources, freshnessMs, now, storeDependencies);
    this.#queries = new SessionQueries();
  }

  async managementSnapshot() {
    const snapshot = await this.#store.refresh();
    return {
      sessions: [...snapshot.sessions.values()].map(({ normalized }) => ({
        ...normalized.session,
        interaction: normalized.interaction ?? null,
      })),
    };
  }

  async refresh(): Promise<void> {
    await this.#store.refresh();
  }

  async list(): Promise<SessionListResponse> {
    const snapshot = await this.#store.current();
    return this.#mapper.list(
      [...snapshot.sessions.values()].map(({ normalized }) => normalized.session),
    );
  }

  async getSession(id: SessionId): Promise<SessionReadDetailResponse | null> {
    const snapshot = await this.#store.current();
    const result = this.#queries.session(snapshot, id);
    return result === null ? null : this.#mapper.detail(result);
  }

  async getItems(id: SessionId, query: ItemPageQuery): Promise<SessionItemPageResponse | null> {
    const snapshot = await this.#store.current();
    const result = this.#queries.items(snapshot, id, query);
    return result === null ? null : this.#mapper.itemPage(result);
  }

  async getLiveSession(id: SessionId, cursor: TimelineCursor): Promise<LiveSessionSnapshot | null> {
    const snapshot = await this.#store.current();
    const context = this.#queries.live(snapshot, id, cursor);
    if (context === null) return null;
    const normalized = snapshot.sessions.get(id)!.normalized;
    return {
      session: this.#mapper.sessionDetail(context.session),
      cursor: context.cursor as TimelineCursor,
      hasMore: context.hasMore,
      interactionSession: {
        archived: normalized.session.archived,
        interaction: normalized.interaction ?? null,
      },
    };
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

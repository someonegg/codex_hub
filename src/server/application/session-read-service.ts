import type {
  SessionDetailResponse,
  SessionHome,
  SessionListResponse,
  SessionMessagesQuery,
  SessionMessagesResponse,
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
import { createUpdateRevision } from "../updates/update-revision.js";
import { CatalogInteractionSessionReader } from "./interaction-session-reader.js";
import type {
  InteractionSessionSnapshot,
  SessionMessagesRead,
  SessionReader,
} from "./session-reader.js";
import { assembleSessionResponse, type SessionInteractionDescriber } from "./session-response.js";

export interface SessionReadServiceDependencies extends CatalogSnapshotStoreDependencies {
  /** Shared catalog; when supplied, it owns source refresh and freshness configuration. */
  readonly store?: CatalogSnapshotStore;
  readonly interaction?: SessionInteractionDescriber;
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
  readonly #interaction?: SessionInteractionDescriber;
  readonly #interactionSessions: CatalogInteractionSessionReader;

  constructor(sources: readonly SessionSource[], options: SessionReadServiceDependencies = {}) {
    const {
      store,
      interaction,
      resolveDisplayTitle,
      homes,
      freshnessMs = DEFAULT_CATALOG_FRESHNESS_MS,
      now = performance.now.bind(performance),
      runtime,
      ...storeDependencies
    } = options;
    this.runtime = runtime;
    this.#mapper = new SessionApiMapper(resolveDisplayTitle, homes);
    this.#store = store ?? new CatalogSnapshotStore(sources, freshnessMs, now, storeDependencies);
    this.#interaction = interaction;
    this.#interactionSessions = new CatalogInteractionSessionReader(this.#store);
    this.#queries = new SessionQueries();
  }

  async managementSnapshot() {
    const snapshot = await this.#store.refresh();
    const byId = new Map([...snapshot.sessions].map(([id, value]) => [id, value.session]));
    return { sessions: [...byId.values()], byId };
  }

  async refresh(): Promise<void> {
    await this.#store.refresh();
  }

  async list(): Promise<SessionListResponse> {
    const snapshot = await this.#store.current();
    const sessions = [...snapshot.sessions.values()].map(({ session }) => session);
    if (!this.runtime) return this.#mapper.list(sessions);
    const states = await Promise.all(
      sessions.map((session) => this.runtime!.evaluate(session, false)),
    );
    const byId = new Map(sessions.map((session, index) => [session.id, states[index]!.status]));
    return this.#mapper.list(sessions, byId);
  }

  async getSession(id: SessionId): Promise<SessionDetailResponse | null> {
    return (await this.readMessages(id))?.state ?? null;
  }

  async messages(
    id: SessionId,
    query: SessionMessagesQuery,
  ): Promise<SessionMessagesResponse | null> {
    return (await this.readMessages(id))?.page(query) ?? null;
  }

  async readMessages(id: SessionId): Promise<SessionMessagesRead | null> {
    const snapshot = await this.#store.current();
    const source = this.#queries.session(snapshot, id);
    if (!source) return null;
    const session = this.#mapper.sessionDetail(source);
    const interactionSession = await this.#runtimeDetail(session, snapshot);
    const state = await assembleSessionResponse(
      { session, interactionSession },
      this.#interaction,
      createUpdateRevision,
    );
    return {
      state,
      page: (query) => {
        const result = this.#queries.messages(snapshot, id, query)!;
        return {
          ...state,
          items: result.items,
          nextAfter: result.nextAfter,
          hasMore: result.hasMore,
        };
      },
    };
  }

  async #runtimeDetail(
    detail: SessionDetail,
    snapshot: Awaited<ReturnType<CatalogSnapshotStore["current"]>>,
  ) {
    const normalized = snapshot.sessions.get(detail.id)!;
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

  getInteractionSession(id: SessionId): Promise<InteractionSessionSnapshot | null> {
    return this.#interactionSessions.getInteractionSession(id);
  }
}

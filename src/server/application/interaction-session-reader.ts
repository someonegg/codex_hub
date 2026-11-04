import type { SessionId } from "../../shared/domain.js";
import type { CatalogSnapshotStore } from "../repository/catalog-snapshot-store.js";
import type { InteractionSessionReader, InteractionSessionSnapshot } from "./session-reader.js";

/** Read internal interaction facts without assembling public session responses. */
export class CatalogInteractionSessionReader implements InteractionSessionReader {
  constructor(private readonly store: CatalogSnapshotStore) {}

  async getInteractionSession(id: SessionId): Promise<InteractionSessionSnapshot | null> {
    const normalized = (await this.store.current()).sessions.get(id);
    return normalized === undefined
      ? null
      : {
          archived: normalized.session.archived,
          interaction: normalized.interaction ?? null,
        };
  }
}

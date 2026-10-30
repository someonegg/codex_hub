import type {
  DomainDiagnostic,
  DomainSessionOrigin,
  NormalizedSession,
} from "../domain/session-domain.js";

export interface SessionSourceDescriptor {
  readonly sourceType: string;
  readonly instanceKey: string;
  readonly home: string;
  readonly displayName: string;
}

export interface SourceSessionEntry {
  readonly localId: string;
  readonly nativeSessionId: string | null;
  readonly parentNativeSessionId: string | null;
  readonly origin: DomainSessionOrigin;
  /**
   * Published normalized values are immutable snapshots. An adapter must never
   * mutate this object, its timeline items, detail values, maps, or other nested
   * values after returning them from refresh().
   *
   * Adapters may reuse an unchanged NormalizedSession, timeline item, or detail
   * value by reference across snapshots. Reference reuse is an optimization hint
   * to the repository and therefore must mean that the referenced value is
   * unchanged. Returning fresh immutable objects for unchanged content is valid,
   * but may require the repository to recompute derived state.
   */
  readonly normalized: NormalizedSession;
}

export interface SessionSourceSnapshot {
  readonly signature: string;
  readonly sessions: readonly SourceSessionEntry[];
  readonly diagnostics: readonly DomainDiagnostic[];
}

export interface SessionSource {
  readonly descriptor: SessionSourceDescriptor;
  /**
   * Returns a newly observed immutable source snapshot. Values published by an
   * earlier call remain immutable even after later refreshes complete.
   */
  refresh(): Promise<SessionSourceSnapshot>;
}

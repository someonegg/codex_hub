import type {
  DomainBindingEvent,
  DomainDiagnostic,
  DomainSession,
  DomainSessionOrigin,
  NormalizedSession,
} from "../domain/session-domain.js";

export interface SessionSourceDescriptor {
  readonly sourceType: string;
  readonly instanceKey: string;
  readonly agent: string;
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

export interface SourceBindingEvent extends Omit<DomainBindingEvent, "sessionId"> {
  readonly localId: string;
}

export interface SessionSourceSnapshot {
  /**
   * Immutable evidence from the decoded batch. Reused snapshots may repeat it;
   * consumers must deliver each snapshot once. Refresh has no binding side effects.
   */
  readonly bindings?: readonly SourceBindingEvent[];
  readonly signature: string;
  readonly sessions: readonly SourceSessionEntry[];
  readonly diagnostics: readonly DomainDiagnostic[];
}

export interface SessionSource {
  readonly descriptor: SessionSourceDescriptor;
  /** Optional advisory title lookup, refreshed independently of structural content. */
  displayTitleFor?(session: DomainSession): string | null;
  /**
   * Returns a newly observed immutable source snapshot. Values published by an
   * earlier call remain immutable even after later refreshes complete.
   */
  refresh(): Promise<SessionSourceSnapshot>;
}

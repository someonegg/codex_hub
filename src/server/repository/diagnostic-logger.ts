import type { DomainDiagnostic } from "../domain/session-domain.js";
import { opaqueIdForParts } from "../security/opaque-id.js";
import type { SessionSourceDescriptor, SessionSourceSnapshot } from "../source/session-source.js";

export interface DiagnosticLogRecord extends DomainDiagnostic {
  readonly home: string;
  readonly sessionId: string | null;
  readonly scope: "source" | "session" | "aggregate";
}

export interface DiagnosticLogger {
  log(record: DiagnosticLogRecord): void;
}

const stderrLogger: DiagnosticLogger = {
  log(record) {
    console.error("Session diagnostic", record);
  },
};

export interface AggregateDiagnostic {
  readonly sessionId: string;
  readonly diagnostic: DomainDiagnostic;
}

interface DiagnosticState {
  readonly reference: readonly DomainDiagnostic[];
  readonly signatures: ReadonlySet<string>;
}
interface SourceState {
  readonly snapshot: SessionSourceSnapshot;
  readonly diagnostics: ReadonlyMap<string, DiagnosticState>;
}

/** Refresh-only state: bounded by the current sources and sessions. */
export class RefreshDiagnosticLogger {
  #sources = new Map<string, SourceState>();
  constructor(private readonly logger: DiagnosticLogger = stderrLogger) {}

  update(
    sources: readonly {
      descriptor: SessionSourceDescriptor;
      snapshot: SessionSourceSnapshot;
    }[],
    aggregates: ReadonlyMap<string, readonly AggregateDiagnostic[]> = new Map(),
  ): void {
    const next = new Map<string, SourceState>();
    for (const { descriptor, snapshot } of sources) {
      const home = descriptor.home;
      const previous = this.#sources.get(home);
      if (previous?.snapshot === snapshot) {
        next.set(home, previous);
        continue;
      }
      const diagnostics = new Map<string, DiagnosticState>();
      const record = (
        key: string,
        items: readonly DomainDiagnostic[],
        scope: DiagnosticLogRecord["scope"],
        sessionId: string | null,
      ) => {
        const prior = previous?.diagnostics.get(key);
        if (prior?.reference === items) {
          diagnostics.set(key, prior);
          return;
        }
        const signatures = new Set<string>();
        for (const item of items.slice(0, 50)) {
          const signature = JSON.stringify([item.severity, item.code, item.message, item.ordinal]);
          if (!signatures.has(signature) && !prior?.signatures.has(signature)) {
            try {
              this.logger.log({
                home,
                sessionId,
                scope,
                severity: item.severity,
                code: item.code,
                message: item.message,
                ordinal: item.ordinal,
              });
            } catch {
              /* Logging must never affect reading or management. */
            }
          }
          signatures.add(signature);
        }
        diagnostics.set(key, { reference: items, signatures });
      };
      record("source", snapshot.diagnostics, "source", null);
      const ids = new Set<string>();
      for (const entry of snapshot.sessions) {
        const sessionId = opaqueIdForParts(descriptor.instanceKey, entry.localId);
        if (ids.has(entry.localId)) continue;
        record(`session:${sessionId}`, entry.normalized.session.diagnostics, "session", sessionId);
        ids.add(entry.localId);
      }
      for (const { sessionId, diagnostic } of aggregates.get(home) ?? []) {
        record(`aggregate:${sessionId}`, [diagnostic], "aggregate", sessionId);
      }
      next.set(home, { snapshot, diagnostics });
    }
    this.#sources = next;
  }
}

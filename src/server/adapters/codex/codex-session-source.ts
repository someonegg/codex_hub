import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type {
  DomainDiagnostic,
  DomainSession,
  DomainSessionOrigin,
  NormalizedSession,
} from "../../domain/session-domain.js";
import type {
  SessionSource,
  SessionSourceDescriptor,
  SessionSourceSnapshot,
  SourceBindingEvent,
  SourceSessionEntry,
} from "../../source/session-source.js";
import { mergeBindingMetadata } from "../shared/binding-protocol.js";
import {
  CheckpointedJsonlDecoder,
  type JsonlCheckpoint,
  type JsonlDecoder,
} from "../shared/jsonl-decoder.js";
import { MAX_SESSION_DIAGNOSTICS } from "../shared/limits.js";
import {
  acceptedPathOrder,
  type FileFingerprint,
  fingerprintOf,
  mutableTelemetry,
  type RefreshTelemetry,
  sameFingerprint,
} from "../shared/source-cache.js";
import { type IdentityAccumulatorState, IdentityResolver } from "./identity-resolver.js";
import { codexBindingAttemptsFrom, codexInteraction } from "./interaction-parser.js";
import { isExpectedIoError } from "./io-errors.js";
import { JsonlCatalogSource } from "./jsonl-catalog-source.js";
import type { RolloutDescriptor } from "./rollout-descriptor.js";
import { SessionIndexReader } from "./session-index-reader.js";
import {
  DefaultSessionNormalizer,
  type SessionNormalizer,
  type SessionNormalizerState,
} from "./session-normalizer.js";

interface CodexCacheEntry {
  readonly descriptor: RolloutDescriptor;
  readonly fingerprint: FileFingerprint;
  readonly normalized: NormalizedSession;
  readonly threadId: string | null;
  readonly parentThreadId: string | null;
  readonly origin: DomainSessionOrigin;
  readonly checkpoint: JsonlCheckpoint;
  readonly identityState: IdentityAccumulatorState;
  readonly normalizerState: SessionNormalizerState;
  readonly bindProjectDirectory: string | null;
}

export class CodexSessionSource implements SessionSource {
  readonly descriptor: SessionSourceDescriptor;
  #cache = new Map<string, CodexCacheEntry>();
  #duplicates = new Map<string, { fingerprint: FileFingerprint; threadId: string }>();
  #snapshot: SessionSourceSnapshot | null = null;
  #lastRefreshTelemetry: RefreshTelemetry = mutableTelemetry();

  private readonly decoder: JsonlDecoder;
  private readonly identity: IdentityResolver;
  private readonly normalizer: SessionNormalizer;
  private readonly sessionIndex: SessionIndexReader;

  constructor(
    private readonly codexHome: string,
    instanceKey: string,
    {
      decoder = new CheckpointedJsonlDecoder(),
      identity = new IdentityResolver(),
      normalizer = new DefaultSessionNormalizer(),
      sessionIndex = new SessionIndexReader(codexHome),
      home = "default",
    }: CodexSourceOptions = {},
  ) {
    this.decoder = decoder;
    this.identity = identity;
    this.normalizer = normalizer;
    this.sessionIndex = sessionIndex;
    this.descriptor = { sourceType: "codex-jsonl", instanceKey, home, displayName: "Codex" };
  }

  async refresh(): Promise<SessionSourceSnapshot> {
    await this.sessionIndex.refresh();
    const archivedDescriptors = new Map(
      [...this.#cache.values()]
        .filter((entry) => entry.descriptor.archived)
        .map((entry) => [entry.descriptor.path, entry.descriptor] as const),
    );
    const discovery = await new JsonlCatalogSource(this.codexHome, archivedDescriptors).discover();
    const discoverySignature = JSON.stringify({
      diagnostics: discovery.diagnostics,
      entries: discovery.entries.map(({ descriptor }) => fingerprintOf(descriptor)),
    });
    const nextCache = new Map<string, CodexCacheEntry>();
    const nextDuplicates = new Map<string, { fingerprint: FileFingerprint; threadId: string }>();
    const binds = new Map<string, Omit<SourceBindingEvent, "localId">[]>();
    const telemetry = mutableTelemetry();
    const unavailableRollouts: string[] = [];
    const loadDiagnostics: DomainDiagnostic[] = [];
    const acceptedThreads = new Set<string>();
    const duplicateThreads = new Set<string>();
    // Previously accepted paths take precedence; discovery order breaks first-scan ties.
    const candidates = [...discovery.entries].sort((left, right) =>
      acceptedPathOrder(
        this.#cache,
        left.descriptor.sourceRelativePath,
        right.descriptor.sourceRelativePath,
      ),
    );
    for (const { descriptor } of candidates) {
      const fingerprint = fingerprintOf(descriptor);
      const duplicate = this.#duplicates.get(descriptor.sourceRelativePath);
      if (
        duplicate &&
        sameFingerprint(duplicate.fingerprint, fingerprint) &&
        acceptedThreads.has(duplicate.threadId)
      ) {
        nextDuplicates.set(descriptor.sourceRelativePath, duplicate);
        duplicateThreads.add(duplicate.threadId);
        continue;
      }
      const cached = this.#cache.get(descriptor.sourceRelativePath);
      let loaded: CodexCacheEntry | null;
      if (cached !== undefined && sameFingerprint(cached.fingerprint, fingerprint)) {
        loaded = cached;
      } else {
        loaded = await this.#load(descriptor, fingerprint, cached, telemetry, binds);
      }
      if (loaded === null) {
        unavailableRollouts.push(descriptor.sourceRelativePath);
        loadDiagnostics.push(rolloutUnavailableDiagnostic());
        continue;
      }
      if (loaded.threadId !== null) {
        if (acceptedThreads.has(loaded.threadId)) {
          nextDuplicates.set(descriptor.sourceRelativePath, {
            fingerprint,
            threadId: loaded.threadId,
          });
          duplicateThreads.add(loaded.threadId);
          binds.delete(descriptor.id);
          continue;
        }
        acceptedThreads.add(loaded.threadId);
      }
      nextCache.set(descriptor.sourceRelativePath, loaded);
    }
    const sessions = sourceEntries(nextCache);
    const diagnostics = [
      ...discovery.diagnostics.map((item) => ({ ...item })),
      ...loadDiagnostics,
      ...[...duplicateThreads].map(
        (): DomainDiagnostic => ({
          code: "duplicate_native_session_id",
          severity: "warning",
          message:
            "Multiple Codex rollouts declared the same native session ID; duplicate rollouts were ignored.",
          ordinal: null,
        }),
      ),
    ].slice(0, MAX_SESSION_DIAGNOSTICS);
    const bindings = sessions.flatMap((entry) =>
      (binds.get(entry.normalized.session.id) ?? []).map((event) => ({
        ...event,
        localId: entry.localId,
      })),
    );
    const signature = JSON.stringify({
      discoverySignature,
      unavailableRollouts,
      projects: sessions.map((entry) => [
        entry.localId,
        entry.normalized.session.projectDirectory,
        entry.normalized.session.taskName ?? null,
      ]),
    });
    const snapshot = { signature, sessions, diagnostics, bindings };
    this.#cache = nextCache;
    this.#duplicates = nextDuplicates;
    this.#lastRefreshTelemetry = telemetry;
    if (this.#snapshot?.signature === signature) return this.#snapshot;
    this.#snapshot = snapshot;
    return snapshot;
  }

  lastRefreshTelemetry(): RefreshTelemetry {
    return { ...this.#lastRefreshTelemetry };
  }

  displayTitleFor(session: DomainSession): string | null {
    if (session.origin.home !== this.descriptor.home || session.sourceId === null) return null;
    return this.sessionIndex.threadName(session.sourceId);
  }

  async #load(
    descriptor: RolloutDescriptor,
    fingerprint: FileFingerprint,
    cached: CodexCacheEntry | undefined,
    telemetry: RefreshTelemetry,
    binds: Map<string, Omit<SourceBindingEvent, "localId">[]>,
  ): Promise<CodexCacheEntry | null> {
    try {
      const decodeStartedAt = performance.now();
      const decoded = await this.decoder.decode(descriptor, cached?.checkpoint);
      telemetry.decodeMs += performance.now() - decodeStartedAt;
      telemetry.probeBytes += decoded.telemetry.probeBytes;
      telemetry.decodeBytes += decoded.telemetry.decodeBytes;
      telemetry[decoded.mode === "append" ? "appendFiles" : "fullFiles"] += 1;

      const normalizeStartedAt = performance.now();
      const identityBase =
        decoded.mode === "append" && cached !== undefined
          ? cached.identityState
          : this.identity.create(descriptor);
      const normalizerBase =
        decoded.mode === "append" && cached !== undefined
          ? cached.normalizerState
          : this.normalizer.create(descriptor);
      const identityState = this.identity.append(identityBase, decoded.records);
      const normalizerState = this.normalizer.append(
        normalizerBase,
        decoded.records,
        decoded.diagnostics,
      );
      const bindingEvents = decoded.records.flatMap((record) => {
        const timestamp =
          typeof record.value.timestamp === "string" ? Date.parse(record.value.timestamp) : NaN;
        return codexBindingAttemptsFrom(record).map((attempt, position) => ({
          time: Number.isFinite(timestamp) ? timestamp : 0,
          ordinal: record.ordinal,
          position,
          attempt,
        }));
      });
      binds.set(descriptor.id, bindingEvents);
      const metadata = this.identity.metadata(identityState);
      const origin = this.#origin(metadata.agentVersion);
      const baseNormalized =
        decoded.mode === "append" &&
        cached !== undefined &&
        identityState === cached.identityState &&
        normalizerState === cached.normalizerState &&
        sameOrigin(origin, cached.origin)
          ? cached.normalized
          : this.normalizer.materialize(normalizerState, metadata, origin);
      const { projectDirectory: bindProjectDirectory, taskName } = mergeBindingMetadata(
        {
          projectDirectory:
            decoded.mode === "append" ? (cached?.bindProjectDirectory ?? null) : null,
          taskName:
            decoded.mode === "append" ? (cached?.normalized.session.taskName ?? null) : null,
        },
        bindingEvents.map((event) => event.attempt),
      );
      const projectDirectory = bindProjectDirectory ?? baseNormalized.session.workingDirectory;
      const normalized =
        baseNormalized === cached?.normalized &&
        projectDirectory === cached.normalized.session.projectDirectory &&
        (taskName ?? undefined) === cached.normalized.session.taskName
          ? cached.normalized
          : {
              ...baseNormalized,
              session: {
                ...baseNormalized.session,
                projectDirectory,
                taskName: taskName ?? undefined,
              },
              interaction: codexInteraction(projectDirectory, taskName ?? null),
            };
      telemetry.normalizeMs += performance.now() - normalizeStartedAt;
      return {
        descriptor,
        fingerprint,
        normalized,
        threadId: metadata.threadId,
        parentThreadId: metadata.parentThreadId,
        origin,
        checkpoint: decoded.checkpoint,
        identityState,
        normalizerState,
        bindProjectDirectory,
      };
    } catch (error) {
      if (!isExpectedIoError(error)) throw error;
      return null;
    }
  }

  #origin(agentVersion: string | null): DomainSessionOrigin {
    return {
      sourceType: this.descriptor.sourceType,
      home: this.descriptor.home,
      agentName: this.descriptor.displayName,
      agentVersion,
    };
  }
}

export interface CodexSourceOptions {
  readonly decoder?: JsonlDecoder;
  readonly identity?: IdentityResolver;
  readonly normalizer?: SessionNormalizer;
  readonly sessionIndex?: SessionIndexReader;
  readonly home?: string;
}

export async function createCodexSessionSource(
  codexHome: string,
  options: CodexSourceOptions = {},
) {
  const configured = resolve(codexHome);
  return new CodexSessionSource(configured, `codex-jsonl\0${configured}`, options);
}

function sourceEntries(cache: ReadonlyMap<string, CodexCacheEntry>): SourceSessionEntry[] {
  const sessions: SourceSessionEntry[] = [];
  for (const entry of cache.values()) {
    const { threadId } = entry;
    sessions.push({
      localId: sourceLocalId(threadId, entry.fingerprint.sourceRelativePath),
      nativeSessionId: threadId,
      parentNativeSessionId: entry.parentThreadId,
      origin: entry.origin,
      normalized: entry.normalized,
    });
  }
  return sessions;
}

function sourceLocalId(threadId: string | null, sourceRelativePath: string): string {
  if (threadId === null) return `resource:${sourceRelativePath}`;
  return `thread:${threadId}`;
}

function rolloutUnavailableDiagnostic(): DomainDiagnostic {
  return {
    code: "rollout_unavailable",
    severity: "warning",
    message: "A registered rollout could not be read.",
    ordinal: null,
  };
}

function sameOrigin(left: DomainSessionOrigin, right: DomainSessionOrigin): boolean {
  return (
    left.sourceType === right.sourceType &&
    left.home === right.home &&
    left.agentName === right.agentName &&
    left.agentVersion === right.agentVersion
  );
}

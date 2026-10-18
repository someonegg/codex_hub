import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type {
  DomainDiagnostic,
  DomainSession,
  DomainSessionOrigin,
  NormalizedSession,
} from "../../domain/session-domain.js";
import {
  type LivePaneBindEvent,
  type LivePaneBindingManager,
  livePaneBindings,
} from "../../interaction/live-pane-binding-manager.js";
import { opaqueIdForParts } from "../../security/opaque-id.js";
import type {
  SessionSource,
  SessionSourceDescriptor,
  SessionSourceSnapshot,
  SourceSessionEntry,
} from "../../source/session-source.js";
import { type IdentityAccumulatorState, IdentityResolver } from "./identity-resolver.js";
import { codexBindingAttemptsFrom } from "./interaction-parser.js";
import { isExpectedIoError } from "./io-errors.js";
import { JsonlCatalogSource } from "./jsonl-catalog-source.js";
import { DECODER_VERSION, NORMALIZER_VERSION } from "./limits.js";
import { PathPolicy, type RolloutDescriptor } from "./path-policy.js";
import { ProjectDirectoryResolver } from "./project-directory-resolver.js";
import {
  CheckpointedRolloutDecoder,
  type RolloutCheckpoint,
  type RolloutDecoder,
} from "./rollout-decoder.js";
import { SessionIndexReader } from "./session-index-reader.js";
import {
  DefaultSessionNormalizer,
  type SessionNormalizer,
  type SessionNormalizerState,
} from "./session-normalizer.js";

interface FileFingerprint {
  readonly sourceRelativePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly decoderVersion: number;
  readonly normalizerVersion: number;
}

interface CodexCacheEntry {
  readonly descriptor: RolloutDescriptor;
  readonly fingerprint: FileFingerprint;
  readonly normalized: NormalizedSession;
  readonly threadId: string | null;
  readonly parentThreadId: string | null;
  readonly origin: DomainSessionOrigin;
  readonly checkpoint: RolloutCheckpoint;
  readonly identityState: IdentityAccumulatorState;
  readonly normalizerState: SessionNormalizerState;
}

export interface CodexRefreshTelemetry {
  readonly fullFiles: number;
  readonly appendFiles: number;
  readonly probeBytes: number;
  readonly decodeBytes: number;
  readonly decodeMs: number;
  readonly normalizeMs: number;
}

const EMPTY_TELEMETRY: CodexRefreshTelemetry = {
  fullFiles: 0,
  appendFiles: 0,
  probeBytes: 0,
  decodeBytes: 0,
  decodeMs: 0,
  normalizeMs: 0,
};

export class CodexSessionSource implements SessionSource {
  readonly descriptor: SessionSourceDescriptor;
  #cache = new Map<string, CodexCacheEntry>();
  readonly #observedRoots = new Set<string>();
  #snapshot: SessionSourceSnapshot | null = null;
  #lastRefreshTelemetry: CodexRefreshTelemetry = EMPTY_TELEMETRY;

  constructor(
    private readonly codexHome: string,
    instanceKey: string,
    private readonly decoder: RolloutDecoder = new CheckpointedRolloutDecoder(),
    private readonly identity = new IdentityResolver(),
    private readonly normalizer: SessionNormalizer = new DefaultSessionNormalizer(),
    private readonly sessionIndex = new SessionIndexReader(codexHome),
    private readonly projectDirectories = new ProjectDirectoryResolver(),
    private readonly bindings: LivePaneBindingManager = livePaneBindings,
  ) {
    this.descriptor = {
      sourceType: "codex-jsonl",
      instanceKey,
      sourceInstanceId: opaqueIdForParts("source", instanceKey),
      displayName: "Codex",
    };
  }

  async refresh(): Promise<SessionSourceSnapshot> {
    await this.sessionIndex.refresh();
    const policy = await PathPolicy.create(this.codexHome);
    const archivedDescriptors = new Map(
      [...this.#cache.values()]
        .filter((entry) => entry.descriptor.archived)
        .map((entry) => [entry.descriptor.canonicalPath, entry.descriptor] as const),
    );
    const discovery = await new JsonlCatalogSource(policy, archivedDescriptors).discover();
    const presentRoots = new Set(policy.roots().map((root) => root.canonicalPath));
    for (const root of this.#observedRoots) {
      if (!presentRoots.has(root))
        discovery.diagnostics.push({
          code: "session_root_unreadable",
          severity: "warning",
          message: "A previously observed session directory is unavailable.",
          ordinal: null,
        });
    }
    for (const root of presentRoots) this.#observedRoots.add(root);
    const discoverySignature = JSON.stringify({
      diagnostics: discovery.diagnostics,
      entries: discovery.entries.map(({ descriptor }) => fingerprintOf(descriptor)),
    });
    const nextCache = new Map<string, CodexCacheEntry>();
    const binds = new Map<string, LivePaneBindEvent[]>();
    const telemetry = mutableTelemetry();
    const unavailableRollouts: string[] = [];
    const loadDiagnostics: DomainDiagnostic[] = [];
    const acceptedThreads = new Set<string>();
    const duplicateThreads = new Set<string>();
    // Previously accepted paths take precedence; discovery order breaks first-scan ties.
    const candidates = [...discovery.entries].sort(
      (left, right) =>
        Number(this.#cache.has(right.descriptor.sourceRelativePath)) -
        Number(this.#cache.has(left.descriptor.sourceRelativePath)),
    );
    for (const { descriptor } of candidates) {
      const fingerprint = fingerprintOf(descriptor);
      const cached = this.#cache.get(descriptor.sourceRelativePath);
      let loaded: CodexCacheEntry | null;
      if (cached !== undefined && sameFingerprint(cached.fingerprint, fingerprint)) {
        if (descriptor.archived) {
          loaded = cached;
        } else {
          try {
            await access(descriptor.canonicalPath, constants.R_OK);
            loaded = cached;
          } catch (error) {
            if (!isExpectedIoError(error)) throw error;
            loaded = null;
          }
        }
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
          duplicateThreads.add(loaded.threadId);
          binds.delete(descriptor.id);
          continue;
        }
        acceptedThreads.add(loaded.threadId);
      }
      nextCache.set(descriptor.sourceRelativePath, loaded);
    }
    const directories = await this.projectDirectories.resolveAll(
      [...nextCache.values()].map((entry) => entry.normalized.session.workingDirectory),
    );
    for (const [key, entry] of nextCache) {
      const session = entry.normalized.session;
      const projectDirectory = directories.get(session.workingDirectory) ?? null;
      if (session.projectDirectory === projectDirectory) continue;
      nextCache.set(key, {
        ...entry,
        normalized: {
          ...entry.normalized,
          session: { ...session, projectDirectory },
        },
      });
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
    ];
    for (const entry of sessions) {
      for (const event of binds.get(entry.normalized.session.id) ?? []) {
        this.bindings.submit({
          ...event,
          sessionId: opaqueIdForParts(this.descriptor.instanceKey, entry.localId),
        });
      }
    }
    const signature = JSON.stringify({
      discoverySignature,
      unavailableRollouts,
      directories: [...directories],
    });
    const snapshot = { signature, sessions, diagnostics };
    this.#cache = nextCache;
    this.#lastRefreshTelemetry = telemetry;
    if (this.#snapshot?.signature === signature) return this.#snapshot;
    this.#snapshot = snapshot;
    return snapshot;
  }

  lastRefreshTelemetry(): CodexRefreshTelemetry {
    return { ...this.#lastRefreshTelemetry };
  }

  nicknameFor(session: DomainSession): string | null {
    if (
      session.origin.sourceInstanceId !== this.descriptor.sourceInstanceId ||
      session.sourceId === null
    )
      return null;
    return this.sessionIndex.threadName(session.sourceId);
  }

  async #load(
    descriptor: RolloutDescriptor,
    fingerprint: FileFingerprint,
    cached: CodexCacheEntry | undefined,
    telemetry: MutableCodexRefreshTelemetry,
    binds: Map<string, LivePaneBindEvent[]>,
  ): Promise<CodexCacheEntry | null> {
    try {
      const appendCheckpoint =
        cached?.fingerprint.normalizerVersion === NORMALIZER_VERSION
          ? cached.checkpoint
          : undefined;
      const decodeStartedAt = performance.now();
      const decoded = await this.decoder.decode(descriptor, appendCheckpoint);
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
      binds.set(
        descriptor.id,
        decoded.records.flatMap((record) => {
          const timestamp =
            typeof record.value.timestamp === "string" ? Date.parse(record.value.timestamp) : NaN;
          return codexBindingAttemptsFrom(record).map((attempt, position) => ({
            sessionId: descriptor.id,
            time: Number.isFinite(timestamp) ? timestamp : 0,
            ordinal: record.ordinal,
            position,
            attempt,
          }));
        }),
      );
      const metadata = this.identity.metadata(identityState);
      const origin = this.#origin(metadata.agentVersion);
      const normalized =
        decoded.mode === "append" &&
        cached !== undefined &&
        identityState === cached.identityState &&
        normalizerState === cached.normalizerState &&
        sameOrigin(origin, cached.origin)
          ? cached.normalized
          : this.normalizer.materialize(normalizerState, metadata, origin);
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
      };
    } catch (error) {
      if (!isExpectedIoError(error)) throw error;
      return null;
    }
  }

  #origin(agentVersion: string | null): DomainSessionOrigin {
    return {
      sourceType: this.descriptor.sourceType,
      sourceInstanceId: this.descriptor.sourceInstanceId,
      agentName: this.descriptor.displayName,
      agentVersion,
      formatVersion: null,
    };
  }
}

export async function createCodexSessionSource(
  codexHome: string,
  bindings: LivePaneBindingManager = livePaneBindings,
): Promise<CodexSessionSource> {
  const configured = resolve(codexHome);
  return new CodexSessionSource(
    configured,
    `codex-jsonl\0${configured}`,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    bindings,
  );
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

function fingerprintOf(descriptor: RolloutDescriptor): FileFingerprint {
  return {
    sourceRelativePath: descriptor.sourceRelativePath,
    size: descriptor.size,
    mtimeMs: descriptor.mtimeMs,
    decoderVersion: DECODER_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return (
    left.sourceRelativePath === right.sourceRelativePath &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.decoderVersion === right.decoderVersion &&
    left.normalizerVersion === right.normalizerVersion
  );
}

interface MutableCodexRefreshTelemetry {
  fullFiles: number;
  appendFiles: number;
  probeBytes: number;
  decodeBytes: number;
  decodeMs: number;
  normalizeMs: number;
}

function mutableTelemetry(): MutableCodexRefreshTelemetry {
  return { ...EMPTY_TELEMETRY };
}

function sameOrigin(left: DomainSessionOrigin, right: DomainSessionOrigin): boolean {
  return (
    left.sourceType === right.sourceType &&
    left.sourceInstanceId === right.sourceInstanceId &&
    left.agentName === right.agentName &&
    left.agentVersion === right.agentVersion &&
    left.formatVersion === right.formatVersion
  );
}

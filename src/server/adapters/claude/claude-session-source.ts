import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { DomainDiagnostic, NormalizedSession } from "../../domain/session-domain.js";
import { sessionTitleFromMarkdown } from "../../domain/session-text.js";
import type {
  SessionSource,
  SessionSourceDescriptor,
  SessionSourceSnapshot,
  SourceBindingEvent,
  SourceSessionEntry,
} from "../../source/session-source.js";
import { isExpectedIoError as expectedIo } from "../shared/io-errors.js";
import { CheckpointedJsonlDecoder, type JsonlCheckpoint } from "../shared/jsonl-decoder.js";
import { MAX_SESSION_DIAGNOSTICS } from "../shared/limits.js";
import {
  acceptedPathOrder,
  type FileFingerprint,
  mutableTelemetry,
  sameFingerprint,
} from "../shared/source-cache.js";
import { claudeInteraction, claudeRecordBindings, validClaudeId } from "./interaction.js";
import {
  appendClaudeRecords,
  claudeDecoderDiagnostics,
  type ClaudeState,
  createClaudeState,
} from "./session-normalizer.js";

type RejectedCacheEntry = Omit<CacheEntry, "entry"> & { readonly entry?: never };

interface CacheEntry {
  readonly fingerprint: FileFingerprint;
  readonly checkpoint: JsonlCheckpoint;
  readonly state: ClaudeState;
  readonly entry: SourceSessionEntry;
}
export class ClaudeSessionSource implements SessionSource {
  readonly descriptor: SessionSourceDescriptor;
  #decoder = new CheckpointedJsonlDecoder();
  #snapshot: SessionSourceSnapshot | null = null;
  #telemetry = mutableTelemetry();
  lastRefreshTelemetry() {
    return { ...this.#telemetry };
  }
  #cache = new Map<string, CacheEntry>();
  #rejected = new Map<string, RejectedCacheEntry>();
  constructor(
    private readonly directory: string,
    instanceKey: string,
    { home = "claude" }: { readonly home?: string } = {},
  ) {
    this.descriptor = { sourceType: "claude-jsonl", instanceKey, home, displayName: "Claude Code" };
  }
  async refresh(): Promise<SessionSourceSnapshot> {
    const diagnostics: DomainDiagnostic[] = [];
    const bindings: SourceBindingEvent[] = [];
    this.#telemetry = mutableTelemetry();
    const warn = (...items: readonly DomainDiagnostic[]) => {
      diagnostics.push(
        ...items.slice(0, Math.max(0, MAX_SESSION_DIAGNOSTICS - diagnostics.length)),
      );
    };
    const next = new Map<string, CacheEntry>();
    const rejected = new Map<string, RejectedCacheEntry>();
    const seen = new Set<string>();
    const projects = join(this.directory, "projects");
    try {
      const candidates = await discoverClaudeFiles(projects, warn);
      candidates.sort((a, b) =>
        acceptedPathOrder(
          this.#cache,
          relative(this.directory, a.path),
          relative(this.directory, b.path),
        ),
      );
      for (const { path, nativeId } of candidates) {
        if (seen.has(nativeId)) {
          warn({
            code: "duplicate_native_session_id",
            severity: "warning",
            message: "Duplicate Claude session file ignored",
            ordinal: null,
          });
          continue;
        }
        const key = relative(this.directory, path);
        const old = this.#cache.get(key) ?? this.#rejected.get(key);
        let decoded;
        let fingerprint: FileFingerprint;
        try {
          const info = await stat(path);
          fingerprint = { sourceRelativePath: key, size: info.size, mtimeMs: info.mtimeMs };
          if (old && sameFingerprint(old.fingerprint, fingerprint)) {
            if (old.entry !== undefined) {
              next.set(key, old);
              seen.add(nativeId);
            } else {
              rejected.set(key, old);
              warn(...old.state.diagnostics);
            }
            continue;
          }
          const started = performance.now();
          decoded = await this.#decoder.decode({ path }, old?.checkpoint);
          this.#telemetry.decodeMs += performance.now() - started;
          this.#telemetry[decoded.mode === "append" ? "appendFiles" : "fullFiles"]++;
          this.#telemetry.probeBytes += decoded.telemetry.probeBytes;
          this.#telemetry.decodeBytes += decoded.telemetry.decodeBytes;
        } catch (error) {
          if (!expectedIo(error)) throw error;
          warn({
            code: "session_unavailable",
            severity: "warning",
            message: "Claude session could not be read",
            ordinal: null,
          });
          continue;
        }
        const append = decoded.mode === "append" && !!old;
        const base = append ? old.state : createClaudeState(nativeId);
        const started = performance.now();
        const bindingEvents = decoded.records.flatMap(claudeRecordBindings);
        const state = appendClaudeRecords(
          base,
          decoded.records,
          claudeDecoderDiagnostics(decoded.diagnostics),
          bindingEvents,
        );
        this.#telemetry.normalizeMs += performance.now() - started;
        if (state.identityConflict) {
          warn(...state.diagnostics);
          rejected.set(key, { fingerprint, checkpoint: decoded.checkpoint, state });
          continue;
        }
        const entry =
          old?.entry !== undefined && old.state === state
            ? old.entry
            : materializeClaudeSession(state, nativeId, this.descriptor);
        const localId = entry.localId;
        next.set(key, {
          fingerprint,
          checkpoint: decoded.checkpoint,
          state,
          entry,
        });
        seen.add(nativeId);
        bindings.push(...bindingEvents.map((event) => ({ ...event, localId })));
      }
    } catch (error) {
      if (!expectedIo(error)) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warn({
          code: "source_unavailable",
          severity: "warning",
          message: "Claude projects directory could not be read",
          ordinal: null,
        });
    }
    this.#cache = next;
    this.#rejected = rejected;
    const sessions = [...next.values()].map((cached) => cached.entry);
    const snapshot = {
      bindings,
      sessions,
      diagnostics,
      signature: JSON.stringify([
        [...next].map(([path, cached]) => [path, cached.fingerprint, cached.checkpoint]),
        diagnostics,
      ]),
    };
    if (this.#snapshot?.signature === snapshot.signature) return this.#snapshot;
    this.#snapshot = snapshot;
    return snapshot;
  }
}
export async function createClaudeSessionSource(
  home: string,
  options: { readonly home?: string } = {},
) {
  const directory = resolve(home);
  return new ClaudeSessionSource(directory, `claude-jsonl\0${directory}`, options);
}

async function discoverClaudeFiles(
  projects: string,
  warn: (...items: readonly DomainDiagnostic[]) => void,
) {
  const candidates: { path: string; nativeId: string }[] = [];
  for (const project of (await readdir(projects, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!project.isDirectory()) continue;
    let files;
    try {
      files = await readdir(join(projects, project.name), { withFileTypes: true });
    } catch (error) {
      if (!expectedIo(error)) throw error;
      warn({
        code: "project_unavailable",
        severity: "warning",
        message: "Claude project directory could not be read",
        ordinal: null,
      });
      continue;
    }
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const nativeId = file.name.slice(0, -6);
      if (!validClaudeId(nativeId)) continue;
      candidates.push({ path: join(projects, project.name, file.name), nativeId });
    }
  }
  return candidates;
}

function materializeClaudeSession(
  state: ClaudeState,
  nativeId: string,
  descriptor: SessionSourceDescriptor,
): SourceSessionEntry {
  const projectDirectory = state.project ?? state.firstCwd;
  const origin = {
    sourceType: descriptor.sourceType,
    home: descriptor.home,
    agentName: descriptor.displayName,
    agentVersion: state.version,
  };
  const localId = `thread:${nativeId}`;
  const normalized: NormalizedSession = {
    session: {
      id: localId,
      sourceId: nativeId,
      origin,
      title:
        state.customTitle ??
        state.aiTitle ??
        (state.firstUser ? sessionTitleFromMarkdown(state.firstUser) : null) ??
        "Untitled session",
      workingDirectory: state.cwd,
      projectDirectory,
      taskName: state.taskName,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      archived: false,
      parentId: null,
      childIds: [],
      agent: null,
      warningCount: state.diagnostics.length,
      diagnostics: state.diagnostics,
    },
    timeline: state.timeline,
    interaction: claudeInteraction(projectDirectory, state.taskName),
  };
  return {
    localId,
    nativeSessionId: nativeId,
    parentNativeSessionId: null,
    origin,
    normalized,
  };
}

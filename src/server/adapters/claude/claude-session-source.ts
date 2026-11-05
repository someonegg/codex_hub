import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  DomainDiagnostic,
  DomainSession,
  NormalizedSession,
} from "../../domain/session-domain.js";
import { sessionTitleFromMarkdown } from "../../domain/session-text.js";
import { type PaneBindingManager, paneBindings } from "../../interaction/pane-binding-manager.js";
import { opaqueIdForParts } from "../../security/opaque-id.js";
import type {
  SessionSource,
  SessionSourceDescriptor,
  SessionSourceSnapshot,
  SourceSessionEntry,
} from "../../source/session-source.js";
import { isExpectedIoError as expectedIo } from "../shared/io-errors.js";
import { CheckpointedJsonlDecoder, type JsonlCheckpoint } from "../shared/jsonl-decoder.js";
import { MAX_SESSION_DIAGNOSTICS } from "../shared/limits.js";
import { claudeInteraction, validClaudeId } from "./interaction.js";
import { appendClaudeRecords, type ClaudeState, createClaudeState } from "./session-normalizer.js";

interface CacheEntry {
  readonly fingerprint: string;
  readonly checkpoint: JsonlCheckpoint;
  readonly state: ClaudeState;
  readonly entry: SourceSessionEntry;
}
export class ClaudeSessionSource implements SessionSource {
  readonly descriptor: SessionSourceDescriptor;
  #decoder = new CheckpointedJsonlDecoder();
  #telemetry = {
    fullFiles: 0,
    appendFiles: 0,
    probeBytes: 0,
    decodeBytes: 0,
    decodeMs: 0,
    normalizeMs: 0,
  };
  lastRefreshTelemetry() {
    return { ...this.#telemetry };
  }
  #cache = new Map<string, CacheEntry>();
  constructor(
    private readonly directory: string,
    instanceKey: string,
    private readonly bindings: PaneBindingManager = paneBindings,
    home = "claude",
  ) {
    this.descriptor = { sourceType: "claude-jsonl", instanceKey, home, displayName: "Claude Code" };
  }
  displayTitleFor(_session: DomainSession): string | null {
    return null;
  }
  async refresh(): Promise<SessionSourceSnapshot> {
    const diagnostics: DomainDiagnostic[] = [];
    this.#telemetry = {
      fullFiles: 0,
      appendFiles: 0,
      probeBytes: 0,
      decodeBytes: 0,
      decodeMs: 0,
      normalizeMs: 0,
    };
    const warn = (...items: readonly DomainDiagnostic[]) => {
      diagnostics.push(
        ...items.slice(0, Math.max(0, MAX_SESSION_DIAGNOSTICS - diagnostics.length)),
      );
    };
    const next = new Map<string, CacheEntry>();
    const seen = new Set<string>();
    const projects = join(this.directory, "projects");
    try {
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
      candidates.sort(
        (a, b) =>
          Number(this.#cache.has(b.path)) - Number(this.#cache.has(a.path)) ||
          a.path.localeCompare(b.path),
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
        const old = this.#cache.get(path);
        let decoded;
        let fingerprint: string;
        try {
          const info = await stat(path);
          fingerprint = JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
          if (old?.fingerprint === fingerprint) {
            next.set(path, old);
            seen.add(nativeId);
            continue;
          }
          const started = performance.now();
          decoded = await this.#decoder.decode({ path }, old?.checkpoint);
          this.#telemetry.decodeMs += performance.now() - started;
          this.#telemetry[decoded.mode === "append" ? "appendFiles" : "fullFiles"]++;
          this.#telemetry.probeBytes += decoded.telemetry.probeBytes;
          this.#telemetry.decodeBytes += decoded.telemetry.decodeBytes;
          fingerprint = decoded.fingerprint;
        } catch (error) {
          if (!expectedIo(error)) throw error;
          warn({
            code: "rollout_unavailable",
            severity: "warning",
            message: "Claude session could not be read",
            ordinal: null,
          });
          continue;
        }
        const append = decoded.mode === "append" && !!old;
        const base = append ? old.state : createClaudeState(nativeId);
        const started = performance.now();
        const state = {
          ...appendClaudeRecords(
            base,
            decoded.records,
            decoded.batchDiagnostics.map((d) =>
              d.code === "malformed_json" ? { ...d, code: "invalid_jsonl" } : d,
            ),
          ),
          line: decoded.checkpoint.physicalLineCount,
        };
        this.#telemetry.normalizeMs += performance.now() - started;
        if (state.identityConflict) {
          warn(...state.diagnostics);
          continue;
        }
        const projectDirectory = state.project ?? state.firstCwd;
        const origin = {
          sourceType: this.descriptor.sourceType,
          home: this.descriptor.home,
          agentName: this.descriptor.displayName,
          agentVersion: state.version,
          formatVersion: null,
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
              nativeId,
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
        const entry: SourceSessionEntry = {
          localId,
          nativeSessionId: nativeId,
          parentNativeSessionId: null,
          origin,
          normalized,
        };
        next.set(path, {
          fingerprint,
          checkpoint: decoded.checkpoint,
          state,
          entry,
        });
        seen.add(nativeId);
        for (const event of state.bindings.slice(append ? base.bindings.length : 0))
          this.bindings.submit({
            ...event,
            sessionId: opaqueIdForParts(this.descriptor.instanceKey, localId),
          });
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
    const sessions = [...next.values()].map((cached) => cached.entry);
    return {
      sessions,
      diagnostics,
      signature: JSON.stringify([
        [...next].map(([path, cached]) => [path, cached.fingerprint, cached.checkpoint]),
        diagnostics,
      ]),
    };
  }
}
export async function createClaudeSessionSource(
  home: string,
  bindings: PaneBindingManager = paneBindings,
  nickname = "claude",
) {
  const directory = resolve(home);
  return new ClaudeSessionSource(directory, `claude-jsonl\0${directory}`, bindings, nickname);
}

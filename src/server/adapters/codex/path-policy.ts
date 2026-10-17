import { lstat, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

import type { DomainDiagnostic } from "../../domain/session-domain.js";
import { opaqueIdForPath } from "../../security/opaque-id.js";
import { isExpectedIoError } from "./io-errors.js";

const ROLLOUT_NAME = /^rollout-[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/;

export interface RolloutDescriptor {
  id: string;
  canonicalPath: string;
  sourceRelativePath: string;
  archived: boolean;
  size: number;
  mtimeMs: number;
}

interface AllowedRoot {
  canonicalPath: string;
  archived: boolean;
}

export class PathPolicy {
  readonly diagnostics: DomainDiagnostic[] = [];
  readonly #roots: AllowedRoot[];

  private constructor(roots: AllowedRoot[]) {
    this.#roots = roots;
  }

  static async create(codexHome: string): Promise<PathPolicy> {
    const configured = [
      { path: resolve(codexHome, "sessions"), archived: false },
      { path: resolve(codexHome, "archived_sessions"), archived: true },
    ];
    const roots: AllowedRoot[] = [];
    const policy = new PathPolicy(roots);
    for (const root of configured) {
      try {
        const canonicalPath = await realpath(root.path);
        const info = await stat(canonicalPath);
        if (!info.isDirectory()) {
          throw Object.assign(new Error("Session root is not a directory"), { code: "ENOTDIR" });
        }
        roots.push({ canonicalPath, archived: root.archived });
      } catch (error) {
        if (!isExpectedIoError(error)) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          policy.unreadable("session_root_unreadable");
        }
        // An absent allowlisted root is normal for a new or unarchived Codex home.
      }
    }
    return policy;
  }

  unreadable(code: string): void {
    if (this.diagnostics.length >= 50) return;
    this.diagnostics.push({
      code,
      severity: "warning",
      message: "An allowlisted session directory or rollout could not be read.",
      ordinal: null,
    });
  }

  roots(): readonly Readonly<AllowedRoot>[] {
    return this.#roots;
  }

  async register(candidatePath: string): Promise<RolloutDescriptor | null> {
    if (!ROLLOUT_NAME.test(basename(candidatePath))) return null;

    try {
      const linkInfo = await lstat(candidatePath);
      if (linkInfo.isSymbolicLink()) return null;
      const canonicalPath = await realpath(candidatePath);
      const root = this.#roots.find((entry) => isWithin(entry.canonicalPath, canonicalPath));
      if (root === undefined) return null;
      const info = await stat(canonicalPath);
      if (!info.isFile()) return null;
      const relativePath = relative(root.canonicalPath, canonicalPath).split(sep).join("/");
      return {
        id: opaqueIdForPath(canonicalPath),
        canonicalPath,
        sourceRelativePath: `${root.archived ? "archived_sessions" : "sessions"}/${relativePath}`,
        archived: root.archived,
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    } catch (error) {
      if (!isExpectedIoError(error)) throw error;
      this.unreadable("rollout_unavailable");
      return null;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !child.startsWith(sep))
  );
}

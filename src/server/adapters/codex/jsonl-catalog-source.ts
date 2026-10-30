import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { DomainDiagnostic as Diagnostic } from "../../domain/session-domain.js";
import { opaqueIdForPath } from "../../security/opaque-id.js";
import type { CatalogDiscovery, CatalogEntry, CodexCatalogSource } from "./catalog-source.js";
import { isExpectedIoError } from "./io-errors.js";
import type { RolloutDescriptor } from "./rollout-descriptor.js";

const MAX_DEPTH = 8;
const ROLLOUT_NAME = /^rollout-[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/;

export class JsonlCatalogSource implements CodexCatalogSource {
  constructor(
    private readonly codexHome: string,
    private readonly archivedDescriptors: ReadonlyMap<string, RolloutDescriptor> = new Map(),
  ) {}

  async discover(): Promise<CatalogDiscovery> {
    const entries: CatalogEntry[] = [];
    const diagnostics: Diagnostic[] = [];
    const unreadable = (code: string) => {
      if (diagnostics.length < 50)
        diagnostics.push({
          code,
          severity: "warning",
          message: "A session directory or rollout could not be read.",
          ordinal: null,
        });
    };
    const scan = async (
      directory: string,
      relative: string,
      archived: boolean,
      depth: number,
    ): Promise<void> => {
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (!isExpectedIoError(error)) throw error;
        if (depth !== 0 || (error as NodeJS.ErrnoException).code !== "ENOENT")
          unreadable("session_root_unreadable");
        return;
      }
      for (const child of children) {
        const path = join(directory, child.name);
        const sourceRelativePath = `${relative}/${child.name}`;
        try {
          const linkedInfo = child.isSymbolicLink() ? await stat(path) : undefined;
          const info = linkedInfo ?? child;
          if (info.isDirectory()) {
            if (depth < MAX_DEPTH) await scan(path, sourceRelativePath, archived, depth + 1);
            continue;
          }
          if (!info.isFile() || !ROLLOUT_NAME.test(child.name)) continue;
          const cached = archived ? this.archivedDescriptors.get(path) : undefined;
          if (cached !== undefined) {
            entries.push({ descriptor: cached });
            continue;
          }
          const metadata = linkedInfo ?? (await stat(path));
          if (!metadata.isFile()) continue;
          entries.push({
            descriptor: {
              id: opaqueIdForPath(path),
              path,
              sourceRelativePath,
              archived,
              size: metadata.size,
              mtimeMs: metadata.mtimeMs,
            },
          });
        } catch (error) {
          if (!isExpectedIoError(error)) throw error;
          unreadable("rollout_unavailable");
        }
      }
    };
    for (const name of ["sessions", "archived_sessions"]) {
      await scan(resolve(this.codexHome, name), name, name === "archived_sessions", 0);
    }
    entries.sort((a, b) => a.descriptor.path.localeCompare(b.descriptor.path));
    return { entries, diagnostics };
  }
}

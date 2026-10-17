import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { DomainDiagnostic as Diagnostic } from "../../domain/session-domain.js";
import type { CatalogDiscovery, CatalogEntry, CodexCatalogSource } from "./catalog-source.js";
import { isExpectedIoError } from "./io-errors.js";
import type { PathPolicy, RolloutDescriptor } from "./path-policy.js";

export class JsonlCatalogSource implements CodexCatalogSource {
  constructor(private readonly policy: PathPolicy) {}

  async discover(): Promise<CatalogDiscovery> {
    const descriptors = new Map<string, RolloutDescriptor>();
    const diagnostics: Diagnostic[] = [];
    for (const root of this.policy.roots()) {
      await scan(
        root.canonicalPath,
        async (candidate) => {
          const descriptor = await this.policy.register(candidate);
          if (descriptor !== null) descriptors.set(descriptor.canonicalPath, descriptor);
        },
        diagnostics,
      );
    }
    const entries: CatalogEntry[] = [...descriptors.values()]
      .sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath))
      .map((descriptor) => ({ descriptor }));
    return {
      entries,
      diagnostics: [...this.policy.diagnostics, ...diagnostics].slice(0, 50),
    };
  }
}

async function scan(
  directory: string,
  visit: (path: string) => Promise<void>,
  diagnostics: Diagnostic[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (!isExpectedIoError(error)) throw error;
    if (diagnostics.length < 50)
      diagnostics.push({
        code: "session_root_unreadable",
        severity: "warning",
        message: "An allowlisted session directory could not be read.",
        ordinal: null,
      });
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path, visit, diagnostics);
    else if (entry.isFile() || entry.isSymbolicLink()) await visit(path);
  }
}

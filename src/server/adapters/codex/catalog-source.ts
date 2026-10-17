import type { DomainDiagnostic as Diagnostic } from "../../domain/session-domain.js";
import type { RolloutDescriptor } from "./path-policy.js";

export interface CatalogEntry {
  descriptor: RolloutDescriptor;
}

export interface CatalogDiscovery {
  entries: CatalogEntry[];
  diagnostics: Diagnostic[];
}

export interface CodexCatalogSource {
  discover(): Promise<CatalogDiscovery>;
}

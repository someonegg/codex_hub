import type { SubagentIdentity } from "../../domain/session-domain.js";

export function nonEmptySubagentIdentity(fields: SubagentIdentity): SubagentIdentity | null {
  return Object.values(fields).some((field) => field !== null) ? fields : null;
}

export function taskNameFromSubagentPath(agentPath: string | null): string | null {
  if (agentPath === null) return null;
  return agentPath.split("/").filter(Boolean).at(-1) ?? null;
}

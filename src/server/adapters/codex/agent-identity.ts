import type { DomainAgentIdentity as AgentIdentity } from "../../domain/session-domain.js";

export function nonEmptyAgentIdentity(fields: AgentIdentity): AgentIdentity | null {
  return Object.values(fields).some((field) => field !== null) ? fields : null;
}

export function taskNameFromAgentPath(agentPath: string | null): string | null {
  if (agentPath === null) return null;
  return agentPath.split("/").filter(Boolean).at(-1) ?? null;
}

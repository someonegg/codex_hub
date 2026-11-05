import { validProjectDirectory } from "../../domain/project-directory.js";
import type { DomainDiagnostic } from "../../domain/session-domain.js";
type ObjectValue = Record<string, unknown>;
const string = (value: unknown): string | null => (typeof value === "string" ? value : null);

export interface ClaudeIdentityState {
  readonly line: number;
  readonly nativeId: string;
  readonly firstCwd: string | null;
  readonly cwd: string | null;
  readonly project: string | null;
  readonly taskName: string | null;
  readonly customTitle: string | null;
  readonly aiTitle: string | null;
  readonly firstUser: string | null;
  readonly version: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly identityConflict: boolean;
}
/** Native identity and directory/version/time evidence is accumulated separately from content. */
export function appendClaudeIdentity(
  state: { -readonly [K in keyof ClaudeIdentityState]: ClaudeIdentityState[K] },
  row: ObjectValue,
  ordinal: number,
  retainDiagnostic: (diagnostic: DomainDiagnostic) => void,
): boolean {
  const identities = [string(row.sessionId), string(row.session_id)].filter(Boolean);
  if (identities.some((identity) => identity !== state.nativeId)) {
    state.identityConflict = true;
    retainDiagnostic({
      code: "conflicting_native_session_id",
      severity: "warning",
      message: "Claude record identity conflicts with its session file",
      ordinal: ordinal,
    });
    return false;
  }
  const timestamp = string(row.timestamp);
  if (timestamp && Number.isFinite(Date.parse(timestamp))) {
    state.createdAt ??= timestamp;
    state.updatedAt = timestamp;
  }
  if (validProjectDirectory(row.cwd)) {
    state.firstCwd ??= row.cwd;
    state.cwd = row.cwd;
  }
  state.version = string(row.version) ?? state.version;
  return true;
}

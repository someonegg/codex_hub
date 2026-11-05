export interface FileFingerprint {
  readonly sourceRelativePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}
export function fingerprintOf(value: FileFingerprint): FileFingerprint {
  return { sourceRelativePath: value.sourceRelativePath, size: value.size, mtimeMs: value.mtimeMs };
}
export function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return (
    left.sourceRelativePath === right.sourceRelativePath &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}
export interface RefreshTelemetry {
  fullFiles: number;
  appendFiles: number;
  probeBytes: number;
  decodeBytes: number;
  decodeMs: number;
  normalizeMs: number;
}
export function mutableTelemetry(): RefreshTelemetry {
  return {
    fullFiles: 0,
    appendFiles: 0,
    probeBytes: 0,
    decodeBytes: 0,
    decodeMs: 0,
    normalizeMs: 0,
  };
}

/** Accepted paths win; logical path order resolves initial and replacement ties. */
export function acceptedPathOrder(
  accepted: ReadonlyMap<string, unknown>,
  left: string,
  right: string,
): number {
  return Number(accepted.has(right)) - Number(accepted.has(left)) || left.localeCompare(right);
}

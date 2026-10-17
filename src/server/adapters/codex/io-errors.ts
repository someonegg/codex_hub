const EXPECTED_IO_ERRORS = new Set(["ENOENT", "EACCES", "EPERM", "ESTALE", "EISDIR", "ENOTDIR"]);

export function isExpectedIoError(error: unknown): boolean {
  return error instanceof Error && "code" in error && EXPECTED_IO_ERRORS.has(String(error.code));
}

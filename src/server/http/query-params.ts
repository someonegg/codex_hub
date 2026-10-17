export class HttpQueryError extends Error {}

export function optional(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) invalid(`${name} must appear once`);
  return values[0];
}

export function only(params: URLSearchParams, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  for (const name of params.keys()) {
    if (!accepted.has(name)) invalid(`${name} is not supported`);
  }
}

export function invalid(message: string): never {
  throw new HttpQueryError(message);
}

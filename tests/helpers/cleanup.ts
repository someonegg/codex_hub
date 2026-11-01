import { afterEach } from "vitest";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(runCleanups);

export async function runCleanups(): Promise<void> {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Test resource cleanup failed");
}

export function cleanupAfterEach(cleanup: () => void | Promise<void>): void {
  cleanups.push(cleanup);
}

export function closeAfterEach<T extends { close(): void }>(resource: T): T {
  cleanupAfterEach(() => resource.close());
  return resource;
}

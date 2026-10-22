import { afterEach } from "vitest";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export function cleanupAfterEach(cleanup: () => void | Promise<void>): void {
  cleanups.push(cleanup);
}

export function closeAfterEach<T extends { close(): void }>(resource: T): T {
  cleanupAfterEach(() => resource.close());
  return resource;
}

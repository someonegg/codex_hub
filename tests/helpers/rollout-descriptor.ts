import { JsonlCatalogSource } from "../../src/server/adapters/codex/jsonl-catalog-source.js";

export async function rolloutDescriptor(home: string, path: string) {
  const discovery = await new JsonlCatalogSource(home).discover();
  return discovery.entries.find((entry) => entry.descriptor.path === path)?.descriptor ?? null;
}

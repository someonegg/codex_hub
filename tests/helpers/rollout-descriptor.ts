import { JsonlCatalogSource } from "../../src/server/adapters/codex/jsonl-catalog-source.js";

export async function rolloutDescriptor(agent: string, path: string) {
  const discovery = await new JsonlCatalogSource(agent).discover();
  return discovery.entries.find((entry) => entry.descriptor.path === path)?.descriptor ?? null;
}

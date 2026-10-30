import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { JsonlCatalogSource } from "../../src/server/adapters/codex/jsonl-catalog-source.js";
import { CheckpointedRolloutDecoder } from "../../src/server/adapters/codex/rollout-decoder.js";
import { opaqueIdForPath } from "../../src/server/security/opaque-id.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

it("follows root, directory and file links outside the home using logical paths", async () => {
  const base = await createTempDirectory("catalog-links-");
  const home = join(base, "home");
  const outside = join(base, "outside");
  await mkdir(home);
  await mkdir(join(outside, "nested"), { recursive: true });
  await writeFile(join(outside, "nested/rollout-original.jsonl"), '{"type":"one"}\n');
  await writeFile(join(outside, "notes.jsonl"), "{}\n");
  await symlink(outside, join(home, "sessions"));
  await symlink(join(outside, "nested"), join(outside, "directory-link"));
  await symlink(
    join(outside, "nested/rollout-original.jsonl"),
    join(outside, "rollout-file-link.jsonl"),
  );
  const discovery = await new JsonlCatalogSource(home).discover();
  expect(discovery.diagnostics).toEqual([]);
  expect(discovery.entries.map(({ descriptor }) => descriptor.sourceRelativePath)).toEqual([
    "sessions/directory-link/rollout-original.jsonl",
    "sessions/nested/rollout-original.jsonl",
    "sessions/rollout-file-link.jsonl",
  ]);
  for (const { descriptor } of discovery.entries) {
    expect(descriptor.id).toBe(opaqueIdForPath(descriptor.path));
    expect(descriptor.path.startsWith(join(home, "sessions"))).toBe(true);
    expect((await new CheckpointedRolloutDecoder().decode(descriptor)).records).toHaveLength(1);
  }
});

it("reads files at depth eight without entering depth nine", async () => {
  const home = await createTempDirectory("catalog-depth-");
  const root = join(home, "sessions");
  const eighth = join(root, ...Array(8).fill("nested"));
  await mkdir(join(eighth, "ninth"), { recursive: true });
  await writeFile(join(eighth, "rollout-eight.jsonl"), "{}\n");
  await writeFile(join(eighth, "ninth/rollout-nine.jsonl"), "{}\n");
  const discovery = await new JsonlCatalogSource(home).discover();
  expect(discovery.entries.map(({ descriptor }) => descriptor.path)).toEqual([
    join(eighth, "rollout-eight.jsonl"),
  ]);
});

it("stops directory link cycles at the depth limit without real-path deduplication", async () => {
  const home = await createTempDirectory("catalog-cycle-");
  const root = join(home, "sessions");
  await mkdir(root);
  await writeFile(join(root, "rollout-cycle.jsonl"), "{}\n");
  await symlink(root, join(root, "loop"));
  const discovery = await new JsonlCatalogSource(home).discover();
  expect(discovery.entries).toHaveLength(9);
  expect(discovery.diagnostics).toEqual([]);
  expect(new Set(discovery.entries.map(({ descriptor }) => descriptor.id)).size).toBe(9);
});

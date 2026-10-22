import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

describe("server architecture boundaries", () => {
  it("keeps generic server modules independent from the Codex adapter", async () => {
    const serverDirectory = resolve("src/server");
    const files = (await typescriptFiles(serverDirectory)).filter((file) => {
      const serverRelativePath = relative(serverDirectory, file);
      return (
        !serverRelativePath.startsWith(`adapters${sep}`) && serverRelativePath !== "create-hub.ts"
      );
    });

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/(?:from\s+|import\s*\()["'][^"']*adapters\/codex/);
    }
  });

  it("keeps repository queries independent from API contracts and mapping", async () => {
    const repositoryFiles = await typescriptFiles(resolve("src/server/repository"));
    for (const file of repositoryFiles) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/shared\/api-contract|server\/api|SessionApiMapper/);
    }
  });

  it("keeps domain contracts independent from API and HTTP independent from tmux implementations", async () => {
    for (const file of await typescriptFiles(resolve("src/server/domain"))) {
      expect(await readFile(file, "utf8"), file).not.toMatch(/shared\/api-contract/);
    }
    for (const file of await typescriptFiles(resolve("src/server/http"))) {
      expect(await readFile(file, "utf8"), file).not.toMatch(
        /interaction\/tmux-(?:service|launcher)/,
      );
    }
  });
});

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return files.flat();
}

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const serverDirectory = resolve("src/server");
const codexDirectory = resolve(serverDirectory, "adapters/codex");
const apiDirectory = resolve(serverDirectory, "api");
const apiContract = resolve("src/shared/api-contract.js");
const tmuxImplementations = ["tmux-service", "tmux-launcher"].map((name) =>
  resolve(serverDirectory, `interaction/${name}.js`),
);

describe("server architecture boundaries", () => {
  it("keeps generic server modules independent from the Codex adapter", async () => {
    const files = (await typescriptFiles(serverDirectory)).filter((file) => {
      const serverRelativePath = relative(serverDirectory, file);
      return (
        !serverRelativePath.startsWith(`adapters${sep}`) && serverRelativePath !== "create-hub.ts"
      );
    });
    await assertIndependent(files, [codexDirectory]);
  });

  it("keeps repository queries independent from API contracts and mapping", async () => {
    await assertIndependent(await typescriptFiles(resolve(serverDirectory, "repository")), [
      apiContract,
      apiDirectory,
    ]);
  });

  it("keeps domain contracts independent from API and HTTP independent from tmux implementations", async () => {
    await assertIndependent(await typescriptFiles(resolve(serverDirectory, "domain")), [
      apiContract,
    ]);
    await assertIndependent(
      await typescriptFiles(resolve(serverDirectory, "http")),
      tmuxImplementations,
    );
  });

  it.each([
    'import "../adapters/codex/session-manager.js";',
    'const adapter = import( /* adapter */ "../adapters/codex/session-manager.js");',
    'type Manager = import("../adapters/codex/session-manager.js").CodexSessionManager;',
  ])("detects Codex dependency syntax: %s", (source) => {
    expect(
      forbiddenDependencies(resolve(serverDirectory, "application/example.ts"), source, [
        codexDirectory,
      ]),
    ).toEqual([resolve(codexDirectory, "session-manager.js")]);
  });

  it("resolves relative API paths without matching comments, strings or sibling directories", () => {
    const file = resolve(serverDirectory, "repository/example.ts");
    expect(
      forbiddenDependencies(file, 'import { map } from "../api/other-mapper.js";', [apiDirectory]),
    ).toEqual([resolve(apiDirectory, "other-mapper.js")]);
    expect(
      forbiddenDependencies(
        file,
        `
      // import "../api/other-mapper.js";
      const example = 'import "../api/other-mapper.js";';
      import "../api-extra/example.js";
    `,
        [apiDirectory],
      ),
    ).toEqual([]);
  });

  it("normalizes TypeScript extensions in API contract dependencies", () => {
    expect(
      forbiddenDependencies(
        resolve(serverDirectory, "repository/example.ts"),
        'import type { ApiError } from "../../shared/api-contract.ts";',
        [apiContract],
      ),
    ).toHaveLength(1);
  });
});

async function assertIndependent(files: string[], forbidden: string[]) {
  for (const file of files) {
    expect(forbiddenDependencies(file, await readFile(file, "utf8"), forbidden), file).toEqual([]);
  }
}

function forbiddenDependencies(file: string, source: string, forbidden: string[]): string[] {
  const dependencies: string[] = [];
  function visit(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    let target: unknown;
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
      case "ImportExpression":
        target = node.source;
        break;
      case "TSImportType":
        target = node.argument;
        break;
      case "TSExternalModuleReference":
        target = node.expression;
        break;
    }
    if (
      target !== null &&
      typeof target === "object" &&
      "value" in target &&
      typeof target.value === "string" &&
      target.value.startsWith(".")
    ) {
      const dependency = resolve(dirname(file), target.value);
      if (
        forbidden.some(
          (path) =>
            modulePath(dependency) === modulePath(path) || dependency.startsWith(path + sep),
        )
      ) {
        dependencies.push(dependency);
      }
    }
    Object.values(node).forEach(visit);
  }
  visit(
    parse(source, { sourceType: "module", plugins: ["typescript"], createImportExpressions: true })
      .program,
  );
  return dependencies;
}

function modulePath(path: string): string {
  return path.replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

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

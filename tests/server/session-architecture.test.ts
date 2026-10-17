import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { SessionApiMapper } from "../../src/server/api/session-api-mapper.js";
import type {
  DomainSession,
  DomainTimelineRecord,
  NormalizedSession,
} from "../../src/server/domain/session-domain.js";
import {
  CatalogSnapshotStore,
  MAX_CATALOG_DIAGNOSTICS,
} from "../../src/server/repository/catalog-snapshot-store.js";
import type { SessionSource, SourceSessionEntry } from "../../src/server/source/session-source.js";

const session: DomainSession = {
  id: "session-one",
  sourceId: "private-source-id",
  origin: {
    sourceType: "test",
    sourceInstanceId: "test-source",
    agentName: "Test Agent",
    agentVersion: "1.0.0",
    formatVersion: null,
  },
  title: "Session one",
  workingDirectory: "/project",
  projectDirectory: "/project",
  createdAt: "2026-07-28T00:00:00Z",
  updatedAt: "2026-07-28T01:00:00Z",
  archived: false,
  parentId: null,
  childIds: ["child"],
  agent: { taskName: "task", nickname: null, role: "worker" },
  messageCount: 1,
  toolCount: 0,
  warningCount: 1,
  diagnostics: [
    {
      code: "partial",
      severity: "warning",
      message: "Partial",
      ordinal: 2,
    },
  ],
  itemCount: 1,
};

const timeline: readonly DomainTimelineRecord[] = [
  {
    kind: "token",
    id: "token-1",
    ordinal: 1,
    timestamp: null,
    tokenUsage: {
      total: {
        totalTokens: 10,
        inputTokens: 8,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        outputTokens: 2,
        reasoningOutputTokens: null,
      },
      last: null,
    },
  },
];

const normalized: NormalizedSession = {
  session,
  timeline,
  toolDetails: new Map(),
  directiveDetails: new Map(),
  internalDetails: new Map(),
};

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

  it("maps compact catalog records and independent, immutable details", () => {
    const mapper = new SessionApiMapper();
    const catalog = mapper.list([session]);
    expect(catalog.sessions[0]).toEqual({
      id: session.id,
      title: session.title,
      projectId: expect.any(String),
      archived: false,
      parentId: null,
      isChild: false,
      updatedAt: session.updatedAt,
    });
    const detail = mapper.detail(session);
    detail.session.childIds.push("mutated");
    expect(detail.session).not.toHaveProperty("diagnostics");
    expect(detail.session).not.toHaveProperty("warningCount");
    expect(session.childIds).toEqual(["child"]);
    expect(session.diagnostics[0]!.message).toBe("Partial");
    expect(detail.session.origin).not.toBe(session.origin);
  });

  it("limits catalog diagnostics while preserving their order", async () => {
    const diagnostics = Array.from({ length: MAX_CATALOG_DIAGNOSTICS + 1 }, (_, index) => ({
      code: `catalog_warning_${index + 1}`,
      severity: "warning" as const,
      message: `Catalog warning ${index + 1}`,
      ordinal: null,
    }));
    const source = {
      ...testSource("catalog-diagnostics", []),
      async refresh() {
        return {
          signature: "catalog-diagnostics",
          sessions: [],
          diagnostics,
        };
      },
    };

    const snapshot = await new CatalogSnapshotStore([source]).current();

    expect(snapshot.diagnostics).toEqual(diagnostics.slice(0, MAX_CATALOG_DIAGNOSTICS));
  });

  it("retains readable sessions despite truncated diagnostics and duplicate local identities", async () => {
    const first = testSource("first", []);
    const healthy = testSource("healthy", [sourceEntry("one", null, "Healthy")]);
    const duplicate = sourceEntry("same", null, "Duplicate");
    const broken = testSource("broken", [duplicate, duplicate]);
    const noisy: SessionSource = {
      ...first,
      async refresh() {
        return {
          signature: "noisy",
          sessions: [],
          diagnostics: Array.from({ length: MAX_CATALOG_DIAGNOSTICS + 1 }, () => ({
            code: "unavailable",
            severity: "error" as const,
            message: "Unavailable",
            ordinal: null,
          })),
        };
      },
    };
    const log = vi.fn();
    const snapshot = await new CatalogSnapshotStore(
      [noisy, healthy, broken],
      undefined,
      undefined,
      { diagnosticLogger: { log } },
    ).current();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceInstanceId: broken.descriptor.sourceInstanceId,
        scope: "aggregate",
        code: "duplicate_source_session_id",
      }),
    );
    expect(snapshot.diagnostics).toHaveLength(MAX_CATALOG_DIAGNOSTICS);
    expect(snapshot.sessions.size).toBe(2);
  });

  it("rejects duplicate source instances and propagates source invariant failures", async () => {
    const source = {
      descriptor: {
        sourceType: "test",
        instanceKey: "test-source",
        sourceInstanceId: "test-source",
        displayName: "Test",
      },
      refresh: vi.fn(async () => {
        throw new Error("source invariant");
      }),
    };
    expect(() => new CatalogSnapshotStore([source, source])).toThrow(
      "Duplicate session source instance key",
    );
    await expect(new CatalogSnapshotStore([source]).current()).rejects.toThrow("source invariant");
  });

  it("namespaces source identities, links parents locally, and ignores source order", async () => {
    const sourceA = testSource("source-a", [
      sourceEntry("parent", null, "Source A parent"),
      sourceEntry("child-z", "parent", "Source A child Z"),
      sourceEntry("child-a", "parent", "Source A child A"),
    ]);
    const sourceAWithReorderedEntries = testSource("source-a", [
      sourceEntry("parent", null, "Source A parent"),
      sourceEntry("child-a", "parent", "Source A child A"),
      sourceEntry("child-z", "parent", "Source A child Z"),
    ]);
    const sourceB = testSource("source-b", [
      sourceEntry("parent", null, "Source B parent"),
      sourceEntry("child", "missing-in-source-b", "Source B child"),
    ]);
    const first = await new CatalogSnapshotStore([sourceA, sourceB]).current();
    const reordered = await new CatalogSnapshotStore([sourceB, sourceA]).current();
    const reorderedEntries = await new CatalogSnapshotStore([
      sourceAWithReorderedEntries,
      sourceB,
    ]).current();

    expect(first.signature).toBe(reordered.signature);
    expect(first.signature).toBe(reorderedEntries.signature);
    const mapper = new SessionApiMapper();
    expect(
      mapper.list([...first.sessions.values()].map((value) => value.normalized.session)),
    ).toEqual(
      mapper.list([...reordered.sessions.values()].map((value) => value.normalized.session)),
    );
    expect([...first.sessions.keys()].sort()).toEqual([...reordered.sessions.keys()].sort());
    const byTitle = new Map(
      [...first.sessions.values()].map(({ normalized: value }) => [
        value.session.title,
        value.session,
      ]),
    );
    expect(byTitle.get("Source A parent")?.id).not.toBe(byTitle.get("Source B parent")?.id);
    expect(byTitle.get("Source A child A")?.parentId).toBe(byTitle.get("Source A parent")?.id);
    expect(byTitle.get("Source A child Z")?.parentId).toBe(byTitle.get("Source A parent")?.id);
    expect(byTitle.get("Source B child")?.parentId).toBeNull();
    const parent = byTitle.get("Source A parent")!;
    expect(parent.childIds).toEqual([...parent.childIds].sort());
    expect(parent.childIds).toEqual(
      [...reorderedEntries.sessions.values()].find(
        ({ normalized: value }) => value.session.title === "Source A parent",
      )!.normalized.session.childIds,
    );
  });

  it("uses session ID as the final tie-breaker across source registration order", async () => {
    const sourceA = testSource("tie-a", [sourceEntry("same", null, "Tie")]);
    const sourceB = testSource("tie-b", [sourceEntry("same", null, "Tie")]);
    const first = await new CatalogSnapshotStore([sourceA, sourceB]).current();
    const reversed = await new CatalogSnapshotStore([sourceB, sourceA]).current();

    const mapper = new SessionApiMapper();
    const firstResult = mapper.list(
      [...first.sessions.values()].map((value) => value.normalized.session),
    );
    const reversedResult = mapper.list(
      [...reversed.sessions.values()].map((value) => value.normalized.session),
    );
    expect(firstResult.sessions.map(({ id }) => id)).toEqual(
      reversedResult.sessions.map(({ id }) => id),
    );
    expect(firstResult.revision).toBe(reversedResult.revision);
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

function sourceEntry(
  nativeSessionId: string,
  parentNativeSessionId: string | null,
  title: string,
): SourceSessionEntry {
  const origin = {
    sourceType: "test",
    sourceInstanceId: "replaced-by-source",
    agentName: "Test",
    agentVersion: null,
    formatVersion: null,
  };
  return {
    localId: nativeSessionId,
    nativeSessionId,
    parentNativeSessionId,
    origin,
    normalized: {
      ...normalized,
      session: {
        ...normalized.session,
        id: nativeSessionId,
        sourceId: nativeSessionId,
        origin,
        title,
        parentId: parentNativeSessionId,
        childIds: [],
      },
    },
  };
}

function testSource(instanceKey: string, sessions: readonly SourceSessionEntry[]): SessionSource {
  return {
    descriptor: {
      sourceType: "test",
      instanceKey,
      sourceInstanceId: instanceKey,
      displayName: "Test",
    },
    async refresh() {
      return { signature: "stable", sessions, diagnostics: [] };
    },
  };
}

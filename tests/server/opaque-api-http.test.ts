import { cp, readFile, rename, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { SessionReadService } from "../../src/server/application/session-read-service.js";
import {
  CatalogCapacityError,
  SessionCatalogService,
} from "../../src/server/catalog/session-catalog-service.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import { startHttpServer } from "../helpers/http-server.js";
import { createTempDirectory } from "../helpers/temp-directories.js";
import { createCodexSessionReadService } from "./codex-read-helper.js";
import { normalizeFixture } from "./session-normalizer.fixtures.js";

async function startApi(existingHome?: string, override?: SessionReadService) {
  const home = existingHome ?? (await createTempDirectory("codex-opaque-api-"));
  if (existingHome === undefined) {
    await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
  }
  const repository = override ?? (await createCodexSessionReadService(home));

  const updates = new SessionUpdatesService(repository, {
    probeIntervalMs: 5,
    waitTimeoutMs: 15,
  });
  const catalog = new SessionCatalogService(repository);
  const { base } = await startHttpServer(
    createApiRouter({ sessions: repository, catalog, updates }),
    () => {
      catalog.close();
      updates.close();
    },
  );
  return { base, home, repository };
}

describe("opaque cursor API", () => {
  it("preserves read query errors and accepts a normal item request", async () => {
    const { base } = await startApi();
    const list = await fetch(`${base}/api/v1/sessions`).then((response) => response.json());
    const id = list.sessions[0].id;
    const cases = [
      ["?unknown=x", "unknown is not supported"],
      ["?after=x&after=y", "after must appear once"],
      [`/${id}/items?limit=1&limit=2`, "limit must appear once"],
      [`/${id}/items/item/tool`, "cursor is required for tool detail"],
      [`/${id}/items/item/internal`, "cursor is required for internal detail"],
      [`/${id}/items/item/directive`, "cursor is required for directive detail"],
    ];
    for (const [suffix, message] of cases) {
      const response = await fetch(`${base}/api/v1/sessions${suffix}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_query", message } });
    }
    expect((await fetch(`${base}/api/v1/sessions/${id}/items?limit=1`)).status).toBe(200);
  });

  it("serves internal JSON only from its cursor-bound detail endpoint", async () => {
    const { base } = await startApi();
    const list = await fetch(`${base}/api/v1/sessions`).then((response) => response.json());
    const sessionId = list.sessions.find(
      (session: { title: string }) => session.title === "Synthetic trace",
    ).id;
    const page = await fetch(`${base}/api/v1/sessions/${sessionId}/items?limit=300`).then(
      (response) => response.json(),
    );
    expect(JSON.stringify(page)).not.toContain("REASONING_CANARY_NEVER_RENDER");

    const detail = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items/internal-6/internal?cursor=${encodeURIComponent(page.cursor)}`,
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual({
      json: expect.stringContaining("REASONING_CANARY_NEVER_RENDER"),
      truncated: false,
    });
    const toolDetail = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items/tool-8/tool?cursor=${encodeURIComponent(page.cursor)}`,
    );
    expect(toolDetail.status).toBe(200);
    expect(await toolDetail.json()).toEqual({
      input: '{"id":"sample"}',
      output: "synthetic result",
      truncated: false,
    });
    const wrongKind = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items/directive-4/internal?cursor=${encodeURIComponent(page.cursor)}`,
    );
    expect(wrongKind.status).toBe(404);
    expect(await wrongKind.json()).toMatchObject({ error: { code: "internal_not_found" } });
  });

  it("classifies structurally valid cursors from another service instance as recoverable", async () => {
    const firstServer = await startApi();
    const list = await fetch(`${firstServer.base}/api/v1/sessions`).then((response) =>
      response.json(),
    );
    const sessionId = list.sessions[0].id;
    const page = await fetch(`${firstServer.base}/api/v1/sessions/${sessionId}/items?limit=1`).then(
      (response) => response.json(),
    );
    const confirmed = await fetch(
      `${firstServer.base}/api/v1/sessions/${sessionId}/items?limit=300`,
    ).then((response) => response.json());

    const restarted = await startApi(firstServer.home);
    const staleTimeline = await fetch(
      `${restarted.base}/api/v1/sessions/${sessionId}/items?cursor=${encodeURIComponent(page.cursor)}`,
    );
    expect(staleTimeline.status).toBe(409);
    expect(await staleTimeline.json()).toMatchObject({
      error: { code: "timeline_changed" },
    });
    const staleDetail = await fetch(
      `${restarted.base}/api/v1/sessions/${sessionId}/items/directive-4/directive?cursor=${encodeURIComponent(confirmed.cursor)}`,
    );
    expect(staleDetail.status).toBe(409);
    expect(await staleDetail.json()).toMatchObject({
      error: { code: "timeline_changed" },
    });

    expect((await fetch(`${restarted.base}/api/v1/sessions?cursor=not-a-cursor`)).status).toBe(400);
    expect(
      (await fetch(`${restarted.base}/api/v1/sessions/${sessionId}/items?cursor=not-a-cursor`))
        .status,
    ).toBe(400);
  });

  it("returns the full compact catalog and rejects old pagination and filters", async () => {
    const { base } = await startApi();
    const head = await fetch(`${base}/api/v1/sessions`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const first = await fetch(`${base}/api/v1/sessions`).then((response) => response.json());
    expect(first.sessions).toHaveLength(4);
    expect(Object.keys(first).sort()).toEqual(["homes", "projects", "revision", "sessions"]);
    expect(Object.keys(first.sessions[0]).sort()).toEqual([
      "home",
      "id",
      "isChild",
      "parentId",
      "projectDirectory",
      "status",
      "title",
      "updatedAt",
    ]);
    for (const query of [
      "limit=1",
      "cursor=x",
      "fresh=true",
      "project=x",
      "from=x",
      "to=x",
      "mainOnly=true",
      "after=x",
      `after=${first.revision}&after=${first.revision}`,
    ]) {
      expect((await fetch(`${base}/api/v1/sessions?${query}`)).status).toBe(400);
    }
    const changed = await fetch(`${base}/api/v1/sessions?after=${"z".repeat(43)}`);
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual(first);
  });

  it("reports directory capacity with a retry hint and connects disconnect cleanup", async () => {
    const { base } = await startApi();
    const wait = vi
      .spyOn(SessionCatalogService.prototype, "wait")
      .mockRejectedValueOnce(new CatalogCapacityError("Retry shortly"));
    const full = await fetch(`${base}/api/v1/sessions`);
    expect(full.status).toBe(429);
    expect(full.headers.get("retry-after")).toBe("2");
    expect(await full.json()).toMatchObject({ error: { code: "catalog_capacity_exceeded" } });
    let connected!: () => void;
    const connection = new Promise<void>((resolve) => {
      connected = resolve;
    });
    let disconnected!: () => void;
    const disconnection = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    wait.mockImplementationOnce(
      async (_after, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => {
              disconnected();
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
          connected();
        }),
    );
    const controller = new AbortController();
    const pending = fetch(`${base}/api/v1/sessions`, { signal: controller.signal });
    const aborted = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await connection;
    controller.abort();
    await aborted;
    await disconnection;
  });

  it("opens through items, keeps an empty incremental cursor stable, and bounds lazy detail", async () => {
    const { base, home } = await startApi();
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ id: "basic-session", thread_name: "Current nickname" })}\n`,
    );
    const list = await fetch(`${base}/api/v1/sessions`).then((response) => response.json());
    const sessionId = list.sessions.find(
      (session: { title: string }) => session.title === "Current nickname",
    ).id;
    expect(list.sessions.find((session: { id: string }) => session.id === sessionId)).toMatchObject(
      { title: "Current nickname" },
    );

    const metadata = await fetch(`${base}/api/v1/sessions/${sessionId}`).then((response) =>
      response.json(),
    );
    expect(metadata).toEqual({
      session: expect.objectContaining({ title: "Current nickname" }),
      interaction: { supported: false, attachCommand: null },
      updateRevision: expect.any(String),
    });

    const first = await fetch(`${base}/api/v1/sessions/${sessionId}/items?limit=1`).then(
      (response) => response.json(),
    );
    expect(first).toEqual({
      session: expect.objectContaining({
        title: "Current nickname",
      }),
      interaction: { supported: false, attachCommand: null },
      items: expect.any(Array),
      cursor: expect.any(String),
      hasMore: true,
      updateRevision: expect.any(String),
    });
    const unconfirmed = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items/directive-4/directive?cursor=${encodeURIComponent(first.cursor)}`,
    );
    expect(unconfirmed.status).toBe(400);

    const rest = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items?limit=300&cursor=${encodeURIComponent(first.cursor)}`,
    ).then((response) => response.json());
    const tail = rest.hasMore
      ? await fetch(
          `${base}/api/v1/sessions/${sessionId}/items?limit=300&cursor=${encodeURIComponent(rest.cursor)}`,
        ).then((response) => response.json())
      : rest;
    const empty = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items?cursor=${encodeURIComponent(tail.cursor)}`,
    ).then((response) => response.json());
    expect(empty.items).toEqual([]);
    expect(empty.cursor).toBe(tail.cursor);

    const detail = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items/directive-4/directive?cursor=${encodeURIComponent(tail.cursor)}`,
    ).then((response) => response.json());
    expect(detail).toEqual({
      text: expect.stringContaining("DIRECTIVE_DETAIL_CANARY"),
      truncated: false,
    });
  });

  it("long-polls without advancing the timeline cursor and detects appended backlog", async () => {
    const { base, home, repository } = await startApi();
    const list = await fetch(`${base}/api/v1/sessions`).then((response) => response.json());
    const sessionId = list.sessions.find(
      (session: { title: string }) => session.title === "Synthetic trace",
    ).id;
    const page = await fetch(`${base}/api/v1/sessions/${sessionId}/items?limit=300`).then(
      (response) => response.json(),
    );
    const query = `cursor=${encodeURIComponent(page.cursor)}&after=${encodeURIComponent(page.updateRevision)}`;

    const unchanged = await fetch(`${base}/api/v1/sessions/${sessionId}/updates?${query}`);
    expect(unchanged.status).toBe(204);
    expect(unchanged.headers.get("cache-control")).toBe("no-store");

    const rollout = join(
      home,
      "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl",
    );
    await writeFile(
      rollout,
      `${await readFile(rollout, "utf8")}{"timestamp":"2026-08-01T00:00:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"updates append"}]}}\n`,
    );
    await repository.refresh();
    const changed = await fetch(`${base}/api/v1/sessions/${sessionId}/updates?${query}`);
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual(
      expect.objectContaining({
        cursor: page.cursor,
        hasMore: true,
        updateRevision: expect.not.stringMatching(page.updateRevision),
      }),
    );

    expect(
      (
        await fetch(
          `${base}/api/v1/sessions/${sessionId}/updates?cursor=bad&after=${"a".repeat(43)}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          `${base}/api/v1/sessions/${sessionId}/updates?cursor=${encodeURIComponent(page.cursor)}&after=bad`,
        )
      ).status,
    ).toBe(400);
  });

  it("accepts append-only continuation and reports timeline_changed after replacement", async () => {
    const { base, home, repository } = await startApi();
    const list = await fetch(`${base}/api/v1/sessions`).then((response) => response.json());
    const sessionId = list.sessions.find(
      (session: { title: string }) => session.title === "Synthetic trace",
    ).id;
    const page = await fetch(`${base}/api/v1/sessions/${sessionId}/items?limit=2`).then(
      (response) => response.json(),
    );
    const rollout = join(
      home,
      "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl",
    );
    await writeFile(
      rollout,
      `${await readFile(rollout, "utf8")}{"timestamp":"2026-08-01T00:00:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"append"}]}}\n`,
    );
    await repository.refresh();
    expect(
      (
        await fetch(
          `${base}/api/v1/sessions/${sessionId}/items?limit=2&cursor=${encodeURIComponent(page.cursor)}`,
        )
      ).status,
    ).toBe(200);

    const replacement = `${rollout}.replacement`;
    await writeFile(
      replacement,
      '{"timestamp":"2026-08-01T01:00:00Z","type":"session_meta","payload":{"id":"basic-session","title":"Replacement"}}\n' +
        '{"timestamp":"2026-08-01T01:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"replacement"}]}}\n',
    );
    await rename(replacement, rollout);
    await repository.refresh();
    const changed = await fetch(
      `${base}/api/v1/sessions/${sessionId}/items?cursor=${encodeURIComponent(page.cursor)}`,
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: "timeline_changed" } });
    const updatesChanged = await fetch(
      `${base}/api/v1/sessions/${sessionId}/updates?cursor=${encodeURIComponent(page.cursor)}&after=${encodeURIComponent(page.updateRevision)}`,
    );
    expect(updatesChanged.status).toBe(409);
    expect(await updatesChanged.json()).toMatchObject({ error: { code: "timeline_changed" } });
  });
});

it("accepts opaque Unicode, UUID and percent-containing item IDs with one decoding pass", async () => {
  const original = await normalizeFixture("rollout-2026-07-28T10-00-00-basic-session.jsonl");
  const ids = new Map(
    original.timeline.map((item, index) => [
      item.id,
      item.kind === "tool"
        ? `550e8400-e29b-41d4-a716-446655440000:${index}`
        : item.kind === "directive"
          ? `条目:α-${index}`
          : `literal%2Fid-${index}`,
    ]),
  );
  const normalized = {
    ...original,
    timeline: original.timeline.map((item) => ({ ...item, id: ids.get(item.id)! })),
    toolDetails: new Map([...original.toolDetails].map(([id, detail]) => [ids.get(id)!, detail])),
    directiveDetails: new Map(
      [...original.directiveDetails].map(([id, detail]) => [ids.get(id)!, detail]),
    ),
    internalDetails: new Map(
      [...original.internalDetails].map(([id, detail]) => [ids.get(id)!, detail]),
    ),
  };
  const source = {
    descriptor: {
      sourceType: "test",
      instanceKey: "ids",
      home: "ids",
      displayName: "Test",
    },
    async refresh() {
      return {
        signature: "1",
        diagnostics: [],
        sessions: [
          {
            localId: "one",
            nativeSessionId: "native",
            parentNativeSessionId: null,
            origin: original.session.origin,
            normalized,
          },
        ],
      };
    },
  };
  const reader = new SessionReadService([source], {
    diagnosticLogger: { log() {} },
  });
  const { base } = await startApi(undefined, reader);
  const sessionId = (await reader.list()).sessions[0]!.id;
  const page = (await reader.getItems(sessionId, { limit: 300 }))!;
  const root = `/api/v1/sessions/${sessionId}/items/`;
  const suffix = `?cursor=${encodeURIComponent(page.cursor)}`;
  for (const kind of ["tool", "directive", "internal"] as const) {
    const item = normalized.timeline.find(
      (item) =>
        item.kind === kind &&
        (kind === "tool"
          ? normalized.toolDetails
          : kind === "directive"
            ? normalized.directiveDetails
            : normalized.internalDetails
        ).has(item.id),
    )!;
    const result = await fetch(`${base}${root}${encodeURIComponent(item.id)}/${kind}${suffix}`);
    expect(result.status).toBe(200);
    const wrongKind = kind === "tool" ? "directive" : "tool";
    expect(
      (await fetch(`${base}${root}${encodeURIComponent(item.id)}/${wrongKind}${suffix}`)).status,
    ).toBe(404);
  }
  for (const itemId of ["550e8400-e29b-41d4-a716-446655440000", "plainABC-12", "α".repeat(512)]) {
    expect((await fetch(`${base}${root}${encodeURIComponent(itemId)}/tool${suffix}`)).status).toBe(
      404,
    );
  }
  // Send the raw request path so URL implementations cannot normalize dot segments first.
  const rawStatus = (itemId: string) =>
    new Promise<number>((resolveStatus, reject) => {
      const address = new URL(base);
      const outgoing = request(
        { hostname: address.hostname, port: address.port, path: `${root}${itemId}/tool${suffix}` },
        (response) => {
          response.resume();
          resolveStatus(response.statusCode!);
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
  for (const itemId of [
    "",
    "%",
    "%FF",
    "%2F",
    "%5C",
    "%00",
    "%C2%85",
    ".",
    "..",
    "%2e",
    "%2E%2e",
    encodeURIComponent("α".repeat(513)),
  ]) {
    expect(await rawStatus(itemId), itemId).toBe(400);
  }
});

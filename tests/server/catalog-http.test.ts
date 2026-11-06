import { describe, expect, it, vi } from "vitest";

import {
  CatalogCapacityError,
  SessionCatalogService,
} from "../../src/server/catalog/session-catalog-service.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import { startHttpServer } from "../helpers/http-server.js";
import { createTempDirectory } from "../helpers/temp-directories.js";
import { createCodexSessionReadService } from "./codex-read-helper.js";

async function startApi() {
  const agent = await createTempDirectory("catalog-http-");
  const repository = await createCodexSessionReadService(agent);

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
  return { base };
}

describe("catalog HTTP capacity", () => {
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
});

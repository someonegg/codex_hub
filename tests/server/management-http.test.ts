import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { SessionCatalogService } from "../../src/server/catalog/session-catalog-service.js";
import { createCodexSessionReadService } from "../../src/server/create-hub.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { createServer } from "../../src/server/http/create-server.js";
import { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import { TmuxInteractionService } from "../../src/server/interaction/tmux-service.js";
import { OperationService } from "../../src/server/management/operation-service.js";
import { SessionManagerRegistry } from "../../src/server/management/session-manager.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
it("accepts asynchronous writes, deduplicates, keeps reads routed, and retrieves operations after a page reload", async () => {
  const home = await createTempDirectory("management-http-");
  await mkdir(join(home, "client"));
  await writeFile(join(home, "client/index.html"), "hub");
  const sessions = await createCodexSessionReadService(home);
  const interaction = new SessionInteractionService(sessions, true, new TmuxInteractionService());
  const manager = {
    resolveDirectory: vi.fn(async () => ({ directory: home, project: home })),
    launch: vi.fn(async () => ({ socketPath: "/tmp/test", paneId: "%1" })),
    exitSteps: () => [{ keys: ["C-c"] as const, delayMs: 0 }],
    archive: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  let now = 0;
  const operations = new OperationService(
    sessions,
    interaction,
    new SessionManagerRegistry("test").register("test", manager),
    () => now,
  );
  const catalogService = new SessionCatalogService(sessions);
  const updates = new SessionUpdatesService(sessions, { interaction });
  const server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      homes: [{ nickname: "default", path: home }],
      clientDirectory: join(home, "client"),
      tls: { enabled: false },
      interactionEnabled: true,
    },
    createApiRouter({ sessions, catalog: catalogService, interaction, operations, updates }),
    () => {
      catalogService.close();
      updates.close();
      operations.close();
    },
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const body = { directory: home, worktree: false, requestId: "http-request-one" };
  const post = (path: string, value: unknown, extra: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
      ...extra,
    });
  const invalidBodies = [
    { body: "{}", contentType: "text/plain", status: 400, code: "invalid_json" },
    { body: "{", status: 400, code: "invalid_json" },
    { body: "[]", status: 400, code: "invalid_json" },
    { body: "null", status: 400, code: "invalid_json" },
    { body: "{}", status: 400, code: "invalid_json" },
    {
      body: '{"message":123,"directory":123,"worktree":"false","requestId":123}',
      status: 400,
      code: "invalid_json",
    },
    {
      body: JSON.stringify({ ...body, message: "hello", extra: true }),
      status: 400,
      code: "invalid_json",
    },
    { body: JSON.stringify({ message: "x".repeat(500_000) }), status: 413, code: "body_too_large" },
  ];
  for (const path of [
    "/sessions",
    "/sessions/abcdefghijklmnopqrstuvwxyz/messages",
    "/sessions/abcdefghijklmnopqrstuvwxyz/exit",
  ]) {
    for (const value of invalidBodies) {
      if (path.endsWith("/exit") && value.body === "{}" && value.contentType === undefined)
        continue;
      const response = await post(
        path,
        {},
        { body: value.body, headers: { "Content-Type": value.contentType ?? "application/json" } },
      );
      expect(response.status, `${path}: ${value.body.slice(0, 50)}`).toBe(value.status);
      expect(await response.json()).toMatchObject({ error: { code: value.code } });
    }
  }
  const nonempty = await post("/sessions/abcdefghijklmnopqrstuvwxyz/archive", { extra: true });
  expect(await nonempty.json()).toMatchObject({ error: { code: "invalid_json" } });
  const exitPath = "/sessions/abcdefghijklmnopqrstuvwxyz/exit";
  expect((await post(exitPath, { extra: true })).status).toBe(400);
  expect(
    (
      await post(
        exitPath,
        {},
        { headers: { Origin: "https://other.invalid", "Content-Type": "application/json" } },
      )
    ).status,
  ).toBe(403);
  const exitResponse = await post(exitPath, {});
  expect(exitResponse.status).toBe(202);
  const exitOperation = await exitResponse.json();
  expect(exitOperation).toMatchObject({ type: "exit", sessionId: "abcdefghijklmnopqrstuvwxyz" });
  await vi.waitFor(async () => {
    expect(
      await (await fetch(`${base}/operations/${exitOperation.operationId}`)).json(),
    ).toMatchObject({ type: "exit", status: "failed", error: "Session not found" });
  });
  const resumeBody = {
    resumeSessionId: "abcdefghijklmnopqrstuvwxyz",
    requestId: "resume-http-request",
    yolo: false,
  };
  for (const extra of [
    { directory: home },
    { sourceInstanceId: "test" },
    { worktree: false },
    { yolo: "true" },
    { resumeSessionId: "" },
  ]) {
    expect((await post("/sessions", { ...resumeBody, ...extra })).status).toBe(400);
  }
  const resumeResponse = await post("/sessions", resumeBody);
  expect(resumeResponse.status).toBe(202);
  const resumeOp = await resumeResponse.json();
  expect(resumeOp).toMatchObject({
    type: "create",
    mode: "resume",
    sessionId: resumeBody.resumeSessionId,
  });
  expect(await (await post("/sessions", resumeBody)).json()).toMatchObject({
    operationId: resumeOp.operationId,
  });
  expect((await post("/sessions", { ...resumeBody, yolo: true })).status).toBe(409);
  const created = await post("/sessions", body);
  expect(created.status).toBe(202);
  const operation = await created.json();
  expect(operation).toMatchObject({ type: "create", status: "pending", sessionId: null });
  expect(await (await post("/sessions", body)).json()).toMatchObject({
    operationId: operation.operationId,
  });
  expect((await post("/sessions", { ...body, worktree: true })).status).toBe(409);
  const retrieved = await fetch(`${base}/operations/${operation.operationId}`);
  expect(retrieved.status).toBe(200);
  expect(await retrieved.json()).toMatchObject({ operationId: operation.operationId });
  expect((await fetch(`${base}/operations/missing`)).status).toBe(404);
  const catalog = await fetch(`${base}/sessions`);
  expect(catalog.status).toBe(200);
  expect(await catalog.json()).toMatchObject({ sessions: [] });
  expect(manager.launch).toHaveBeenCalledOnce();
  now = 300_000;
  await operations.poll();
  const repeated = await post("/sessions", body);
  expect(repeated.status).toBe(202);
  expect(await repeated.json()).toMatchObject({
    operationId: operation.operationId,
    status: "unknown",
  });
  expect((await post("/sessions", { ...body, worktree: true })).status).toBe(409);
  expect(manager.launch).toHaveBeenCalledOnce();
  expect((await post("/sessions", { ...body, requestId: "http-request-two" })).status).toBe(202);
  expect(manager.launch).toHaveBeenCalledTimes(2);
  const id = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
  expect((await post(`/sessions/${id}/archive`, {})).status).toBe(202);
  expect((await post(`/sessions/${id}other`, {}, { method: "DELETE" })).status).toBe(202);
  expect((await post(`/sessions/${id}/archive`, { requestId: "obsolete" })).status).toBe(400);
  expect(
    (
      await post("/sessions", body, {
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      })
    ).status,
  ).toBe(403);
  expect((await post("/sessions", { directory: home, requestId: "bad-request" })).status).toBe(400);
});

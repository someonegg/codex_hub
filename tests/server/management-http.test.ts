import { expect, it, vi } from "vitest";

import { SessionCatalogService } from "../../src/server/catalog/session-catalog-service.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import { paneBindings } from "../../src/server/interaction/pane-binding-manager.js";
import { TmuxInteractionService } from "../../src/server/interaction/tmux-service.js";
import { OperationService } from "../../src/server/management/operation-service.js";
import { SessionManagerRegistry } from "../../src/server/management/session-manager.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import { MAX_INTERACTION_MESSAGE_BYTES } from "../../src/shared/interaction.js";
import { startHttpServer } from "../helpers/http-server.js";
import { createTempDirectory } from "../helpers/temp-directories.js";
import { createTestPreviewListener } from "../helpers/terminal-listener.js";
import { createCodexSessionReadService } from "./codex-read-helper.js";

it("accepts asynchronous writes, deduplicates, keeps reads routed, and retrieves operations after a page reload", async () => {
  const home = await createTempDirectory("management-http-");
  const sessions = await createCodexSessionReadService(home);
  const interaction = new SessionInteractionService(sessions, new TmuxInteractionService(), {
    enabled: true,
    bindings: paneBindings,
    listener: createTestPreviewListener(),
  });
  const manager = {
    isValidNativeId: vi.fn((_nativeId: string) => true),
    resolveDirectory: vi.fn(async (directory: string) => ({ directory })),
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
    { now: () => now },
  );
  const catalogService = new SessionCatalogService(sessions);
  const updates = new SessionUpdatesService(sessions, { interaction });
  const { base: origin } = await startHttpServer(
    createApiRouter({ sessions, catalog: catalogService, interaction, operations, updates }),
    () => {
      catalogService.close();
      updates.close();
      operations.close();
      interaction.close();
    },
  );
  const base = `${origin}/api/v1`;
  const body = { projectDirectory: home, worktree: false, requestId: "http-request-one" };
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
    {
      body: JSON.stringify({ message: "x".repeat(MAX_INTERACTION_MESSAGE_BYTES * 8) }),
      status: 413,
      code: "body_too_large",
    },
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
    { projectDirectory: home },
    { workingDirectory: home },
    { home: "test" },
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
  for (const workingDirectory of [null, 123, false]) {
    expect((await post("/sessions", { ...body, workingDirectory })).status).toBe(400);
  }
  const created = await post("/sessions", body);
  expect(created.status).toBe(202);
  const operation = await created.json();
  expect(operation).toMatchObject({ type: "create", status: "pending", sessionId: null });
  expect(await (await post("/sessions", body)).json()).toMatchObject({
    operationId: operation.operationId,
  });
  expect(await (await post("/sessions", { ...body, workingDirectory: home })).json()).toMatchObject(
    { operationId: operation.operationId },
  );
  expect((await post("/sessions", { ...body, workingDirectory: "/other" })).status).toBe(409);
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
  const split = await post("/sessions", {
    ...body,
    workingDirectory: "/other",
    requestId: "http-split-directory",
  });
  expect(split.status).toBe(202);
  await vi.waitFor(() =>
    expect(manager.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectDirectory: home, workingDirectory: "/other" }),
    ),
  );
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
  expect(
    (await post("/sessions", { projectDirectory: home, requestId: "bad-request" })).status,
  ).toBe(400);
});

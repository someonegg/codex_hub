import { setImmediate as settlePromises } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DomainSession } from "../../src/server/domain/session-domain.js";
import type { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import { PaneBindingManager } from "../../src/server/interaction/pane-binding-manager.js";
import { SessionRuntime } from "../../src/server/interaction/session-runtime.js";
import type { InteractionTransport } from "../../src/server/interaction/transport.js";
import { OperationService } from "../../src/server/management/operation-service.js";
import type { ManagementSnapshot } from "../../src/server/management/session-manager.js";
import {
  SessionLaunchError,
  SessionManagerRegistry,
} from "../../src/server/management/session-manager.js";
import type { UploadCleanup } from "../../src/server/uploads/store.js";

const target = { socketPath: "/tmp/test.sock", paneId: "%1" };
const services: OperationService[] = [];
let bindings = new PaneBindingManager();
afterEach(() => services.splice(0).forEach((service) => service.close()));
const flush = () => settlePromises();
function session(id = "session", operationId?: string): DomainSession {
  if (operationId)
    bindings.submit({
      sessionId: id,
      time: 0,
      ordinal: 1,
      position: 0,
      attempt: { ordinal: 1, valid: true, ...target, operationId },
    });
  return {
    id,
    sourceId: "00000000-0000-4000-8000-000000000001",
    title: "Test",
    archived: false,
    projectDirectory: "/project",
    workingDirectory: "/project",
    createdAt: null,
    updatedAt: null,
    parentId: null,
    childIds: [],
    agent: null,
    messageCount: 0,
    toolCount: 0,
    warningCount: 0,
    itemCount: 0,
    diagnostics: [],
    origin: {
      sourceType: "codex-jsonl",
      home: "test",
      agentName: "Codex",
      agentVersion: null,
      formatVersion: null,
    },
  };
}
function managementSnapshot(value: Pick<ManagementSnapshot, "sessions">): ManagementSnapshot {
  return { ...value, byId: new Map(value.sessions.map((session) => [session.id, session])) };
}
function setup(managementWaitMs = 30, uploads?: UploadCleanup) {
  bindings = new PaneBindingManager();
  let snapshot = managementSnapshot({ sessions: [] });
  let now = 0;
  const reader = { managementSnapshot: vi.fn(async () => snapshot) };
  const interaction = {
    setBusy: vi.fn(),
    resolveTarget: vi.fn(async () => null as typeof target | null),
    killTarget: vi.fn(async () => undefined),
    sendExitKeys: vi.fn<SessionInteractionService["sendExitKeys"]>(async () => undefined),
    inspectTarget: vi.fn(async () => "exited" as "exited" | "alive"),
    matchesTarget: vi.fn(async () => true),
    describe: vi.fn(async () => ({
      supported: true as const,
      activity: "unknown" as const,
      supersededBySessionId: null,
      attachCommand: null,
      state: "connected" as const,
    })),
  };
  const manager = {
    isValidNativeId: vi.fn((_nativeId: string) => true),
    resolveDirectory: vi.fn(async (directory: string) => ({ directory })),
    launch: vi.fn(async () => target),
    exitSteps: () => [{ keys: ["C-c"] as const, delayMs: 0 }],
    archive: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const registry = new SessionManagerRegistry("test").register("test", manager);
  const resolveTarget = vi.fn<InteractionTransport["resolveTarget"]>(async () => null);
  const runtime = new SessionRuntime({ resolveTarget }, registry, bindings);
  const service = new OperationService(reader, interaction, registry, {
    now: () => now,
    waitMs: {
      create: 300_000,
      archive: managementWaitMs,
      delete: managementWaitMs,
    },
    bindings,
    runtime,
    uploads,
  });
  services.push(service);
  return {
    service,
    manager,
    registry,
    runtime,
    probe: resolveTarget,
    reader,
    interaction,
    set: (next: Pick<ManagementSnapshot, "sessions">) => {
      snapshot = managementSnapshot(next);
    },
    time: (value: number) => {
      now = value;
    },
  };
}
describe("observed management operations", () => {
  it("deduplicates requests and binds concurrent creations only by marker and launched target", async () => {
    const { service, manager, set } = setup();
    const input = { projectDirectory: "/project", worktree: false, requestId: "request-one" };
    const a = service.create(input);
    expect(service.create(input).operationId).toBe(a.operationId);
    expect(() => service.create({ ...input, worktree: true })).toThrow(/different parameters/);
    const b = service.create({ ...input, requestId: "request-two" });
    await flush();
    set({ sessions: [session("second", b.operationId), session("unrelated")] });
    await service.poll();
    expect((await service.get(a.operationId))?.status).toBe("pending");
    expect(await service.get(b.operationId)).toMatchObject({
      status: "succeeded",
      sessionId: "second",
    });
    set({ sessions: [session("first", a.operationId)] });
    await service.poll();
    expect(await service.get(a.operationId)).toMatchObject({
      status: "succeeded",
      sessionId: "first",
    });
    expect(manager.launch).toHaveBeenCalledTimes(2);
  });
  it.each(["succeeded", "failed", "unknown"] as const)(
    "retains %s request deduplication until 30 minutes after completion",
    async (status) => {
      const { service, manager, set, time } = setup();
      const input = {
        projectDirectory: "/project",
        worktree: false,
        requestId: "retained-request",
      };
      if (status === "failed") manager.launch.mockRejectedValueOnce(new Error("launch failed"));
      const op = service.create(input);
      expect(service.create(input).operationId).toBe(op.operationId);
      await flush();
      if (status === "failed") {
        expect(await service.get(op.operationId)).toMatchObject({
          status: "failed",
          error: "launch failed",
        });
        expect(service.create(input)).toEqual(await service.get(op.operationId));
      }
      const finishedAt = 300_000;
      time(finishedAt);
      if (status === "succeeded") set({ sessions: [session("created", op.operationId)] });
      // Observe success before the deadline; failed launches have already finished at time zero.
      if (status === "succeeded") time(finishedAt - 1);
      await service.poll();
      const completed = await service.get(op.operationId);
      expect(completed).toMatchObject({ status });
      const expiresAt = Date.parse(completed!.updatedAt) + 30 * 60_000;
      for (const timestamp of [Date.parse(completed!.updatedAt), expiresAt - 1]) {
        time(timestamp);
        expect(service.create(input)).toEqual(completed);
        expect(() => service.create({ ...input, worktree: true })).toThrow(
          expect.objectContaining({ status: 409 }),
        );
        expect(() => service.create({ ...input, projectDirectory: "/other" })).toThrow(
          expect.objectContaining({ status: 409 }),
        );
        await flush();
        expect(manager.launch).toHaveBeenCalledTimes(1);
      }
      const explicit = service.create({ ...input, requestId: "explicit-new-request" });
      expect(explicit.operationId).not.toBe(op.operationId);
      await flush();
      expect(manager.launch).toHaveBeenCalledTimes(2);
      time(expiresAt);
      // Submission itself must prune, without relying on a prior query or timer tick.
      const fresh = service.create(input);
      expect(fresh.operationId).not.toBe(op.operationId);
      expect(await service.get(op.operationId)).toBeNull();
      await flush();
      expect(manager.launch).toHaveBeenCalledTimes(3);
      time(expiresAt + 1);
      expect(service.create(input).operationId).toBe(fresh.operationId);
      expect(manager.launch).toHaveBeenCalledTimes(3);
    },
  );
  it.each(["conflict", "wrong-target", "binding-failure", "wrong-project"])(
    "explains %s without guessing",
    async (scenario) => {
      const { service, set, interaction } = setup();
      const op = service.create({
        projectDirectory: "/project",
        worktree: false,
        requestId: "request-one",
      });
      await flush();
      let record = session("one", op.operationId);
      if (scenario === "wrong-target")
        bindings.submit({
          sessionId: record.id,
          time: 1,
          ordinal: 2,
          position: 0,
          attempt: {
            ordinal: 2,
            valid: true,
            ...target,
            paneId: "%999",
            operationId: op.operationId,
          },
        });
      if (scenario === "wrong-project") record = { ...record, projectDirectory: "/other" };
      if (scenario === "binding-failure")
        interaction.describe.mockResolvedValue({
          supported: true,
          activity: null,
          supersededBySessionId: null,
          attachCommand: null,
          state: "disconnected",
        } as never);
      set({
        sessions: scenario === "conflict" ? [record, session("two", op.operationId)] : [record],
      });
      await service.poll();
      expect(await service.get(op.operationId)).toMatchObject({
        status: "unknown",
        error: expect.any(String),
      });
    },
  );
  it("defaults yolo off, forwards opt-in, and includes it in request deduplication", async () => {
    const { service, manager } = setup();
    const input = { projectDirectory: "/project", worktree: false, requestId: "yolo-request" };
    const first = service.create(input);
    expect(service.create({ ...input, yolo: false })).toEqual(first);
    expect(() => service.create({ ...input, yolo: true })).toThrow(/different parameters/);
    await flush();
    expect(manager.launch).toHaveBeenLastCalledWith({
      operationId: first.operationId,
      workingDirectory: "/project",
      worktree: false,
      yolo: false,
      projectDirectory: "/project",
    });
    const second = service.create({ ...input, requestId: "yolo-enabled", yolo: true });
    await flush();
    expect(manager.launch).toHaveBeenLastCalledWith({
      operationId: second.operationId,
      workingDirectory: "/project",
      worktree: false,
      yolo: true,
      projectDirectory: "/project",
    });
  });
  it("keeps timeout terminal and never relaunches on queries", async () => {
    const { service, manager, set, time } = setup();
    const op = service.create({
      projectDirectory: "/project",
      worktree: true,
      requestId: "request-one",
    });
    await flush();
    await service.poll();
    time(300_001);
    await service.poll();
    expect((await service.get(op.operationId))?.status).toBe("unknown");
    await service.poll();
    set({ sessions: [session("late", op.operationId)] });
    expect(await service.get(op.operationId)).toMatchObject({ status: "unknown", sessionId: null });
    expect(manager.launch).toHaveBeenCalledTimes(1);
    expect(await setup().service.get(op.operationId)).toBeNull();
  });
  it("archives unbound sessions and requires archive before deletion", async () => {
    const { service, manager, set, interaction } = setup();
    const record = {
      ...session(),
      diagnostics: [
        { code: "partial", severity: "warning" as const, message: "Partial", ordinal: null },
      ],
    };
    set({ sessions: [record] });
    interaction.describe.mockResolvedValue({
      supported: true,
      activity: null,
      supersededBySessionId: null,
      attachCommand: null,
      state: "unbound",
    } as never);
    const archive = service.manage("archive", "session");
    await flush();
    expect(manager.archive).toHaveBeenCalledOnce();
    set({ sessions: [{ ...record, archived: true }] });
    await service.poll();
    expect((await service.get(archive.operationId))?.status).toBe("succeeded");
    set({ sessions: [session()] });
    const deletion = service.manage("delete", "session");
    await flush();
    expect((await service.get(deletion.operationId))?.status).toBe("failed");
    expect(manager.archive).toHaveBeenCalledOnce();
    expect(manager.delete).not.toHaveBeenCalled();
  });
  it("merges the same operation, rejects conflicts, and allows a new request after completion", async () => {
    const { service, manager, set } = setup();
    set({ sessions: [session()] });
    const archive = service.manage("archive", "session");
    expect(service.manage("archive", "session").operationId).toBe(archive.operationId);
    expect(() => service.manage("delete", "session")).toThrow(/running/);
    await flush();
    set({ sessions: [{ ...session(), archived: true }] });
    await service.poll();
    const fresh = service.manage("archive", "session");
    await flush();
    expect(fresh.operationId).not.toBe(archive.operationId);
    expect(await service.get(fresh.operationId)).toMatchObject({ status: "succeeded" });
    expect(manager.archive).toHaveBeenCalledOnce();
    set({ sessions: [] });
    const deletion = service.manage("delete", "session");
    await flush();
    expect(await service.get(deletion.operationId)).toMatchObject({ status: "succeeded" });
    expect(manager.delete).not.toHaveBeenCalled();
  });
  it("never accepts read failures as deletion evidence", async () => {
    const { service, set, reader, time } = setup();
    set({ sessions: [{ ...session(), archived: true }] });
    const op = service.manage("delete", "session");
    await flush();
    reader.managementSnapshot.mockRejectedValueOnce(new Error("read failed"));
    await service.poll();
    expect((await service.get(op.operationId))?.status).toBe("pending");
    time(31);
    await service.poll();
    expect((await service.get(op.operationId))?.status).toBe("unknown");
    set({ sessions: [] });
    expect((await service.get(op.operationId))?.status).toBe("unknown");
  });
});

describe("archive exit workflow", () => {
  it("revalidates the target, submits exit once, and waits for its disappearance before archive", async () => {
    const { service, manager, interaction, set } = setup();
    set({ sessions: [session()] });
    interaction.resolveTarget.mockResolvedValue(target);
    interaction.inspectTarget.mockResolvedValue("alive");
    const op = service.manage("archive", "session");
    expect(service.manage("archive", "session").operationId).toBe(op.operationId);
    await flush();
    expect(interaction.resolveTarget).toHaveBeenCalledWith("session");
    expect(interaction.sendExitKeys).toHaveBeenCalledExactlyOnceWith(
      target,
      "session",
      ["C-c"],
      expect.any(Function),
    );
    expect(manager.archive).not.toHaveBeenCalled();
    expect(await service.get(op.operationId)).toMatchObject({
      phase: "waiting_exit",
      status: "pending",
    });
    expect(interaction.setBusy).toHaveBeenLastCalledWith("session", true);
    interaction.inspectTarget.mockResolvedValue("exited");
    await Promise.all([service.poll(), service.poll(), service.get(op.operationId)]);
    expect(manager.archive).toHaveBeenCalledOnce();
    expect(await service.get(op.operationId)).toMatchObject({
      phase: "confirming_archive",
      status: "pending",
    });
    set({ sessions: [{ ...session(), archived: true }] });
    await service.poll();
    await flush();
    expect(await service.get(op.operationId)).toMatchObject({ status: "succeeded" });
    expect(interaction.sendExitKeys).toHaveBeenCalledOnce();
    expect(interaction.setBusy).toHaveBeenLastCalledWith("session", false);
  });

  it("ends tracking on exit timeout and permits a fresh request", async () => {
    const { service, manager, interaction, set, time } = setup();
    set({ sessions: [session()] });
    interaction.resolveTarget.mockResolvedValue(target);
    interaction.inspectTarget.mockResolvedValue("alive");
    const op = service.manage("archive", "session");
    await flush();
    time(31);
    await service.poll();
    await flush();
    expect(await service.get(op.operationId)).toMatchObject({
      status: "unknown",
      phase: "waiting_exit",
    });
    expect(interaction.setBusy).toHaveBeenLastCalledWith("session", false);
    expect(manager.archive).not.toHaveBeenCalled();
    interaction.inspectTarget.mockResolvedValue("exited");
    manager.archive.mockImplementation(async () => {
      set({ sessions: [{ ...session(), archived: true }] });
    });
    await Promise.all([service.get(op.operationId), service.get(op.operationId)]);
    expect(await service.get(op.operationId)).toMatchObject({ status: "unknown" });
    expect(manager.archive).not.toHaveBeenCalled();
    const retry = service.manage("archive", "session");
    await flush();
    expect(retry.operationId).not.toBe(op.operationId);
    expect(manager.archive).toHaveBeenCalledOnce();
  });

  it("does not resend exit when submission has an uncertain result", async () => {
    const { service, interaction, manager, set } = setup();
    set({ sessions: [session()] });
    interaction.resolveTarget.mockResolvedValue(target);
    interaction.sendExitKeys.mockRejectedValue(new Error("submission outcome unknown"));
    interaction.inspectTarget.mockResolvedValue("alive");
    const op = service.manage("archive", "session");
    await flush();
    expect(await service.get(op.operationId)).toMatchObject({ status: "unknown" });
    expect(manager.archive).not.toHaveBeenCalled();
    interaction.inspectTarget.mockResolvedValue("exited");
    await Promise.all([service.get(op.operationId), service.get(op.operationId)]);
    expect(manager.archive).not.toHaveBeenCalled();
    expect(interaction.sendExitKeys).toHaveBeenCalledOnce();
  });

  it("does not archive on query errors", async () => {
    const { service, interaction, manager, set, time } = setup();
    set({ sessions: [session()] });
    interaction.resolveTarget.mockResolvedValue(target);
    interaction.inspectTarget.mockRejectedValue(new Error("permission denied"));
    const op = service.manage("archive", "session");
    await flush();
    await service.poll();
    time(31);
    await service.poll();
    expect((await service.get(op.operationId))?.status).toBe("unknown");
    expect(manager.archive).not.toHaveBeenCalled();
    expect(interaction.sendExitKeys).not.toHaveBeenCalled();
    expect(interaction.killTarget).not.toHaveBeenCalled();
  });

  it.each(["failure", "timeout"])("never repeats archive after command %s", async (scenario) => {
    const { service, interaction, manager, set } = setup();
    set({ sessions: [session()] });
    manager.archive.mockRejectedValue(
      Object.assign(new Error("native archive error"), { killed: scenario === "timeout" }),
    );
    const op = service.manage("archive", "session");
    await flush();
    expect(await service.get(op.operationId)).toMatchObject({
      status: scenario === "timeout" ? "unknown" : "failed",
      error: "native archive error",
      phase: "archiving",
    });
    set({ sessions: [{ ...session(), archived: true }] });
    await Promise.all([service.get(op.operationId), service.get(op.operationId), service.poll()]);
    expect((await service.get(op.operationId))?.status).toBe(
      scenario === "timeout" ? "unknown" : "failed",
    );
    expect(manager.archive).toHaveBeenCalledOnce();
    expect(interaction.sendExitKeys).not.toHaveBeenCalled();
  });
});

it("starts the binding budget after launch and exposes attach only after 30 seconds", async () => {
  const { service, manager, time } = setup();
  let launched!: (value: typeof target) => void;
  manager.launch.mockImplementation(
    () =>
      new Promise((resolve) => {
        launched = resolve;
      }),
  );
  const input = { projectDirectory: "/project", worktree: false, requestId: "timing-request" };
  const op = service.create(input);
  await flush();
  time(400_000);
  await service.poll();
  expect(await service.get(op.operationId)).toMatchObject({
    status: "pending",
    attachCommand: null,
  });
  launched(target);
  await flush();
  time(429_999);
  await service.poll();
  expect((await service.get(op.operationId))?.attachCommand).toBeNull();
  time(430_000);
  await service.poll();
  expect(await service.get(op.operationId)).toMatchObject({
    status: "pending",
    attachCommand: expect.stringContaining(target.socketPath),
  });
  const attached = await service.get(op.operationId);
  expect(attached?.updatedAt).toBe(new Date(430_000).toISOString());
  time(431_000);
  await service.poll();
  expect(await service.get(op.operationId)).toEqual(attached);
  time(700_000);
  await service.poll();
  expect(await service.get(op.operationId)).toMatchObject({
    status: "unknown",
    attachCommand: expect.any(String),
  });
  expect(service.create(input)).toEqual(await service.get(op.operationId));
});

it("expires a hung observation and prevents its late return from advancing or releasing a new operation", async () => {
  const { service, interaction, manager, set, time } = setup();
  set({ sessions: [session()] });
  interaction.resolveTarget.mockResolvedValue(target);
  let resolve!: (state: "exited") => void;
  interaction.inspectTarget.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const old = service.manage("archive", "session");
  await flush();
  time(31);
  await service.poll();
  expect(await service.get(old.operationId)).toMatchObject({ status: "unknown" });
  interaction.inspectTarget.mockResolvedValue("alive");
  const fresh = service.manage("archive", "session");
  await flush();
  const busyCalls = interaction.setBusy.mock.calls.length;
  resolve("exited");
  await flush();
  expect(manager.archive).not.toHaveBeenCalled();
  expect(interaction.setBusy).toHaveBeenCalledTimes(busyCalls);
  expect(await service.get(fresh.operationId)).toMatchObject({ status: "pending" });
  expect(await service.get(old.operationId)).toMatchObject({ status: "unknown" });
});

it("rechecks actual deletion after timeout without repeating the native command", async () => {
  const { service, manager, set, time } = setup();
  set({ sessions: [{ ...session(), archived: true }] });
  const old = service.manage("delete", "session");
  await flush();
  time(31);
  await service.poll();
  expect(await service.get(old.operationId)).toMatchObject({ status: "unknown" });
  set({ sessions: [] });
  const fresh = service.manage("delete", "session");
  await flush();
  expect(await service.get(fresh.operationId)).toMatchObject({ status: "succeeded" });
  expect(manager.delete).toHaveBeenCalledOnce();
});

it.each(["timeout", "command_failed"])(
  "stops archive before exit on initial query %s",
  async (code) => {
    const { service, interaction, manager, set } = setup();
    set({ sessions: [session()] });
    interaction.resolveTarget.mockRejectedValue(Object.assign(new Error("query error"), { code }));
    const op = service.manage("archive", "session");
    await flush();
    expect(await service.get(op.operationId)).toMatchObject({
      status: code === "timeout" ? "unknown" : "failed",
    });
    expect(interaction.sendExitKeys).not.toHaveBeenCalled();
    expect(manager.archive).not.toHaveBeenCalled();
  },
);
it("delegates duplicate native identities to the adapter", async () => {
  const { service, interaction, manager, set } = setup();
  set({ sessions: [session(), session("duplicate")] });
  const op = service.manage("archive", "session");
  await flush();
  expect(manager.archive).toHaveBeenCalled();
  expect(interaction.sendExitKeys).not.toHaveBeenCalled();
  expect(await service.get(op.operationId)).toMatchObject({ status: "pending" });
});

it.each(["not_started", "unknown"] as const)(
  "preserves explicit launch outcome %s and deduplicates",
  async (outcome) => {
    const { service, manager } = setup();
    const attach = outcome === "unknown" ? "tmux attach-session -t 'ahub-test'" : null;
    manager.launch.mockRejectedValueOnce(
      new SessionLaunchError(outcome, "launch error", attach, target),
    );
    const input = { projectDirectory: "/project", worktree: false, requestId: "launch-outcome" };
    const op = service.create(input);
    await flush();
    const result = await service.get(op.operationId);
    expect(result).toMatchObject({
      status: outcome === "unknown" ? "unknown" : "failed",
      attachCommand: attach,
    });
    expect(service.create(input)).toEqual(result);
    await service.poll();
    expect(manager.launch).toHaveBeenCalledOnce();
  },
);

it("rejects duplicate manager registrations", () => {
  const { manager } = setup();
  const registry = new SessionManagerRegistry("test").register("test", manager);
  expect(() => registry.register("test", manager)).toThrow(/Duplicate/);
});

it.each(["archive", "delete"] as const)(
  "routes %s by source and ignores other-source confirmations",
  async (type) => {
    const { service, manager, registry, set, interaction } = setup();
    const other = {
      ...manager,
      archive: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    registry.register("other", other);
    const local = { ...session(), sourceId: "native-text", archived: type === "delete" };
    const remote = {
      ...local,
      id: "remote",
      origin: { ...local.origin, home: "other" },
    };
    set({ sessions: [local, remote] });
    const op = service.manage(type, "remote");
    await flush();
    expect(other[type]).toHaveBeenCalledWith("native-text");
    expect(manager[type]).not.toHaveBeenCalled();
    expect(interaction.sendExitKeys).not.toHaveBeenCalled();
    set({ sessions: [{ ...local, archived: true }, remote] });
    await service.poll();
    expect((await service.get(op.operationId))?.status).toBe("pending");
    set({ sessions: type === "delete" ? [local] : [local, { ...remote, archived: true }] });
    await service.poll();
    expect((await service.get(op.operationId))?.status).toBe("succeeded");
  },
);

it("never falls back to a default manager for an unregistered source", async () => {
  const { service, manager, interaction, set } = setup();
  const record = session();
  set({
    sessions: [{ ...record, origin: { ...record.origin, home: "unregistered" } }],
  });
  const op = service.manage("archive", record.id);
  await flush();
  expect(await service.get(op.operationId)).toMatchObject({
    status: "failed",
    error: expect.stringContaining("no management capability"),
  });
  expect(manager.archive).not.toHaveBeenCalled();
  expect(interaction.resolveTarget).not.toHaveBeenCalled();
});

it("updates public phase timestamps only on changes and freezes terminal results", async () => {
  const { service, manager, interaction, set, time } = setup();
  set({ sessions: [session()] });
  interaction.resolveTarget.mockResolvedValue(target);
  interaction.inspectTarget.mockResolvedValue("alive");
  let exit!: (value?: undefined) => void;
  interaction.sendExitKeys.mockImplementation(
    () =>
      new Promise<undefined>((resolve) => {
        exit = resolve;
      }),
  );
  time(1);
  const op = service.manage("archive", "session");
  await flush();
  expect(await service.get(op.operationId)).toMatchObject({
    phase: "sending_exit",
    updatedAt: new Date(1).toISOString(),
  });
  time(2);
  exit();
  await flush();
  expect(await service.get(op.operationId)).toMatchObject({
    phase: "waiting_exit",
    updatedAt: new Date(2).toISOString(),
  });
  time(3);
  await service.poll();
  expect((await service.get(op.operationId))?.updatedAt).toBe(new Date(2).toISOString());
  let archived!: (value?: undefined) => void;
  manager.archive.mockImplementation(
    () =>
      new Promise<undefined>((resolve) => {
        archived = resolve;
      }),
  );
  interaction.inspectTarget.mockResolvedValue("exited");
  time(4);
  const checking = service.poll();
  await flush();
  expect(await service.get(op.operationId)).toMatchObject({
    phase: "archiving",
    updatedAt: new Date(4).toISOString(),
  });
  time(5);
  archived();
  await checking;
  expect(await service.get(op.operationId)).toMatchObject({
    phase: "confirming_archive",
    updatedAt: new Date(5).toISOString(),
  });
  time(6);
  set({ sessions: [{ ...session(), archived: true }] });
  await service.poll();
  const result = await service.get(op.operationId);
  expect(result).toMatchObject({ status: "succeeded", updatedAt: new Date(6).toISOString() });
  time(7);
  await service.poll();
  service.close();
  expect(await service.get(op.operationId)).toEqual(result);
});

it("isolates creation association and fingerprints the selected source", async () => {
  const { service, manager, registry, set, interaction } = setup();
  const other = {
    ...manager,
    launch: vi.fn(async () => target),
    archive: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  registry.register("other", other);
  const input = { projectDirectory: "/project", worktree: false, requestId: "multi-home-create" };
  expect(() => service.create({ ...input, home: "missing" })).toThrow("Unknown home");
  const operation = service.create({ ...input, home: "other" });
  expect(() => service.create({ ...input, home: "test" })).toThrow("different parameters");
  await flush();
  expect(other.launch).toHaveBeenCalledTimes(1);
  expect(manager.launch).not.toHaveBeenCalled();
  const wrong = session("wrong-home", operation.operationId);
  set({ sessions: [wrong] });
  await service.poll();
  expect((await service.get(operation.operationId))!.status).toBe("pending");
  expect(interaction.describe).not.toHaveBeenCalled();
  const candidate = session("right-home", operation.operationId);
  const correct = { ...candidate, origin: { ...candidate.origin, home: "other" } };
  set({ sessions: [wrong, correct] });
  await service.poll();
  expect((await service.get(operation.operationId))!.sessionId).toBe(correct.id);
});

describe("standalone exit operations", () => {
  it.each([false, true])(
    "exits without archiving an archived=%s session and coalesces requests",
    async (archived) => {
      const { service, interaction, manager, set } = setup();
      set({ sessions: [{ ...session(), archived }] });
      interaction.resolveTarget.mockResolvedValue(target);
      interaction.inspectTarget.mockResolvedValue("alive");
      const op = service.manage("exit", "session");
      expect(service.manage("exit", "session").operationId).toBe(op.operationId);
      expect(() => service.manage("archive", "session")).toThrow("Another management operation");
      expect(() => service.manage("delete", "session")).toThrow("Another management operation");
      await flush();
      expect(await service.get(op.operationId)).toMatchObject({ type: "exit", status: "pending" });
      expect(interaction.sendExitKeys).toHaveBeenCalledOnce();
      interaction.inspectTarget.mockResolvedValue("exited");
      await service.poll();
      expect(await service.get(op.operationId)).toMatchObject({
        type: "exit",
        status: "succeeded",
      });
      expect(manager.archive).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
      expect(interaction.setBusy).toHaveBeenLastCalledWith("session", false);
    },
  );

  it("does not require a native UUID to exit an unbound session", async () => {
    const { service, set, manager } = setup();
    set({ sessions: [{ ...session(), sourceId: null }] });
    const op = service.manage("exit", "session");
    await flush();
    expect(await service.get(op.operationId)).toMatchObject({ status: "succeeded" });
    expect(manager.archive).not.toHaveBeenCalled();
  });

  it("stops queued effects when closed", async () => {
    const { service, interaction, set } = setup();
    set({ sessions: [session()] });
    interaction.resolveTarget.mockResolvedValue(target);
    interaction.inspectTarget.mockResolvedValue("alive");
    let execute!: () => void;
    interaction.sendExitKeys.mockImplementation(async (_target, _session, _keys, check) => {
      await new Promise<void>((resolve) => {
        execute = resolve;
      });
      check();
      return undefined;
    });
    const op = service.manage("exit", "session");
    await flush();
    service.close();
    execute();
    await flush();
    expect(await service.get(op.operationId)).toMatchObject({ status: "unknown" });
    expect(interaction.killTarget).not.toHaveBeenCalled();
  });
});

it.each(["exit", "archive"] as const)(
  "confirms forced pane shutdown before completing %s",
  async (type) => {
    const { service, manager, interaction, set, time } = setup(30_000);
    set({ sessions: [session()] });
    interaction.resolveTarget.mockResolvedValue(target);
    interaction.inspectTarget.mockResolvedValue("alive");
    manager.exitSteps = () => [
      { keys: ["C-c"] as const, delayMs: 0 },
      { keys: ["C-c"] as const, delayMs: 1_000 },
      { keys: ["C-c"] as const, delayMs: 1_000 },
    ];
    const op = service.manage(type, "session");
    await flush();
    time(1_000);
    await Promise.all([service.poll(), service.poll()]);
    time(2_000);
    await service.poll();
    time(6_000);
    await service.poll();
    expect(interaction.sendExitKeys.mock.calls.map((call) => call[2])).toEqual([
      ["C-c"],
      ["C-c"],
      ["C-c"],
      ["C-d"],
    ]);
    time(15_000);
    await Promise.all([service.poll(), service.poll()]);
    expect(interaction.killTarget).toHaveBeenCalledOnce();
    expect(manager.archive).not.toHaveBeenCalled();
    expect(await service.get(op.operationId)).toMatchObject({ status: "pending" });
    interaction.inspectTarget.mockResolvedValue("exited");
    await service.poll();
    if (type === "archive") {
      expect(manager.archive).toHaveBeenCalledOnce();
      set({ sessions: [{ ...session(), archived: true }] });
      await service.poll();
    } else expect(manager.archive).not.toHaveBeenCalled();
    expect(await service.get(op.operationId)).toMatchObject({ status: "succeeded" });
  },
);

it("does not kill after binding refresh fails at the force deadline", async () => {
  const { service, interaction, reader, set, time } = setup(30_000);
  set({ sessions: [session()] });
  interaction.resolveTarget.mockResolvedValue(target);
  interaction.inspectTarget.mockResolvedValue("alive");
  const op = service.manage("exit", "session");
  await flush();
  time(1_000);
  await service.poll();
  time(6_000);
  reader.managementSnapshot.mockRejectedValue(new Error("binding read failed"));
  await service.poll();
  expect(await service.get(op.operationId)).toMatchObject({
    status: "unknown",
    error: "binding read failed",
  });
  expect(interaction.killTarget).not.toHaveBeenCalled();
});

describe("safe resume operations", () => {
  function resumable(sourceId = session().sourceId) {
    const f = setup();
    const original = { ...session("original"), sourceId };
    bindings.submit({
      sessionId: original.id,
      time: 1,
      ordinal: 1,
      position: 0,
      attempt: { valid: true, ordinal: 1, ...target },
    });
    f.set({ sessions: [original] });
    return { ...f, original };
  }
  const request = { resumeSessionId: "original", requestId: "resume-request-one" };

  it("shares session occupancy, request idempotency, and observes the original session binding", async () => {
    const f = resumable("native:会话/42%");
    const op = f.service.create(request);
    expect(op).toMatchObject({ type: "create", mode: "resume", sessionId: "original" });
    expect(f.service.create(request).operationId).toBe(op.operationId);
    expect(() => f.service.create({ ...request, requestId: "resume-request-two" })).toThrow(
      /Another management/,
    );
    expect(() => f.service.manage("exit", "original")).toThrow(/Another management/);
    expect(() => f.service.manage("archive", "original")).toThrow(/Another management/);
    await flush();
    expect(f.manager.launch).toHaveBeenCalledWith({
      operationId: op.operationId,
      workingDirectory: "/project",
      worktree: false,
      yolo: false,
      resumeNativeId: f.original.sourceId,
      projectDirectory: f.original.projectDirectory,
    });
    expect(f.manager.resolveDirectory).toHaveBeenCalledTimes(1);
    expect(f.reader.managementSnapshot).toHaveBeenCalledTimes(1);
    expect(f.manager.isValidNativeId).toHaveBeenCalledTimes(1);
    bindings.submit({
      sessionId: "original",
      time: 2,
      ordinal: 2,
      position: 0,
      attempt: { valid: true, ordinal: 2, ...target, operationId: op.operationId },
    });
    await f.service.poll();
    expect(await f.service.get(op.operationId)).toMatchObject({
      status: "succeeded",
      sessionId: "original",
      target,
    });
    expect(f.interaction.setBusy).toHaveBeenLastCalledWith("original", false);
  });

  it("resumes the original public session even when another session shares its native ID", async () => {
    const f = resumable();
    const duplicate = { ...f.original, id: "duplicate" };
    f.set({ sessions: [f.original, duplicate] });
    const op = f.service.create(request);
    await flush();
    expect(f.manager.launch).toHaveBeenCalledWith(
      expect.objectContaining({ resumeNativeId: f.original.sourceId }),
    );
    bindings.submit({
      sessionId: "original",
      time: 2,
      ordinal: 2,
      position: 0,
      attempt: { valid: true, ordinal: 2, ...target, operationId: op.operationId },
    });
    await f.service.poll();
    expect(await f.service.get(op.operationId)).toMatchObject({
      status: "succeeded",
      sessionId: "original",
    });
  });

  it("launches an unbound session through the existing resume operation", async () => {
    const f = setup();
    const original = session("original");
    f.set({ sessions: [original] });
    const op = f.service.create(request);
    await flush();
    expect(f.manager.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: op.operationId,
        resumeNativeId: original.sourceId,
        projectDirectory: "/project",
      }),
    );
  });

  it("denies resume when the owning adapter rejects the native identity", async () => {
    const f = resumable();
    f.manager.isValidNativeId.mockReturnValue(false);
    const op = f.service.create(request);
    await flush();
    expect(await f.service.get(op.operationId)).toMatchObject({ status: "failed" });
    expect(f.manager.isValidNativeId).toHaveBeenCalledWith(f.original.sourceId);
    expect(f.manager.launch).not.toHaveBeenCalled();
  });

  it("blocks resume while another management action owns the session", () => {
    const f = resumable();
    f.service.manage("archive", "original");
    expect(() => f.service.create(request)).toThrow(/Another management/);
  });

  it("rejects binding changes during runtime validation", async () => {
    const f = resumable();
    f.manager.resolveDirectory.mockImplementationOnce(async () => {
      bindings.submit({
        sessionId: "original",
        time: 3,
        ordinal: 3,
        position: 0,
        attempt: { valid: false, ordinal: 3 },
      });
      return { directory: "/project" };
    });
    const op = f.service.create(request);
    await flush();
    expect((await f.service.get(op.operationId))?.status).toBe("failed");
    expect(f.manager.launch).not.toHaveBeenCalled();
    expect(f.reader.managementSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not launch an operation invalidated during validation", async () => {
    const f = resumable();
    f.manager.resolveDirectory.mockImplementationOnce(async () => {
      f.service.close();
      return { directory: "/project" };
    });
    f.service.create(request);
    await flush();
    expect(f.manager.launch).not.toHaveBeenCalled();
  });

  it("does not launch an archived session", async () => {
    const f = resumable();
    f.set({ sessions: [{ ...f.original, archived: true }] });
    const op = f.service.create(request);
    await flush();
    expect((await f.service.get(op.operationId))?.status).toBe("failed");
    expect(f.manager.launch).not.toHaveBeenCalled();
  });

  it("does not associate a resumed operation with a different session", async () => {
    const f = resumable();
    const op = f.service.create(request);
    await flush();
    f.set({ sessions: [f.original, session("unexpected", op.operationId)] });
    await f.service.poll();
    expect((await f.service.get(op.operationId))?.status).toBe("unknown");
  });

  it("retains unknown target/attach information and deduplicates only the same requestId", async () => {
    const f = resumable();
    f.manager.launch.mockRejectedValueOnce(
      new SessionLaunchError("unknown", "timeout", "tmux attach", { ...target, paneId: "%99" }),
    );
    f.probe.mockImplementation(async () => null);
    const op = f.service.create(request);
    await flush();
    expect(await f.service.get(op.operationId)).toMatchObject({
      status: "unknown",
      attachCommand: "tmux attach",
      target: { paneId: "%99" },
    });
    // The original pane is dead; the previous unknown launch is not an extra gate.
    f.probe.mockImplementation(async (attempt) =>
      attempt.valid && attempt.paneId === "%99" ? { ...target, paneId: "%99" } : null,
    );
    expect(f.service.create(request).operationId).toBe(op.operationId);
    const retry = f.service.create({ ...request, requestId: "resume-request-new" });
    await flush();
    expect((await f.service.get(retry.operationId))?.status).toBe("pending");
    expect(f.manager.launch).toHaveBeenCalledTimes(2);
  });

  it("allows a new request after an unknown launch without a known target", async () => {
    const f = resumable();
    f.manager.launch.mockRejectedValueOnce(
      new SessionLaunchError("unknown", "timeout", "tmux attach"),
    );
    const op = f.service.create(request);
    await flush();
    expect((await f.service.get(op.operationId))?.status).toBe("unknown");
    expect(f.service.create(request).operationId).toBe(op.operationId);
    const retry = f.service.create({ ...request, requestId: "resume-request-new" });
    await flush();
    expect((await f.service.get(retry.operationId))?.status).toBe("pending");
    expect(f.manager.launch).toHaveBeenCalledTimes(2);
  });

  it("uses the original home even with multiple configured sources and accepts only yolo", async () => {
    const f = resumable();
    f.registry.register("other", { ...f.manager });
    const op = f.service.create({ ...request, yolo: true });
    await flush();
    expect(f.manager.launch).toHaveBeenCalledWith({
      operationId: op.operationId,
      workingDirectory: "/project",
      worktree: false,
      yolo: true,
      resumeNativeId: f.original.sourceId,
      projectDirectory: f.original.projectDirectory,
    });
    expect(() => f.service.create({ ...request, projectDirectory: "/other" } as never)).toThrow(
      /only/,
    );
  });
});

describe("session upload cleanup", () => {
  function cleanup() {
    return {
      cleanup: vi.fn(async () => {}),
    };
  }
  it("succeeds before asynchronous cleanup completes and logs cleanup failure", async () => {
    const uploads = cleanup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectCleanup!: (error: Error) => void;
    uploads.cleanup.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCleanup = reject;
        }),
    );
    const { service, manager, set } = setup(30000, uploads);
    set({ sessions: [{ ...session(), archived: true }] });
    const op = service.manage("delete", "session");
    await flush();
    expect(manager.delete).toHaveBeenCalledOnce();
    expect(uploads.cleanup).not.toHaveBeenCalled();
    set({ sessions: [] });
    await service.poll();
    expect(await service.get(op.operationId)).toMatchObject({ status: "succeeded", error: null });
    expect(uploads.cleanup).toHaveBeenCalledWith("session");
    rejectCleanup(new Error("disk failure"));
    await flush();
    expect(log).toHaveBeenCalledWith(
      "Session attachment cleanup failed",
      expect.objectContaining({ sessionId: "session", error: expect.any(Error) }),
    );
    expect(await service.get(op.operationId)).toMatchObject({ status: "succeeded", error: null });
    const repeated = service.manage("delete", "session");
    await flush();
    expect(await service.get(repeated.operationId)).toMatchObject({ status: "succeeded" });
    expect(manager.delete).toHaveBeenCalledOnce();
    expect(uploads.cleanup).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
  it("does not trigger cleanup after an unconfirmed deletion times out", async () => {
    const uploads = cleanup();
    const { service, manager, set, time } = setup(30000, uploads);
    set({ sessions: [{ ...session(), archived: true }] });
    const op = service.manage("delete", "session");
    await flush();
    expect(manager.delete).toHaveBeenCalledOnce();
    time(30001);
    await service.poll();
    expect(await service.get(op.operationId)).toMatchObject({ status: "unknown" });
    expect(uploads.cleanup).not.toHaveBeenCalled();
  });
  it("retains uploads after native failure, archive, and exit", async () => {
    const uploads = cleanup();
    const { service, manager, set } = setup(30000, uploads);
    set({ sessions: [{ ...session(), archived: true }] });
    manager.delete.mockRejectedValueOnce(new Error("native failure"));
    const op = service.manage("delete", "session");
    await flush();
    expect(await service.get(op.operationId)).toMatchObject({ status: "failed" });
    service.manage("archive", "session");
    await flush();
    service.manage("exit", "session");
    await flush();
    expect(uploads.cleanup).not.toHaveBeenCalled();
  });
});

it("defaults to the first configured home and resolves explicit nicknames without fallback", async () => {
  const { service, manager, registry } = setup();
  const other = { ...manager, launch: vi.fn(async () => target) };
  registry.register("secondary", other);
  const input = { projectDirectory: "/project", worktree: false, requestId: "default-home-test" };
  service.create(input);
  service.create({ ...input, requestId: "explicit-home-test", home: "secondary" });
  expect(() => service.create({ ...input, home: "missing" })).toThrow("Unknown home");
  await flush();
  expect(manager.launch).toHaveBeenCalledOnce();
  expect(other.launch).toHaveBeenCalledOnce();
});

it("rejects empty and duplicate management home nicknames", () => {
  const { manager, registry } = setup();
  expect(() => registry.register(" ", manager)).toThrow("Empty home nickname");
  expect(() => registry.register("test", manager)).toThrow("Duplicate home nickname");
});

it("prunes batches while retaining recent results and active request identities", async () => {
  const { service, manager, time } = setup();
  manager.launch.mockRejectedValue(new Error("failed"));
  const inputs = Array.from({ length: 40 }, (_, index) => ({
    projectDirectory: "/project",
    worktree: false,
    requestId: `batch-request-${index}`,
  }));
  const old = inputs.map((input) => service.create(input));
  await flush();
  time(30 * 60_000 - 1);
  const recentInput = { ...inputs[0]!, requestId: "recent-request" };
  const recent = service.create(recentInput);
  await flush();
  manager.launch.mockImplementation(() => new Promise(() => {}));
  const activeInput = { ...inputs[0]!, requestId: "active-request" };
  const active = service.create(activeInput);
  time(30 * 60_000);
  for (const operation of old) expect(await service.get(operation.operationId)).toBeNull();
  expect(service.create(recentInput).operationId).toBe(recent.operationId);
  expect(service.create(activeInput).operationId).toBe(active.operationId);
  expect(() => service.create({ ...activeInput, worktree: true })).toThrow(
    expect.objectContaining({ status: 409 }),
  );
  for (const [index, input] of inputs.entries())
    expect(service.create(input).operationId).not.toBe(old[index]!.operationId);
});

describe("creation project and working directories", () => {
  it.each([undefined, "/project"])(
    "reuses project resolution for cwd %s and normalizes idempotency",
    async (workingDirectory) => {
      const f = setup();
      const input = { projectDirectory: "/project", worktree: false, requestId: "directories" };
      const op = f.service.create({ ...input, workingDirectory });
      expect(f.service.create({ ...input, workingDirectory: "/project" })).toEqual(op);
      expect(() => f.service.create({ ...input, workingDirectory: "/other" })).toThrow(
        /different parameters/,
      );
      expect(() => f.service.create({ ...input, projectDirectory: "/other" })).toThrow(
        /different parameters/,
      );
      await flush();
      expect(f.manager.resolveDirectory).toHaveBeenCalledTimes(1);
      expect(f.manager.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          workingDirectory: "/project",
          projectDirectory: "/project",
        }),
      );
    },
  );

  it.each([false, true])(
    "launches in an existing working directory independently of project, worktree=%s",
    async (worktree) => {
      const f = setup();
      f.manager.resolveDirectory.mockImplementation(async (directory) => ({
        directory: directory + "/real",
      }));
      const op = f.service.create({
        projectDirectory: "/project",
        workingDirectory: "/existing-worktree",
        worktree,
        requestId: "split-directories",
      });
      await flush();
      expect(f.manager.resolveDirectory.mock.calls).toEqual([["/project"], ["/existing-worktree"]]);
      expect(f.manager.launch).toHaveBeenCalledWith({
        operationId: op.operationId,
        workingDirectory: "/existing-worktree/real",
        projectDirectory: "/project/real",
        worktree,
        yolo: false,
      });
      f.set({
        sessions: [
          {
            ...session("created", op.operationId),
            workingDirectory: "/existing-worktree/real",
            projectDirectory: "/project/real",
          },
        ],
      });
      await f.service.poll();
      expect(await f.service.get(op.operationId)).toMatchObject({
        status: "succeeded",
        sessionId: "created",
      });
    },
  );

  it.each(["/project", "/working"])("does not launch when %s is unavailable", async (missing) => {
    const f = setup();
    f.manager.resolveDirectory.mockImplementation(async (directory) => {
      if (directory === missing)
        throw Object.assign(new Error("Missing directory"), { code: "ENOENT" });
      return { directory };
    });
    const op = f.service.create({
      projectDirectory: "/project",
      workingDirectory: "/working",
      worktree: false,
      requestId: "missing-directory",
    });
    await flush();
    expect(await f.service.get(op.operationId)).toMatchObject({ status: "failed" });
    expect(f.manager.launch).not.toHaveBeenCalled();
  });

  it("resumes from the original working directory while retaining project association", async () => {
    const f = setup();
    const original = {
      ...session("original"),
      workingDirectory: "/working",
      projectDirectory: "/project",
    };
    f.set({ sessions: [original] });
    const op = f.service.create({ resumeSessionId: original.id, requestId: "split-resume" });
    await flush();
    expect(f.manager.resolveDirectory).toHaveBeenCalledWith("/working");
    expect(f.manager.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/working",
        projectDirectory: "/project",
        resumeNativeId: original.sourceId,
      }),
    );
    f.set({ sessions: [{ ...session("original", op.operationId), ...original }] });
    await f.service.poll();
    expect(await f.service.get(op.operationId)).toMatchObject({
      status: "succeeded",
      sessionId: "original",
    });
  });
});

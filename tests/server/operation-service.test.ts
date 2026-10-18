import { afterEach, describe, expect, it, vi } from "vitest";

import type { DomainSession } from "../../src/server/domain/session-domain.js";
import { LivePaneBindingManager } from "../../src/server/interaction/live-pane-binding-manager.js";
import { OperationService } from "../../src/server/management/operation-service.js";
import type { ManagementSnapshot } from "../../src/server/management/session-manager.js";
import {
  SessionLaunchError,
  SessionManagerRegistry,
} from "../../src/server/management/session-manager.js";

const target = { socketPath: "/tmp/test.sock", paneId: "%1" };
const services: OperationService[] = [];
let bindings = new LivePaneBindingManager();
afterEach(() => services.splice(0).forEach((service) => service.close()));
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
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
      sourceInstanceId: "test",
      agentName: "Codex",
      agentVersion: null,
      formatVersion: null,
    },
  };
}
function setup() {
  bindings = new LivePaneBindingManager();
  let snapshot: ManagementSnapshot = { sessions: [] };
  let now = 0;
  const reader = { managementSnapshot: vi.fn(async () => snapshot) };
  const interaction = {
    setBusy: vi.fn(),
    archiveTarget: vi.fn(async () => null as typeof target | null),
    exitTarget: vi.fn(async () => undefined),
    inspectTarget: vi.fn(async () => "exited" as "exited" | "alive"),
    matchesTarget: vi.fn(async () => true),
    describe: vi.fn(async () => ({
      supported: true as const,
      supersededBySessionId: null,
      attachCommand: null,
      state: "connected" as const,
    })),
  };
  const manager = {
    resolveDirectory: vi.fn(async () => ({ directory: "/project", project: "/project" })),
    launch: vi.fn(async () => target),
    archive: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const registry = new SessionManagerRegistry("test").register("test", manager);
  const service = new OperationService(
    reader,
    interaction,
    registry,
    () => now,
    {
      create: 300_000,
      archive: 30,
      delete: 30,
    },
    bindings,
  );
  services.push(service);
  return {
    service,
    manager,
    registry,
    reader,
    interaction,
    set: (next: ManagementSnapshot) => {
      snapshot = next;
    },
    time: (value: number) => {
      now = value;
    },
  };
}
describe("observed management operations", () => {
  it("deduplicates requests and binds concurrent creations only by marker and launched target", async () => {
    const { service, manager, set } = setup();
    const input = { directory: "/project", worktree: false, requestId: "request-one" };
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
      const input = { directory: "/project", worktree: false, requestId: "retained-request" };
      if (status === "failed") manager.launch.mockRejectedValueOnce(new Error("launch failed"));
      const op = service.create(input);
      expect(service.create(input).operationId).toBe(op.operationId);
      await flush();
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
        expect(() => service.create({ ...input, directory: "/other" })).toThrow(
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
        directory: "/project",
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
    const input = { directory: "/project", worktree: false, requestId: "yolo-request" };
    const first = service.create(input);
    expect(service.create({ ...input, yolo: false })).toEqual(first);
    expect(() => service.create({ ...input, yolo: true })).toThrow(/different parameters/);
    await flush();
    expect(manager.launch).toHaveBeenLastCalledWith(first.operationId, "/project", false, false);
    const second = service.create({ ...input, requestId: "yolo-enabled", yolo: true });
    await flush();
    expect(manager.launch).toHaveBeenLastCalledWith(second.operationId, "/project", false, true);
  });
  it("keeps timeout terminal and never relaunches on queries", async () => {
    const { service, manager, set, time } = setup();
    const op = service.create({ directory: "/project", worktree: true, requestId: "request-one" });
    await flush();
    await service.poll();
    time(300_001);
    await service.poll();
    expect((await service.get(op.operationId))?.status).toBe("unknown");
    await service.poll();
    set({ sessions: [session("late", op.operationId)] });
    expect(await service.get(op.operationId)).toMatchObject({ status: "unknown", sessionId: null });
    expect(manager.launch).toHaveBeenCalledTimes(1);
  });
  it("archives unbound sessions and requires archive before deletion", async () => {
    const { service, manager, set, interaction } = setup();
    set({ sessions: [session()] });
    interaction.describe.mockResolvedValue({
      supported: true,
      supersededBySessionId: null,
      attachCommand: null,
      state: "unbound",
    } as never);
    const archive = service.manage("archive", "session");
    await flush();
    expect(manager.archive).toHaveBeenCalledOnce();
    set({ sessions: [{ ...session(), archived: true }] });
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
  it("expires terminal records after 30 minutes and does not resume across a new service", async () => {
    const { service, time } = setup();
    const op = service.create({ directory: "/project", worktree: false, requestId: "request-one" });
    await flush();
    time(300_001);
    await service.poll();
    expect(await setup().service.get(op.operationId)).toBeNull();
    time(30 * 60_000 + 300_002);
    expect(await service.get(op.operationId)).toBeNull();
  });
});

describe("archive exit workflow", () => {
  it("revalidates the target, submits exit once, and waits for its disappearance before archive", async () => {
    const { service, manager, interaction, set } = setup();
    set({ sessions: [session()] });
    interaction.archiveTarget.mockResolvedValue(target);
    interaction.inspectTarget.mockResolvedValue("alive");
    const op = service.manage("archive", "session");
    expect(service.manage("archive", "session").operationId).toBe(op.operationId);
    await flush();
    expect(interaction.archiveTarget).toHaveBeenCalledWith("session");
    expect(interaction.exitTarget).toHaveBeenCalledExactlyOnceWith(target, "session");
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
    expect(interaction.exitTarget).toHaveBeenCalledOnce();
    expect(interaction.setBusy).toHaveBeenLastCalledWith("session", false);
  });

  it("ends tracking on exit timeout and permits a fresh request", async () => {
    const { service, manager, interaction, set, time } = setup();
    set({ sessions: [session()] });
    interaction.archiveTarget.mockResolvedValue(target);
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
    interaction.archiveTarget.mockResolvedValue(target);
    interaction.exitTarget.mockRejectedValue(new Error("submission outcome unknown"));
    interaction.inspectTarget.mockResolvedValue("alive");
    const op = service.manage("archive", "session");
    await flush();
    expect(await service.get(op.operationId)).toMatchObject({ status: "unknown" });
    expect(manager.archive).not.toHaveBeenCalled();
    interaction.inspectTarget.mockResolvedValue("exited");
    await Promise.all([service.get(op.operationId), service.get(op.operationId)]);
    expect(manager.archive).not.toHaveBeenCalled();
    expect(interaction.exitTarget).toHaveBeenCalledOnce();
  });

  it("does not archive on query errors", async () => {
    const { service, interaction, manager, set, time } = setup();
    set({ sessions: [session()] });
    interaction.archiveTarget.mockResolvedValue(target);
    interaction.inspectTarget.mockRejectedValue(new Error("permission denied"));
    const op = service.manage("archive", "session");
    await flush();
    await service.poll();
    time(31);
    await service.poll();
    expect((await service.get(op.operationId))?.status).toBe("unknown");
    expect(manager.archive).not.toHaveBeenCalled();
    expect(interaction.exitTarget).toHaveBeenCalledOnce();
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
    expect(interaction.exitTarget).not.toHaveBeenCalled();
  });

  it("accepts non-UUID native identities through generic managers", async () => {
    const { service, manager, interaction, set } = setup();
    set({ sessions: [{ ...session(), sourceId: "invalid" }] });
    const op = service.manage("archive", "session");
    await flush();
    expect(await service.get(op.operationId)).toMatchObject({ status: "pending" });
    expect(manager.archive).toHaveBeenCalledWith("invalid");
    expect(interaction.exitTarget).not.toHaveBeenCalled();
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
  const input = { directory: "/project", worktree: false, requestId: "timing-request" };
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
  time(700_000);
  await service.poll();
  expect(await service.get(op.operationId)).toMatchObject({
    status: "unknown",
    attachCommand: expect.any(String),
  });
  expect(service.create(input)).toEqual(await service.get(op.operationId));
});

it("reports explicit tmux failures immediately and retains the request ID", async () => {
  const { service, manager } = setup();
  manager.launch.mockRejectedValue(new Error("tmux launch refused"));
  const input = { directory: "/project", worktree: false, requestId: "failed-request" };
  const op = service.create(input);
  await flush();
  expect(await service.get(op.operationId)).toMatchObject({
    status: "failed",
    error: "tmux launch refused",
  });
  expect(service.create(input)).toEqual(await service.get(op.operationId));
});

it("expires a hung observation and prevents its late return from advancing or releasing a new operation", async () => {
  const { service, interaction, manager, set, time } = setup();
  set({ sessions: [session()] });
  interaction.archiveTarget.mockResolvedValue(target);
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
    interaction.archiveTarget.mockRejectedValue(Object.assign(new Error("query error"), { code }));
    const op = service.manage("archive", "session");
    await flush();
    expect(await service.get(op.operationId)).toMatchObject({
      status: code === "timeout" ? "unknown" : "failed",
    });
    expect(interaction.exitTarget).not.toHaveBeenCalled();
    expect(manager.archive).not.toHaveBeenCalled();
  },
);
it("rejects ambiguous native UUIDs before exit", async () => {
  const { service, interaction, manager, set } = setup();
  set({ sessions: [session(), session("duplicate")] });
  const op = service.manage("archive", "session");
  await flush();
  expect(await service.get(op.operationId)).toMatchObject({ status: "failed" });
  expect(interaction.exitTarget).not.toHaveBeenCalled();
  expect(manager.archive).not.toHaveBeenCalled();
});

it.each(["not_started", "unknown"] as const)(
  "preserves explicit launch outcome %s and deduplicates",
  async (outcome) => {
    const { service, manager } = setup();
    const attach = outcome === "unknown" ? "tmux attach-session -t 'codex-hub-test'" : null;
    manager.launch.mockRejectedValueOnce(
      new SessionLaunchError(outcome, "launch error", attach, target),
    );
    const input = { directory: "/project", worktree: false, requestId: "launch-outcome" };
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
    const { service, manager, registry, set } = setup();
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
      origin: { ...local.origin, sourceInstanceId: "other" },
    };
    set({ sessions: [local, remote] });
    const op = service.manage(type, "remote");
    await flush();
    expect(other[type]).toHaveBeenCalledWith("native-text");
    expect(manager[type]).not.toHaveBeenCalled();
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
    sessions: [{ ...record, origin: { ...record.origin, sourceInstanceId: "unregistered" } }],
  });
  const op = service.manage("archive", record.id);
  await flush();
  expect(await service.get(op.operationId)).toMatchObject({
    status: "failed",
    error: expect.stringContaining("no management capability"),
  });
  expect(manager.archive).not.toHaveBeenCalled();
  expect(interaction.archiveTarget).not.toHaveBeenCalled();
});

it("allows session diagnostics when issuing and confirming a command", async () => {
  const { service, manager, set } = setup();
  const record = {
    ...session(),
    diagnostics: [
      { code: "partial", severity: "warning" as const, message: "Partial", ordinal: null },
    ],
  };
  set({ sessions: [record] });
  const op = service.manage("archive", "session");
  await flush();
  expect(manager.archive).toHaveBeenCalledOnce();
  set({ sessions: [{ ...record, archived: true }] });
  await service.poll();
  expect((await service.get(op.operationId))?.status).toBe("succeeded");
});

it("ignores creation markers from another source", async () => {
  const { service, set, interaction } = setup();
  const op = service.create({
    directory: "/project",
    worktree: false,
    requestId: "isolated-create",
  });
  await flush();
  const record = session("remote", op.operationId);
  set({ sessions: [{ ...record, origin: { ...record.origin, sourceInstanceId: "other" } }] });
  await service.poll();
  expect((await service.get(op.operationId))?.status).toBe("pending");
  expect(interaction.describe).not.toHaveBeenCalled();
});

it("updates public phase timestamps only on changes and freezes terminal results", async () => {
  const { service, manager, interaction, set, time } = setup();
  set({ sessions: [session()] });
  interaction.archiveTarget.mockResolvedValue(target);
  interaction.inspectTarget.mockResolvedValue("alive");
  let exit!: (value?: undefined) => void;
  interaction.exitTarget.mockImplementation(
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

it("does not change attach timestamps on unchanged polls", async () => {
  const { service, time } = setup();
  const op = service.create({
    directory: "/project",
    worktree: false,
    requestId: "attach-timestamp",
  });
  await flush();
  time(30_000);
  await service.poll();
  const result = await service.get(op.operationId);
  expect(result?.updatedAt).toBe(new Date(30_000).toISOString());
  time(31_000);
  await service.poll();
  expect(await service.get(op.operationId)).toEqual(result);
});

it("requires an explicit home, isolates creation association and fingerprints the selected source", async () => {
  const { service, manager, registry, set } = setup();
  const other = {
    ...manager,
    launch: vi.fn(async () => target),
    archive: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  registry.register("other", other);
  const input = { directory: "/project", worktree: false, requestId: "multi-home-create" };
  expect(() => service.create(input)).toThrow("sourceInstanceId is required");
  expect(() => service.create({ ...input, sourceInstanceId: "missing" })).toThrow(
    "Unknown sourceInstanceId",
  );
  const operation = service.create({ ...input, sourceInstanceId: "other" });
  expect(() => service.create({ ...input, sourceInstanceId: "test" })).toThrow(
    "different parameters",
  );
  await flush();
  expect(other.launch).toHaveBeenCalledTimes(1);
  expect(manager.launch).not.toHaveBeenCalled();
  const wrong = session("wrong-home", operation.operationId);
  set({ sessions: [wrong] });
  await service.poll();
  expect((await service.get(operation.operationId))!.status).toBe("pending");
  const candidate = session("right-home", operation.operationId);
  const correct = { ...candidate, origin: { ...candidate.origin, sourceInstanceId: "other" } };
  set({ sessions: [wrong, correct] });
  await service.poll();
  expect((await service.get(operation.operationId))!.sessionId).toBe(correct.id);
});

it("routes archive and delete confirmation to the owning home for identical native IDs", async () => {
  const { service, manager, registry, set } = setup();
  const other = {
    ...manager,
    archive: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  registry.register("other", other);
  const a = session("a");
  const b = { ...session("b"), origin: { ...a.origin, sourceInstanceId: "other" } };
  set({ sessions: [a, b] });
  const archive = service.manage("archive", b.id);
  await flush();
  expect(other.archive).toHaveBeenCalledWith(b.sourceId);
  expect(manager.archive).not.toHaveBeenCalled();
  set({ sessions: [a, { ...b, archived: true }] });
  await service.poll();
  expect((await service.get(archive.operationId))!.status).toBe("succeeded");
  const deletion = service.manage("delete", b.id);
  await flush();
  expect(other.delete).toHaveBeenCalledWith(b.sourceId);
  set({ sessions: [a] });
  await service.poll();
  expect((await service.get(deletion.operationId))!.status).toBe("succeeded");
});

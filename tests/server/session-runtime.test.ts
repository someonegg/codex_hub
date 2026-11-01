import { describe, expect, it, vi } from "vitest";

import type { DomainSession } from "../../src/server/domain/session-domain.js";
import { PaneBindingManager } from "../../src/server/interaction/pane-binding-manager.js";
import { SessionRuntime } from "../../src/server/interaction/session-runtime.js";
import type { InteractionTransport } from "../../src/server/interaction/transport.js";
import { SessionManagerRegistry } from "../../src/server/management/session-manager.js";

const pane = { socketPath: "/tmp/runtime.sock", paneId: "%1" };
function setup() {
  const bindings = new PaneBindingManager();
  const resolveTarget = vi.fn<InteractionTransport["resolveTarget"]>(async () => null);
  const resolveDirectory = vi.fn(async () => ({ directory: "/project" }));
  const isValidNativeId = vi.fn((_nativeId: string) => true);
  const managers = new SessionManagerRegistry("home").register("home", {
    isValidNativeId,
    resolveDirectory,
    launch: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
    exitSteps: () => [],
  });
  const runtime = new SessionRuntime({ resolveTarget }, managers, bindings);
  const session: DomainSession = {
    id: "session",
    sourceId: "00000000-0000-4000-8000-000000000001",
    archived: false,
    origin: {
      sourceType: "codex",
      home: "home",
      agentName: "Codex",
      agentVersion: null,
      formatVersion: null,
    },
    title: "Session",
    workingDirectory: "/project",
    projectDirectory: "/project",
    createdAt: null,
    updatedAt: null,
    parentId: null,
    childIds: [],
    agent: null,
    messageCount: 0,
    toolCount: 0,
    warningCount: 0,
    diagnostics: [],
    itemCount: 0,
  };
  const bind = (id = "session", time = 1, valid = true) =>
    bindings.submit({
      sessionId: id,
      time,
      ordinal: time,
      position: 0,
      attempt: valid ? { valid: true, ordinal: time, ...pane } : { valid: false, ordinal: time },
    });
  const evaluate = (value = session) => runtime.evaluate(value);
  return {
    isValidNativeId,
    runtime,
    bindings,
    resolveTarget,
    resolveDirectory,
    session,
    bind,
    evaluate,
  };
}

describe("session runtime evidence", () => {
  it("distinguishes live, confirmed death, takeover, absent/invalid bindings and archives", async () => {
    const f = setup();
    expect(await f.evaluate()).toMatchObject({ status: "normal", resume: { allowed: true } });
    f.bind();
    f.resolveTarget.mockResolvedValue(pane);
    expect(await f.evaluate()).toMatchObject({ status: "live", resume: { allowed: false } });
    f.resolveTarget.mockResolvedValue(null);
    expect(await f.evaluate()).toMatchObject({ status: "normal", resume: { allowed: true } });
    f.resolveTarget.mockResolvedValue(pane);
    f.bind("replacement", 2);
    expect(await f.evaluate()).toMatchObject({ status: "normal", resume: { allowed: true } });
    f.bind("session", 3, false);
    expect(await f.evaluate()).toMatchObject({ status: "normal", resume: { allowed: false } });
    expect(await f.evaluate({ ...f.session, archived: true })).toMatchObject({
      status: "archived",
      resume: { allowed: false },
    });
  });

  it("revokes live and resume on a fresh observation error", async () => {
    const f = setup();
    f.bind();
    f.resolveTarget.mockResolvedValue(pane);
    expect((await f.evaluate()).status).toBe("live");
    f.resolveTarget.mockRejectedValue(new Error("timeout"));
    expect(await f.evaluate()).toMatchObject({ status: "normal", resume: { allowed: false } });
  });

  it("delegates non-UUID native identity validation to the owning manager", async () => {
    const sourceId = "native:会话/42%";
    const f = setup();
    f.bind();
    const value = { ...f.session, sourceId };
    expect((await f.evaluate(value)).resume.allowed).toBe(true);
    expect(f.isValidNativeId).toHaveBeenCalledWith(sourceId);
    f.isValidNativeId.mockReturnValue(false);
    expect((await f.evaluate(value)).resume.allowed).toBe(false);
  });

  it("rejects invalid identities and unavailable directories", async () => {
    const f = setup();
    expect((await f.evaluate({ ...f.session, sourceId: "" })).resume.allowed).toBe(false);
    expect((await f.evaluate({ ...f.session, sourceId: null })).resume.allowed).toBe(false);
    expect((await f.evaluate({ ...f.session, sourceId: "   " })).resume.allowed).toBe(false);
    f.resolveDirectory.mockRejectedValue(new Error("ENOENT"));
    expect((await f.evaluate()).resume.allowed).toBe(false);
  });

  it("rejects a binding change while a pane check or directory check is pending", async () => {
    const f = setup();
    f.bind();
    f.resolveTarget.mockImplementationOnce(async () => {
      f.bind("replacement", 2);
      return null;
    });
    expect((await f.evaluate()).resume.allowed).toBe(false);
    f.resolveDirectory.mockImplementationOnce(async () => {
      f.bind("session", 3, false);
      return { directory: "/project" };
    });
    expect((await f.evaluate()).resume.allowed).toBe(false);
  });

  it.each(["shared", "distinct"])(
    "deduplicates panes and bounds %s socket concurrency",
    async (sockets) => {
      const f = setup();
      let active = 0;
      let maximum = 0;
      const releases: (() => void)[] = [];
      const started = Array.from({ length: 21 }, () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        return { promise, resolve };
      });
      let starts = 0;
      f.resolveTarget.mockImplementation(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          started[starts++]!.resolve();
        });
        active--;
        return null;
      });
      const shared = { valid: true as const, ordinal: 1, ...pane };
      const first = f.runtime.probe(shared);
      expect(f.runtime.probe(shared)).toBe(first);
      const batch = Array.from({ length: 20 }, (_, i) =>
        f.runtime.probe({
          ...shared,
          paneId: `%${i + 2}`,
          socketPath: sockets === "shared" ? shared.socketPath : `/socket-${i}`,
        }),
      );
      const width = sockets === "shared" ? 21 : 8;
      for (let offset = 0; offset < 21; offset += width) {
        await started[Math.min(offset + width, 21) - 1]!.promise;
        expect(active).toBe(Math.min(width, 21 - offset));
        releases.splice(0).forEach((release) => release());
      }
      await Promise.all([first, ...batch]);
      expect(maximum).toBe(sockets === "shared" ? 21 : 8);
      expect(f.resolveTarget).toHaveBeenCalledTimes(21);
    },
  );
});

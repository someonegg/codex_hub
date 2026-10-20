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
  const managers = new SessionManagerRegistry("home").register("home", {
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
      sourceInstanceId: "home",
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
  const evaluate = (value = session, all = [value]) => runtime.evaluate(value, all);
  return { runtime, bindings, resolveTarget, resolveDirectory, session, bind, evaluate };
}

describe("session runtime evidence", () => {
  it("distinguishes live, confirmed death, takeover, absent/invalid bindings and archives", async () => {
    const f = setup();
    expect(await f.evaluate()).toMatchObject({ status: "normal", resume: { allowed: false } });
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

  it("rejects invalid identities, duplicate identities in one home and unavailable directories", async () => {
    const f = setup();
    f.bind();
    expect((await f.evaluate({ ...f.session, sourceId: "name" })).resume.allowed).toBe(false);
    expect(
      (await f.evaluate(f.session, [f.session, { ...f.session, id: "duplicate" }])).resume.allowed,
    ).toBe(false);
    expect(
      (
        await f.evaluate(f.session, [
          f.session,
          {
            ...f.session,
            id: "other-home",
            origin: { ...f.session.origin, sourceInstanceId: "other" },
          },
        ])
      ).resume.allowed,
    ).toBe(true);
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
      f.resolveTarget.mockImplementation(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => releases.push(resolve));
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
      for (let i = 0; i < 30; i++) {
        releases.splice(0).forEach((release) => release());
        await Promise.resolve();
      }
      await Promise.all([first, ...batch]);
      expect(maximum).toBe(sockets === "shared" ? 21 : 8);
      expect(f.resolveTarget).toHaveBeenCalledTimes(21);
    },
  );
});

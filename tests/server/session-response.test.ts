import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createCodexSessionSource } from "../../src/server/adapters/codex/codex-session-source.js";
import { SessionReadService } from "../../src/server/application/session-read-service.js";
import { assembleSessionResponse } from "../../src/server/application/session-response.js";
import { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import { PaneBindingManager } from "../../src/server/interaction/pane-binding-manager.js";
import { SessionRuntime } from "../../src/server/interaction/session-runtime.js";
import type { InteractionTransport } from "../../src/server/interaction/transport.js";
import { SessionManagerRegistry } from "../../src/server/management/session-manager.js";
import { SessionUpdatesService } from "../../src/server/updates/session-updates-service.js";
import { createProcessUpdateRevisionFactory } from "../../src/server/updates/update-revision.js";
import { closeAfterEach } from "../helpers/cleanup.js";
import { createTestPreviewListener } from "../helpers/terminal-listener.js";

async function setup() {
  const bindings = new PaneBindingManager();
  const source = await createCodexSessionSource(resolve("tests/fixtures/codex-home"), bindings);
  const reader = new SessionReadService([source], undefined, undefined, {
    diagnosticLogger: { log: () => {} },
  });
  const session = (await reader.list()).sessions.find((item) => item.title === "Synthetic trace")!;
  const initialPage = (await reader.getItems(session.id, { limit: 300 }))!;
  const pane = { socketPath: "/tmp/response.sock", paneId: "%1", sessionName: "response" };
  const resolveTarget = vi.fn<InteractionTransport["resolveTarget"]>().mockResolvedValue(pane);
  const sendKeys = vi.fn<InteractionTransport["sendKeys"]>().mockResolvedValue(undefined);
  const transport = { resolveTarget, sendKeys } as unknown as InteractionTransport;
  const resolveDirectory = vi.fn(async () => ({ directory: "/project" }));
  const manager = {
    isValidNativeId: () => true,
    resolveDirectory,
    launch: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
    exitSteps: () => [],
  };
  const managers = new SessionManagerRegistry(source.descriptor.home).register(
    source.descriptor.home,
    manager,
  );
  const runtime = new SessionRuntime(transport, managers, bindings);
  reader.runtime = runtime;
  const interaction = closeAfterEach(
    new SessionInteractionService(reader, true, transport, bindings, createTestPreviewListener()),
  );
  interaction.runtime = runtime;
  const updates = new SessionUpdatesService(reader, { interaction });
  const bind = (valid = true, ordinal = 1) =>
    bindings.submit({
      sessionId: session.id,
      time: Date.now() + ordinal,
      ordinal,
      position: 0,
      attempt: valid ? { valid: true, ordinal, ...pane } : { valid: false, ordinal },
    });
  bind();
  return {
    reader,
    interaction,
    updates,
    runtime,
    session,
    initialPage,
    pane,
    bind,
    resolveTarget,
    resolveDirectory,
    sendKeys,
    close: () => {
      updates.close();
      interaction.close();
    },
  };
}

const revision = createProcessUpdateRevisionFactory(Buffer.alloc(32, 1));

describe("request-scoped session responses", () => {
  it.each(["metadata", "items", "updates"] as const)(
    "uses one pane observation for %s and keeps internal facts out of the response",
    async (kind) => {
      const f = await setup();
      try {
        const response =
          kind === "updates"
            ? await f.updates.wait(f.session.id, {
                cursor: f.initialPage.cursor,
                after: "different" as never,
              })
            : await assembleSessionResponse(
                (kind === "metadata"
                  ? await f.reader.getSession(f.session.id)
                  : await f.reader.getItems(f.session.id, { limit: 300 }))!,
                f.interaction,
                revision,
              );
        expect(f.resolveTarget).toHaveBeenCalledTimes(1);
        expect(response).toMatchObject({
          session: { status: "live", resume: { allowed: false } },
          interaction: { supported: true, activity: "unknown", state: "connected" },
          updateRevision: expect.any(String),
        });
        expect(response).not.toHaveProperty("interactionSession");
        expect(JSON.stringify(response)).not.toContain('"observation"');
      } finally {
        f.close();
      }
    },
  );

  it("makes fresh observations for subsequent reads and input operations", async () => {
    const f = await setup();
    try {
      await assembleSessionResponse(
        (await f.reader.getSession(f.session.id))!,
        f.interaction,
        revision,
      );
      expect(f.resolveTarget).toHaveBeenCalledTimes(1);
      await f.interaction.sendKeys(f.session.id, ["enter"]);
      expect(f.resolveTarget).toHaveBeenCalledTimes(2);
      expect(f.sendKeys).toHaveBeenCalledTimes(1);
      f.resolveTarget.mockResolvedValue(null);
      const next = await assembleSessionResponse(
        (await f.reader.getSession(f.session.id))!,
        f.interaction,
        revision,
      );
      expect(f.resolveTarget).toHaveBeenCalledTimes(3);
      expect(next).toMatchObject({
        session: { status: "normal", resume: { allowed: true } },
        interaction: { state: "disconnected" },
      });
    } finally {
      f.close();
    }
  });

  it("revokes resume when binding changes after directory validation and before assembly", async () => {
    const f = await setup();
    try {
      f.resolveTarget.mockResolvedValue(null);
      const input = (await f.reader.getSession(f.session.id))!;
      expect(input.session.resume.allowed).toBe(true);
      f.bind(false, 2);
      const response = await assembleSessionResponse(input, f.interaction, revision);
      expect(response).toMatchObject({
        session: { status: "normal", resume: { allowed: false } },
        interaction: { state: "unknown" },
      });
      expect(f.resolveTarget).toHaveBeenCalledTimes(1);
    } finally {
      f.close();
    }
  });

  it("does not turn observation errors into evidence of pane death", async () => {
    const f = await setup();
    try {
      f.resolveTarget.mockRejectedValue(new Error("timeout"));
      const response = await assembleSessionResponse(
        (await f.reader.getSession(f.session.id))!,
        f.interaction,
        revision,
      );
      expect(response).toMatchObject({
        session: { status: "normal", resume: { allowed: false } },
        interaction: { state: "unknown" },
      });
      expect(f.resolveTarget).toHaveBeenCalledTimes(1);
      expect(f.resolveDirectory).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
});

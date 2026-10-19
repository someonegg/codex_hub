import { appendFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, expect, it, vi } from "vitest";

import { createCodexSessionSource } from "../../src/server/adapters/codex/codex-session-source.js";
import { SessionReadService } from "../../src/server/application/session-read-service.js";
import { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import {
  PaneBindingManager,
  paneBindings,
} from "../../src/server/interaction/pane-binding-manager.js";
import type { InteractionTransport } from "../../src/server/interaction/transport.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

let bindings: PaneBindingManager;
beforeEach(() => {
  bindings = new PaneBindingManager();
});

function line(value: object): string {
  return `${JSON.stringify(value)}\n`;
}
function shell(socket: string, pane: string): string {
  return `<user_shell_command>\nCODEX_HUB_TMUX_BIND_V3\n${socket}\n${pane}\n</user_shell_command>`;
}
function message(time: number, text: string): string {
  return line({
    timestamp: `2026-10-17T00:00:0${time}Z`,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
}

it.each([false, true])(
  "shares claims across Codex instances and preserves takeover facts through archive/delete (reverse=%s)",
  async (reverse) => {
    const root = await createTempDirectory("pane-bindings-");
    const socket = join(root, "shared.sock");
    const homes = [join(root, "one"), join(root, "two")];
    for (const home of homes) {
      await mkdir(join(home, "sessions"), { recursive: true });
      await mkdir(join(home, "archived_sessions"));
    }
    const fileA = join(homes[0]!, "sessions", "rollout-a.jsonl");
    const fileC = join(homes[1]!, "sessions", "rollout-c.jsonl");
    const meta = line({ type: "session_meta", payload: { id: "same-native-id", cwd: root } });
    await writeFile(fileA, meta + message(1, shell(socket, "%1")));
    // Both claims occur in a single record; only the last is C's current binding.
    await writeFile(fileC, meta + message(2, shell(socket, "%1") + "\n" + shell(socket, "%2")));
    const sources = await Promise.all(
      homes.map((home) => createCodexSessionSource(home, bindings)),
    );
    const sessions = new SessionReadService(reverse ? [...sources].reverse() : sources);
    const transport = {
      connect: vi.fn(async (attempt) => attempt),
      resolveTarget: vi.fn(async (attempt) => attempt),
      sendMessage: vi.fn(),
      sendKeys: vi.fn(),
      captureTerminal: vi.fn(),
      inspect: vi.fn(),
      killPane: vi.fn(),
    } satisfies InteractionTransport;
    const service = new SessionInteractionService(sessions, true, transport, bindings);
    const catalog = (await sessions.list()).sessions;
    expect(catalog).toHaveLength(2);
    for (const item of catalog) expect(paneBindings.latest(item.id)).toBeNull();
    const idFor = async (pane: string) => {
      for (const item of catalog) {
        const attempt = bindings.latest(item.id);
        if (attempt?.valid && attempt.paneId === pane) return item.id;
      }
      throw new Error("Missing session");
    };
    const a = await idFor("%1");
    const c = await idFor("%2");
    expect(a).not.toBe(c);
    expect(await service.describe(a)).toMatchObject({
      state: "superseded",
      supersededBySessionId: c,
    });
    expect(await service.resolveTarget(a)).toBeNull();
    expect(transport.resolveTarget).not.toHaveBeenCalled();
    for (const action of [
      () => service.sendMessage(a, "hello"),
      () => service.sendKeys(a, ["enter"]),
      () => service.preview(a),
      () => service.handoffPaneBinding(a),
    ]) {
      await expect(action()).rejects.toMatchObject({ code: "interaction_not_connected" });
    }
    await appendFile(fileA, message(9, "ordinary message"));
    await sessions.refresh();
    await sessions.refresh();
    expect(await service.describe(a)).toMatchObject({ state: "superseded" });
    const archived = join(homes[1]!, "archived_sessions", "rollout-c.jsonl");
    await rename(fileC, archived);
    await sessions.refresh();
    expect(await service.describe(a)).toMatchObject({
      state: "superseded",
      supersededBySessionId: c,
    });
    await unlink(archived);
    await sessions.refresh();
    expect(await service.describe(a)).toMatchObject({
      state: "superseded",
      supersededBySessionId: null,
    });
    await appendFile(fileA, message(3, shell(socket, "%1")));
    await sessions.refresh();
    expect(await service.describe(a)).toMatchObject({ state: "connected" });
    await appendFile(fileA, message(4, shell("invalid", "%1")));
    await sessions.refresh();
    expect(await service.describe(a)).toMatchObject({ state: "disconnected" });
  },
);

it("consumes late-arriving older binds for their pane without changing the session's newer binding", async () => {
  const home = await createTempDirectory("pane-binding-batches-");
  const socket = join(home, "shared.sock");
  await mkdir(join(home, "sessions"));
  const aFile = join(home, "sessions", "rollout-a.jsonl");
  const cFile = join(home, "sessions", "rollout-c.jsonl");
  await writeFile(
    aFile,
    line({ type: "session_meta", payload: { id: "a", cwd: home } }) +
      message(1, shell(socket, "%1")),
  );
  await writeFile(
    cFile,
    line({ type: "session_meta", payload: { id: "c", cwd: home } }) +
      message(3, shell(socket, "%2")),
  );
  const source = await createCodexSessionSource(home, bindings);
  const sessions = new SessionReadService([source]);
  const catalog = (await sessions.managementSnapshot()).sessions;
  const a = catalog.find((item) => item.sourceId === "a")!.id;
  const c = catalog.find((item) => item.sourceId === "c")!.id;
  const transport = {
    connect: vi.fn(async (attempt) => attempt),
  } as unknown as InteractionTransport;
  const service = new SessionInteractionService(sessions, true, transport, bindings);
  expect(await service.describe(a)).toMatchObject({ state: "connected" });
  await appendFile(cFile, message(2, shell(socket, "%1")));
  await sessions.refresh();
  expect(await service.describe(a)).toMatchObject({
    state: "superseded",
    supersededBySessionId: c,
  });
  expect(bindings.latest(c)).toMatchObject({
    paneId: "%2",
  });
  expect(await service.describe(c)).toMatchObject({ state: "connected" });
  // A forced full decode must produce the same result as the append path.
  const rebuilt = new SessionReadService([await createCodexSessionSource(home, bindings)]);
  const rebuiltService = new SessionInteractionService(rebuilt, true, transport, bindings);
  expect(await rebuiltService.describe(a)).toMatchObject({
    state: "superseded",
    supersededBySessionId: c,
  });
});

it("keeps the accepted duplicate, ignores its competitors' claims, and fully loads the first replacement", async () => {
  const home = await createTempDirectory("duplicate-rollouts-");
  await mkdir(join(home, "sessions"));
  const a = join(home, "sessions/rollout-a.jsonl");
  const b = join(home, "sessions/rollout-b.jsonl");
  const c = join(home, "sessions/rollout-c.jsonl");
  const meta = (title: string) =>
    line({ type: "session_meta", payload: { id: "duplicate", title, cwd: home } });
  const socket = join(home, "shared.sock");
  await writeFile(b, meta("B") + message(1, shell(socket, "%1")));
  await writeFile(c, meta("C") + message(9, shell(socket, "%3")));
  const source = await createCodexSessionSource(home, bindings);
  const log = vi.fn();
  const sessions = new SessionReadService([source], undefined, undefined, {
    diagnosticLogger: { log },
  });
  const initial = (await sessions.managementSnapshot()).sessions;
  expect(initial).toHaveLength(1);
  expect(initial[0]!.title).toBe("B");
  const id = initial[0]!.id;
  expect(bindings.latest(id)).toMatchObject({ paneId: "%1" });
  expect(
    log.mock.calls.filter(([item]) => item.code === "duplicate_native_session_id"),
  ).toHaveLength(1);
  await sessions.refresh();
  // The accepted file is cached, but ignored files have no decode checkpoint.
  expect(source.lastRefreshTelemetry()).toMatchObject({ fullFiles: 1, appendFiles: 0 });
  expect(
    log.mock.calls.filter(([item]) => item.code === "duplicate_native_session_id"),
  ).toHaveLength(1);
  await writeFile(a, meta("A") + message(2, shell(socket, "%2")));
  await appendFile(c, message(9, shell(socket, "%4")));
  await sessions.refresh();
  expect((await sessions.managementSnapshot()).sessions).toMatchObject([{ id, title: "B" }]);
  expect(bindings.latest(id)).toMatchObject({ paneId: "%1" });
  expect(source.lastRefreshTelemetry()).toMatchObject({ fullFiles: 2, appendFiles: 0 });
  expect(
    log.mock.calls.filter(([item]) => item.code === "duplicate_native_session_id"),
  ).toHaveLength(1);
  await unlink(b);
  await sessions.refresh();
  expect(source.lastRefreshTelemetry()).toMatchObject({ fullFiles: 2, appendFiles: 0 });
  expect((await sessions.managementSnapshot()).sessions).toMatchObject([{ id, title: "A" }]);
  expect(bindings.latest(id)).toMatchObject({ paneId: "%2" });
  await appendFile(a, message(3, shell(socket, "%5")));
  await sessions.refresh();
  expect(source.lastRefreshTelemetry()).toMatchObject({ fullFiles: 1, appendFiles: 1 });
  expect(bindings.latest(id)).toMatchObject({ paneId: "%5" });
  await unlink(c);
  await sessions.refresh();
  await writeFile(c, meta("C") + message(9, shell(socket, "%3")));
  await sessions.refresh();
  expect(
    log.mock.calls.filter(([item]) => item.code === "duplicate_native_session_id"),
  ).toHaveLength(2);
});

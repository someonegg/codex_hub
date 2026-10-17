import { describe, expect, it, vi } from "vitest";

import { CODEX_INTERACTION_KEY_BINDINGS } from "../../src/server/adapters/codex/interaction-parser.js";
import type {
  InteractionSessionSnapshot,
  SessionReader,
} from "../../src/server/application/session-reader.js";
import { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import { TmuxInteractionService } from "../../src/server/interaction/tmux-service.js";
import { InteractionTransportError } from "../../src/server/interaction/transport.js";

function repository(snapshot: InteractionSessionSnapshot | null): SessionReader {
  return {
    list: vi.fn(),
    getSession: vi.fn(),
    getItems: vi.fn(),
    getLiveSession: vi.fn(),
    getToolDetail: vi.fn(),
    getDirectiveDetail: vi.fn(),
    getInternalDetail: vi.fn(),
    getInteractionSession: vi.fn().mockResolvedValue(snapshot),
    refresh: vi.fn(),
  };
}

function session(archived = false): InteractionSessionSnapshot {
  return {
    archived,
    interaction: {
      bindingAttempt: null,
      transport: "tmux",
      rebindCommand: "! bind",
      keyBindings: CODEX_INTERACTION_KEY_BINDINGS,
    },
  };
}

function boundSession(): InteractionSessionSnapshot {
  return {
    archived: false,
    interaction: {
      bindingAttempt: {
        ordinal: 4,
        valid: true,
        socketPath: "/tmp/codex-hub.sock",
        paneId: "%7",
      },
      transport: "tmux",
      rebindCommand: "! bind",
      keyBindings: CODEX_INTERACTION_KEY_BINDINGS,
    },
  };
}

describe("session interaction policy", () => {
  it("is unsupported when disabled or archived", async () => {
    expect(
      await new SessionInteractionService(
        repository(session()),
        false,
        new TmuxInteractionService(),
      ).describe("session"),
    ).toEqual({ supported: false, attachCommand: null });
    expect(
      await new SessionInteractionService(
        repository(session(true)),
        true,
        new TmuxInteractionService(),
      ).describe("session"),
    ).toEqual({ supported: false, attachCommand: null });
  });

  it("reports unbound and rejects actions before transport", async () => {
    const service = new SessionInteractionService(
      repository(session()),
      true,
      new TmuxInteractionService(),
    );
    expect(await service.describe("session")).toEqual({
      supported: true,
      attachCommand: null,
      state: "unbound",
    });
    await expect(service.sendMessage("session", "hello")).rejects.toMatchObject({
      code: "interaction_not_connected",
    });
    await expect(service.rebind("session")).rejects.toMatchObject({
      code: "interaction_not_connected",
    });
    await expect(service.sendKeys("session", ["interrupt"])).rejects.toMatchObject({
      code: "interaction_not_connected",
    });
  });

  it("allows all actions whenever the pane is connected", async () => {
    const binding = {
      socketPath: "/tmp/codex-hub.sock",
      paneId: "%7",
    };
    const tmux = {
      connect: vi.fn().mockResolvedValue(binding),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendKeys: vi.fn().mockResolvedValue(undefined),
      captureTerminal: vi.fn().mockResolvedValue({
        content: "recent output",
        truncated: false,
      }),
    } as unknown as TmuxInteractionService;
    const service = new SessionInteractionService(repository(boundSession()), true, tmux);

    await expect(service.describe("session")).resolves.toEqual({
      supported: true,
      attachCommand: null,
      state: "connected",
    });
    await service.sendMessage("session", "hello");
    await service.rebind("session");
    await service.sendKeys("session", [
      "enter",
      "up",
      "down",
      "left",
      "right",
      "interrupt",
      "plan",
    ]);
    await expect(service.preview("session")).resolves.toEqual({
      content: "recent output",
      truncated: false,
      capturedAt: expect.any(String),
    });
    expect(tmux.sendMessage).toHaveBeenCalledWith(binding, "hello", expect.any(Function));
    expect(tmux.sendMessage).toHaveBeenCalledWith(binding, "! bind", expect.any(Function));
    expect(tmux.sendKeys).toHaveBeenCalledWith(
      binding,
      ["Enter", "Up", "Down", "Left", "Right", "C-c", "BTab"],
      expect.any(Function),
    );
    expect(tmux.captureTerminal).toHaveBeenCalledWith(binding);
  });
});

it("refreshes connection status after each completed query", async () => {
  const tmux = {
    connect: vi
      .fn()
      .mockRejectedValueOnce(new InteractionTransportError("disconnected", "gone"))
      .mockResolvedValue({ paneId: "%7" }),
  } as unknown as TmuxInteractionService;
  const service = new SessionInteractionService(repository(boundSession()), true, tmux);
  expect(await service.describe("session")).toMatchObject({ state: "disconnected" });
  expect(await service.describe("session")).toMatchObject({ state: "connected" });
  expect(tmux.connect).toHaveBeenCalledTimes(2);
});

it("bypasses stale connection checks for archive and rejects input while busy", async () => {
  const reader = repository(boundSession());
  const binding = {
    socketPath: "/tmp/codex-hub.sock",
    paneId: "%7",
    sessionName: "codex-hub-test",
  };
  const tmux = {
    connect: vi.fn().mockResolvedValue(binding),
    archiveTarget: vi.fn().mockResolvedValue(null),
    sendMessage: vi.fn(),
    sendKeys: vi.fn(),
  } as unknown as TmuxInteractionService;
  const service = new SessionInteractionService(reader, true, tmux);
  expect(await service.describe("session")).toMatchObject({
    state: "connected",
    attachCommand: "tmux -S '/tmp/codex-hub.sock' attach-session -t 'codex-hub-test'",
  });
  expect(await service.archiveTarget("session")).toBeNull();
  expect(tmux.archiveTarget).toHaveBeenCalledOnce();
  expect(reader.getInteractionSession).toHaveBeenCalledTimes(2);
  expect(tmux.connect).toHaveBeenCalledOnce();
  service.setBusy("session", true);
  await expect(service.sendMessage("session", "hello")).rejects.toMatchObject({
    code: "session_busy",
  });
  await expect(service.sendKeys("session", ["enter"])).rejects.toMatchObject({
    code: "session_busy",
  });
  expect(tmux.sendMessage).not.toHaveBeenCalled();
  expect(tmux.sendKeys).not.toHaveBeenCalled();
  service.setBusy("session", false);
  await service.sendMessage("session", "hello");
  expect(tmux.sendMessage).toHaveBeenCalledOnce();
});

it.each([
  ["disconnected", "interaction_not_connected"],
  ["timeout", "operation_result_unknown"],
  ["command_failed", "interaction_failed"],
] as const)("translates rebind transport failure %s without retry", async (transportCode, code) => {
  const tmux = {
    connect: vi.fn().mockResolvedValue({ socketPath: "/tmp/codex-hub.sock", paneId: "%7" }),
    sendMessage: vi.fn().mockRejectedValue(new InteractionTransportError(transportCode, "failed")),
  } as unknown as TmuxInteractionService;
  const service = new SessionInteractionService(repository(boundSession()), true, tmux);
  await expect(service.rebind("session")).rejects.toMatchObject({ code });
  expect(tmux.sendMessage).toHaveBeenCalledOnce();
});

it("rejects rebind for missing sessions and while management is busy", async () => {
  const tmux = { connect: vi.fn(), sendMessage: vi.fn() } as unknown as TmuxInteractionService;
  const missing = new SessionInteractionService(repository(null), true, tmux);
  await expect(missing.rebind("session")).rejects.toMatchObject({ code: "session_not_found" });
  const busy = new SessionInteractionService(repository(boundSession()), true, tmux);
  busy.setBusy("session", true);
  await expect(busy.rebind("session")).rejects.toMatchObject({ code: "session_busy" });
  expect(tmux.sendMessage).not.toHaveBeenCalled();
});

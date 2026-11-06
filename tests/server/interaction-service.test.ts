import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_KEY_BINDINGS as CODEX_INTERACTION_KEY_BINDINGS,
  interruptSteps as codexInterruptSteps,
} from "../../src/server/adapters/shared/session-management.js";
import type {
  InteractionSessionSnapshot,
  SessionReader,
} from "../../src/server/application/session-reader.js";
import { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import { PaneBindingManager } from "../../src/server/interaction/pane-binding-manager.js";
import { TmuxInteractionService } from "../../src/server/interaction/tmux-service.js";
import { InteractionTransportError } from "../../src/server/interaction/transport.js";

let bindings: PaneBindingManager;
const SESSION_NAME = "ahub-00000000-0000-0000-0000-000000000007";
const BINDING = { socketPath: "/tmp/ahub.sock", sessionName: SESSION_NAME };
const services: SessionInteractionService[] = [];
afterEach(() => services.splice(0).forEach((service) => service.close()));
beforeEach(() => {
  bindings = new PaneBindingManager();
});

class TestSessionInteractionService extends SessionInteractionService {
  constructor(reader: SessionReader, enabled: boolean, tmux: TmuxInteractionService) {
    super(reader, tmux, {
      enabled,
      bindings,
      listener: () => ({ ready: Promise.resolve(), close() {} }),
    });
    services.push(this);
  }
}

function repository(snapshot: InteractionSessionSnapshot | null): SessionReader {
  return {
    list: vi.fn(),
    getSession: vi.fn(),
    messages: async () => null,
    readMessages: async () => null,
    getInteractionSession: vi.fn().mockResolvedValue(snapshot),
    refresh: vi.fn(),
  };
}

function session(archived = false): InteractionSessionSnapshot {
  return {
    archived,
    interaction: {
      transport: "tmux",
      bindingCommand: "! bind",
      keyBindings: CODEX_INTERACTION_KEY_BINDINGS,
      interruptSteps: codexInterruptSteps,
    },
  };
}

function boundSession(): InteractionSessionSnapshot {
  bindings.submit({
    sessionId: "session",
    time: 0,
    ordinal: 4,
    position: 0,
    attempt: { ordinal: 4, valid: true, ...BINDING },
  });
  return session();
}

describe("session interaction policy", () => {
  it("is unsupported when disabled or archived", async () => {
    expect(
      await new TestSessionInteractionService(
        repository(session()),
        false,
        new TmuxInteractionService(),
      ).describe("session"),
    ).toEqual({ supported: false, tmux: null, attachCommand: null });
    expect(
      await new TestSessionInteractionService(
        repository(session(true)),
        true,
        new TmuxInteractionService(),
      ).describe("session"),
    ).toEqual({ supported: false, tmux: null, attachCommand: null });
  });

  it("reports unbound and rejects actions before transport", async () => {
    const service = new TestSessionInteractionService(
      repository(session()),
      true,
      new TmuxInteractionService(),
    );
    expect(await service.describe("session")).toEqual({
      supported: true,
      tmux: null,
      activity: null,
      supersededBySessionId: null,
      attachCommand: null,
      state: "unbound",
    });
    await expect(service.sendMessage("session", "hello")).rejects.toMatchObject({
      code: "interaction_not_connected",
    });
    await expect(service.handoffPaneBinding("session")).rejects.toMatchObject({
      code: "interaction_not_connected",
    });
    await expect(service.sendKeys("session", ["interrupt"])).rejects.toMatchObject({
      code: "interaction_not_connected",
    });
  });

  it("allows all actions whenever the pane is connected", async () => {
    const binding = BINDING;
    const tmux = {
      connect: vi.fn().mockResolvedValue(binding),
      resolveTarget: vi.fn().mockResolvedValue(binding),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendKeys: vi.fn().mockResolvedValue(undefined),
      captureTerminal: vi.fn().mockResolvedValue({
        content: "recent output",
        truncated: false,
      }),
    } as unknown as TmuxInteractionService;
    const service = new TestSessionInteractionService(repository(boundSession()), true, tmux);

    await expect(service.describe("session")).resolves.toEqual({
      supported: true,
      tmux: binding,
      activity: "unknown",
      supersededBySessionId: null,
      attachCommand: `tmux -S '/tmp/ahub.sock' attach-session -t '=${SESSION_NAME}:'`,
      state: "connected",
    });
    await service.sendMessage("session", "hello");
    await service.handoffPaneBinding("session");
    await service.sendKeys("session", [
      "enter",
      "up",
      "down",
      "left",
      "right",
      "interrupt",
      "BTab",
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    const frame = vi.fn();
    const failure = vi.fn();
    await service.subscribePreview("session", frame, failure, new AbortController().signal);
    await vi.waitFor(() => expect(frame).toHaveBeenCalled());
    expect(frame).toHaveBeenCalledWith({
      type: "snapshot",
      content: "recent output",
      truncated: false,
      capturedAt: expect.any(String),
      revision: expect.any(String),
    });
    expect(tmux.sendMessage).toHaveBeenCalledWith(binding, "hello", expect.any(Function));
    expect(tmux.sendMessage).toHaveBeenCalledWith(binding, "! bind", expect.any(Function));
    expect(tmux.sendKeys).toHaveBeenCalledWith(
      binding,
      [
        ...(["Enter", "Up", "Down", "Left", "Right"] as const).map((key) => ({
          keys: [key],
          delayMs: 0,
        })),
        ...codexInterruptSteps(),
        { keys: ["BTab"], delayMs: 0 },
        ...(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const).map((key) => ({
          keys: [key],
          delayMs: 0,
        })),
      ],
      expect.any(Function),
    );
    expect(tmux.captureTerminal).toHaveBeenCalledWith(binding, expect.any(Function));
  });
});

it("uses the adapter interrupt capability and preserves repeated interrupt ordering", async () => {
  const snapshot = boundSession();
  const interruptSteps = vi.fn(codexInterruptSteps);
  const tmux = {
    connect: vi.fn().mockResolvedValue(BINDING),
    resolveTarget: vi.fn().mockResolvedValue(BINDING),
    sendKeys: vi.fn().mockResolvedValue(undefined),
  } as unknown as TmuxInteractionService;
  const service = new TestSessionInteractionService(
    repository({
      ...snapshot,
      interaction: { ...snapshot.interaction!, interruptSteps },
    }),
    true,
    tmux,
  );

  await service.sendKeys("session", ["interrupt", "interrupt", "enter"]);

  expect(interruptSteps).toHaveBeenCalledTimes(2);
  expect(tmux.sendKeys).toHaveBeenCalledExactlyOnceWith(
    expect.any(Object),
    [...codexInterruptSteps(), ...codexInterruptSteps(), { keys: ["Enter"], delayMs: 0 }],
    expect.any(Function),
  );
});

it("refreshes connection status after each completed query", async () => {
  const tmux = {
    connect: vi
      .fn()
      .mockRejectedValueOnce(new InteractionTransportError("disconnected", "gone"))
      .mockResolvedValue(BINDING),
  } as unknown as TmuxInteractionService;
  const service = new TestSessionInteractionService(repository(boundSession()), true, tmux);
  expect(await service.describe("session")).toMatchObject({ state: "disconnected", tmux: null });
  expect(await service.describe("session")).toMatchObject({ state: "connected" });
  expect(tmux.connect).toHaveBeenCalledTimes(2);
});

it("freshly resolves management targets and rejects input while busy", async () => {
  const reader = repository(boundSession());
  const binding = BINDING;
  const tmux = {
    connect: vi.fn().mockResolvedValue(binding),
    resolveTarget: vi.fn().mockResolvedValue(null),
    sendMessage: vi.fn(),
    sendKeys: vi.fn(),
  } as unknown as TmuxInteractionService;
  const service = new TestSessionInteractionService(reader, true, tmux);
  expect(await service.describe("session")).toMatchObject({
    state: "connected",
    attachCommand: `tmux -S '/tmp/ahub.sock' attach-session -t '=${SESSION_NAME}:'`,
  });
  expect(await service.resolveTarget("session")).toBeNull();
  expect(tmux.resolveTarget).toHaveBeenCalledOnce();
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
] as const)(
  "translates handoffPaneBinding transport failure %s without retry",
  async (transportCode, code) => {
    const tmux = {
      connect: vi.fn().mockResolvedValue(BINDING),
      sendMessage: vi
        .fn()
        .mockRejectedValue(new InteractionTransportError(transportCode, "failed")),
    } as unknown as TmuxInteractionService;
    const service = new TestSessionInteractionService(repository(boundSession()), true, tmux);
    await expect(service.handoffPaneBinding("session")).rejects.toMatchObject({ code });
    expect(tmux.sendMessage).toHaveBeenCalledOnce();
  },
);

it("rejects handoffPaneBinding for missing sessions and while management is busy", async () => {
  const tmux = { connect: vi.fn(), sendMessage: vi.fn() } as unknown as TmuxInteractionService;
  const missing = new TestSessionInteractionService(repository(null), true, tmux);
  await expect(missing.handoffPaneBinding("session")).rejects.toMatchObject({
    code: "session_not_found",
  });
  const busy = new TestSessionInteractionService(repository(boundSession()), true, tmux);
  busy.setBusy("session", true);
  await expect(busy.handoffPaneBinding("session")).rejects.toMatchObject({ code: "session_busy" });
  expect(tmux.sendMessage).not.toHaveBeenCalled();
});

it.each(["message", "keys", "preview", "handoffPaneBinding", "exit", "kill"] as const)(
  "rechecks ownership immediately before queued %s executes",
  async (action) => {
    const reader = repository(boundSession());
    const target = BINDING;
    let execute!: () => void;
    const queue = (check?: () => void) =>
      new Promise<void>((resolve, reject) => {
        execute = () => {
          try {
            check?.();
            resolve();
          } catch (error) {
            reject(error);
          }
        };
      });
    const tmux = {
      connect: vi.fn().mockResolvedValue(target),
      resolveTarget: vi.fn().mockResolvedValue(target),
      sendMessage: vi.fn((_target, _message, check) => queue(check)),
      sendKeys: vi.fn((_target, _keys, check) => queue(check)),
      killSession: vi.fn((_target, check) => queue(check)),
      captureTerminal: vi.fn((_target, check) =>
        queue(check).then(() => ({ content: "pane", truncated: false })),
      ),
    } as unknown as TmuxInteractionService;
    const service = new TestSessionInteractionService(reader, true, tmux);
    const operation =
      action === "message"
        ? service.sendMessage("session", "hello")
        : action === "keys"
          ? service.sendKeys("session", ["enter"])
          : action === "preview"
            ? new Promise<void>((resolve, reject) => {
                void service
                  .subscribePreview(
                    "session",
                    () => resolve(),
                    reject,
                    new AbortController().signal,
                  )
                  .catch(reject);
              })
            : action === "handoffPaneBinding"
              ? service.handoffPaneBinding("session")
              : action === "kill"
                ? service.killTarget(target, "session", () => {})
                : service.sendExitKeys(target, "session", ["C-c"], () => {});
    const rejected = expect(operation).rejects.toMatchObject({ code: "interaction_not_connected" });
    await vi.waitFor(() => expect(execute).toBeTypeOf("function"));
    bindings.submit({
      sessionId: "replacement",
      time: 1,
      ordinal: 1,
      position: 0,
      attempt: { valid: true, ordinal: 1, ...target },
    });
    execute();
    await rejected;
  },
);

it("rechecks management target ownership after validation", async () => {
  const reader = repository(boundSession());
  const target = BINDING;
  const tmux = {
    resolveTarget: vi.fn(async () => {
      bindings.submit({
        sessionId: "replacement",
        time: 1,
        ordinal: 1,
        position: 0,
        attempt: { valid: true, ordinal: 1, ...target },
      });
      return target;
    }),
  } as unknown as TmuxInteractionService;
  expect(
    await new TestSessionInteractionService(reader, true, tmux).resolveTarget("session"),
  ).toBeNull();
});

it.each([false, true])(
  "does not retry status validation when the binding changes (failure=%s)",
  async (failure) => {
    const reader = repository(boundSession());
    const tmux = {
      connect: vi.fn(async () => {
        bindings.submit({
          sessionId: "session",
          time: 1,
          ordinal: 5,
          position: 0,
          attempt: {
            ordinal: 5,
            valid: true,
            socketPath: "/tmp/new.sock",
            sessionName: "ahub-00000000-0000-0000-0000-000000000008",
          },
        });
        if (failure) throw new Error("query failed");
        return {
          socketPath: "/tmp/ahub.sock",
          sessionName: SESSION_NAME,
        };
      }),
    } as unknown as TmuxInteractionService;
    expect(
      await new TestSessionInteractionService(reader, true, tmux).describe("session"),
    ).toMatchObject({ state: "unknown", tmux: null, attachCommand: null });
    expect(tmux.connect).toHaveBeenCalledOnce();
  },
);

it("does not recurse when a replacement changes during lookup", async () => {
  const reader = repository(boundSession());
  const target = BINDING;
  bindings.submit({
    sessionId: "replacement",
    time: 1,
    ordinal: 1,
    position: 0,
    attempt: { ordinal: 1, valid: true, ...target },
  });
  vi.mocked(reader.getInteractionSession).mockImplementation(async (id) => {
    if (id === "replacement")
      bindings.submit({
        sessionId: "session",
        time: 2,
        ordinal: 5,
        position: 0,
        attempt: { ordinal: 5, valid: true, ...target },
      });
    return session();
  });
  const tmux = { connect: vi.fn().mockResolvedValue(target) } as unknown as TmuxInteractionService;
  expect(
    await new TestSessionInteractionService(reader, true, tmux).describe("session"),
  ).toMatchObject({ state: "unknown", tmux: null });
  expect(reader.getInteractionSession).toHaveBeenCalledTimes(2);
  expect(tmux.connect).toHaveBeenCalledOnce();
});

it.each(["present", "missing", "error", "replacement missing", "binding changed"])(
  "validates superseded pane: %s",
  async (scenario) => {
    const reader = repository(boundSession());
    const target = BINDING;
    bindings.submit({
      sessionId: "replacement",
      time: 1,
      ordinal: 1,
      position: 0,
      attempt: { valid: true, ordinal: 1, ...target },
    });
    if (scenario === "replacement missing")
      vi.mocked(reader.getInteractionSession).mockImplementation(async (id) =>
        id === "replacement" ? null : session(),
      );
    const tmux = {
      connect: vi.fn(async () => {
        if (scenario === "missing") throw new InteractionTransportError("disconnected", "gone");
        if (scenario === "error") throw new Error("failed");
        if (scenario === "binding changed")
          bindings.submit({
            sessionId: "session",
            time: 2,
            ordinal: 6,
            position: 0,
            attempt: { valid: true, ordinal: 6, ...target },
          });
        return target;
      }),
    } as unknown as TmuxInteractionService;
    const service = new TestSessionInteractionService(reader, true, tmux);
    expect(await service.describe("session")).toMatchObject({
      state:
        scenario === "missing"
          ? "disconnected"
          : scenario === "error" || scenario === "binding changed"
            ? "unknown"
            : "superseded",
      tmux: null,
      supersededBySessionId: scenario === "present" ? "replacement" : null,
    });
    expect(tmux.connect).toHaveBeenCalledOnce();
    if (scenario !== "binding changed")
      await expect(service.sendKeys("session", ["enter"])).rejects.toMatchObject({
        code: "interaction_not_connected",
      });
  },
);

it("rejects an exit observation when ownership changes while querying pane liveness", async () => {
  const reader = repository(boundSession());
  const target = BINDING;
  let resolve!: (state: "exited") => void;
  const tmux = {
    inspect: vi.fn(
      () =>
        new Promise<"exited">((done) => {
          resolve = done;
        }),
    ),
  } as unknown as TmuxInteractionService;
  const service = new TestSessionInteractionService(reader, true, tmux);
  const observation = service.inspectTarget(target, "session");
  const rejected = expect(observation).rejects.toMatchObject({ code: "interaction_not_connected" });
  bindings.submit({
    sessionId: "replacement",
    time: 1,
    ordinal: 1,
    position: 0,
    attempt: { valid: true, ordinal: 1, ...target },
  });
  resolve("exited");
  await rejected;
});

it.each([
  {
    change: "takeover",
    sessionId: "other",
    sessionName: SESSION_NAME,
    valid: true,
  },
  {
    change: "different pane",
    sessionId: "session",
    sessionName: "ahub-00000000-0000-0000-0000-000000000008",
    valid: true,
  },
  {
    change: "invalid",
    sessionId: "session",
    sessionName: SESSION_NAME,
    valid: false,
  },
])(
  "keeps duplicate bindings streaming and permanently closes the old preview on $change",
  async ({ change, ...target }) => {
    vi.useFakeTimers();
    const snapshot = boundSession();
    const binding = BINDING;
    let content = "first";
    let notify: (output: boolean) => void = () => {};
    const stop = vi.fn();
    const listen = vi.fn((_binding, changed) => {
      notify = changed;
      return { ready: Promise.resolve(), close: stop };
    });
    const tmux = {
      connect: vi.fn().mockResolvedValue(binding),
      resolveTarget: vi.fn().mockResolvedValue(binding),
      captureTerminal: vi.fn(async () => ({ content, truncated: false })),
    } as unknown as TmuxInteractionService;
    const service = new SessionInteractionService(repository(snapshot), tmux, {
      enabled: true,
      bindings,
      listener: listen,
    });
    services.push(service);
    const frame = vi.fn();
    const fail = vi.fn();
    await service.subscribePreview("session", frame, fail, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(frame).toHaveBeenCalledOnce();
    const submit = (
      time: number,
      { sessionId = "session", sessionName = SESSION_NAME, valid = true } = {},
    ) =>
      bindings.submit({
        sessionId,
        time,
        ordinal: time,
        position: 0,
        attempt: valid
          ? {
              valid: true,
              ordinal: time,
              ...binding,
              sessionName,
              projectDirectory: "/new-project",
            }
          : { valid: false, ordinal: time },
      });
    submit(1);
    submit(2);
    const secondFrame = vi.fn();
    await service.subscribePreview("session", secondFrame, fail, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(secondFrame).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledOnce();
    content = "after duplicate";
    notify(false);
    await vi.advanceTimersByTimeAsync(350);
    expect(frame).toHaveBeenCalledTimes(2);
    expect(secondFrame).toHaveBeenCalledTimes(2);
    expect(fail).not.toHaveBeenCalled();
    submit(3, target);
    expect(fail).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
    if (change === "takeover")
      expect(await service.describe("session")).toMatchObject({ state: "superseded" });
    submit(4);
    content = "returned";
    notify(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(frame).toHaveBeenCalledTimes(2);
    expect(secondFrame).toHaveBeenCalledTimes(2);
    const recovered = vi.fn();
    await service.subscribePreview("session", recovered, vi.fn(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered).toHaveBeenCalledWith(
      expect.objectContaining({ type: "snapshot", content: "returned" }),
    );
    expect(listen).toHaveBeenCalledTimes(2);
  },
);

it("checks idle both before transport and at actual input, while allowing interrupt and handoff", async () => {
  vi.useFakeTimers();
  try {
    const snapshot = boundSession();
    const target = BINDING;
    let output!: (hasOutput: boolean) => void;
    const tmux = {
      connect: vi.fn(async () => target),
      sendMessage: vi.fn(async (_target, _message, check) => check()),
      sendKeys: vi.fn(async (_target, _keys, check) => check()),
    } as unknown as TmuxInteractionService;
    const service = new SessionInteractionService(repository(snapshot), tmux, {
      enabled: true,
      bindings,
      listener: (_binding, changed) => {
        output = changed;
        return { ready: Promise.resolve(), close() {} };
      },
    });
    services.push(service);
    await expect(service.sendMessage("session", "hello", true)).rejects.toMatchObject({
      code: "session_busy",
    });
    expect(tmux.sendMessage).not.toHaveBeenCalled();
    await expect(service.sendKeys("session", ["enter"], true)).rejects.toMatchObject({
      code: "session_busy",
    });
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5001);
    await service.sendMessage("session", "hello", true);
    output(true);
    await expect(service.sendKeys("session", ["enter"], true)).rejects.toMatchObject({
      code: "session_busy",
    });
    await expect(service.sendMessage("session", "working", true)).rejects.toMatchObject({
      code: "session_busy",
    });
    await service.sendMessage("session", "forced", false);
    await service.sendKeys("session", ["enter"], false);
    expect(await service.describe("session")).toMatchObject({ activity: "working" });
    service.setBusy("session", true);
    await expect(service.sendMessage("session", "forced", false)).rejects.toMatchObject({
      code: "session_busy",
    });
    await expect(service.sendKeys("session", ["enter"], false)).rejects.toMatchObject({
      code: "session_busy",
    });
    service.setBusy("session", false);
    (tmux.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new InteractionTransportError("disconnected", "exited"),
    );
    await expect(service.sendMessage("session", "forced", false)).rejects.toMatchObject({
      code: "interaction_not_connected",
    });
    (tmux.sendKeys as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new InteractionTransportError("disconnected", "exited"),
    );
    await expect(service.sendKeys("session", ["enter"], false)).rejects.toMatchObject({
      code: "interaction_not_connected",
    });
    await service.sendKeys("session", ["interrupt"]);
    await service.handoffPaneBinding("session");
    await vi.advanceTimersByTimeAsync(5001);
    (tmux.sendMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_target, _message, check) => {
        output(true);
        check();
      },
    );
    await expect(service.sendMessage("session", "raced", true)).rejects.toMatchObject({
      code: "session_busy",
    });
    await vi.advanceTimersByTimeAsync(5001);
    (tmux.sendMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_target, _message, check) => {
        check();
        output(true);
        check(); // Echo after paste must not block the Enter step.
      },
    );
    await service.sendMessage("session", "complete-paste", true);
  } finally {
    vi.useRealTimers();
  }
});

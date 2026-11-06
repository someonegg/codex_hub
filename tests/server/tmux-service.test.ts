import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeMessage } from "../../src/server/interaction/message.js";
import { SessionRuntime } from "../../src/server/interaction/session-runtime.js";
import {
  type TmuxCommandOptions,
  type TmuxCommandRunner,
  TmuxInteractionService,
} from "../../src/server/interaction/tmux-service.js";
import { InteractionTransportError } from "../../src/server/interaction/transport.js";
import { SessionManagerRegistry } from "../../src/server/management/session-manager.js";
import { MAX_INTERACTION_MESSAGE_BYTES } from "../../src/shared/interaction.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

interface Call {
  readonly socketPath: string;
  readonly args: readonly string[];
  readonly input: string | undefined;
  readonly options?: TmuxCommandOptions;
}

class FakeRunner implements TmuxCommandRunner {
  readonly calls: Call[] = [];
  present = true;
  sessionOutput: string | undefined;
  failure: ((call: Call) => Error | null) | null = null;
  terminalOutput = "recent terminal output";
  terminalTruncated = false;
  cursorOutput = "2,1,120,3\nHeader\n❯ \nStatus\n2,1,120,3\n";

  async run(
    socketPath: string,
    args: readonly string[],
    input: string | undefined,
    _timeoutMs?: number,
    options?: TmuxCommandOptions,
  ) {
    const call = { socketPath, args, input, options };
    this.calls.push(call);
    const failure = this.failure?.(call);
    if (failure) throw failure;
    if (args[0] === "list-sessions") {
      return {
        stdout: this.sessionOutput ?? (this.present ? MAIN : ""),
      };
    }
    if (args[0] === "capture-pane") {
      return { stdout: this.terminalOutput, truncated: this.terminalTruncated };
    }
    if (args[0] === "display-message") {
      return { stdout: this.cursorOutput, truncated: this.terminalTruncated };
    }
    return { stdout: "" };
  }
}

const sockets: Server[] = [];

function session(i: number) {
  return `ahub-00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
}
const MAIN = session(3);
afterEach(async () => {
  await Promise.all(
    sockets
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function unixSocket(): Promise<string> {
  const directory = await createTempDirectory("codex-tmux-socket-");
  const path = join(directory, "tmux.sock");
  const server = createServer();
  sockets.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return path;
}

it("captures visible rows and cursor together without changing ordinary terminal previews", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  const binding = { socketPath, sessionName: MAIN };
  await expect(service.captureTerminalWithCursor(binding)).resolves.toEqual({
    content: "Header\n❯ \nStatus",
    cursorX: 2,
    cursorY: 1,
  });
  expect(runner.calls[0].args.filter((arg) => arg === ";")).toHaveLength(2);
  await expect(service.captureTerminal(binding)).resolves.toEqual({
    content: runner.terminalOutput,
    truncated: false,
  });
});

it.each([
  "2,1,120,3\nHeader\n❯ \nStatus\n3,1,120,3\n", // cursor moved
  "2,1,120,3\nHeader\n❯ \nStatus\n2,1,100,3\n", // pane resized
  "120,1,120,3\nHeader\n❯ \nStatus\n120,1,120,3\n", // out of bounds
  "2,3,120,3\nHeader\n❯ \nStatus\n2,3,120,3\n",
  "2,1,120,3\n❯ \nStatus\n2,1,120,3\n", // lost rows
  "Header\n❯ \nStatus\n2,1,120,3\n", // lost metadata
  "2,1,120,3\nHeader\n❯ \nStatus\n2,1,120,3", // incomplete output
  "garbage\nHeader\n❯ \nStatus\ngarbage\n",
])("discards inconsistent terminal/cursor snapshots: %j", async (output) => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  runner.cursorOutput = output;
  await expect(
    new TmuxInteractionService(runner).captureTerminalWithCursor({ socketPath, sessionName: MAIN }),
  ).resolves.toBeNull();
});

it("discards truncated cursor captures even when their remaining output looks complete", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  runner.terminalTruncated = true;
  await expect(
    new TmuxInteractionService(runner).captureTerminalWithCursor({ socketPath, sessionName: MAIN }),
  ).resolves.toBeNull();
});

describe("tmux interaction transport", () => {
  it("normalizes message newlines and enforces whitespace and UTF-8 byte limits", () => {
    expect(normalizeMessage("alpha\r\nbeta\rgamma")).toBe("alpha\nbeta\ngamma");
    expect(() => normalizeMessage(" \n\t ")).toThrow("must not be blank");
    expect(Buffer.byteLength(normalizeMessage("界".repeat(87_381)), "utf8")).toBeLessThanOrEqual(
      MAX_INTERACTION_MESSAGE_BYTES,
    );
    expect(() => normalizeMessage("界".repeat(87_382))).toThrow("must not exceed");
  });

  it("revalidates and sends one bracketed paste followed by one Enter", async () => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({
      ordinal: 1,
      valid: true,
      socketPath,
      sessionName: MAIN,
    });

    await service.sendMessage(binding, "first\r\nsecond 🌊");

    const displays = runner.calls.filter((call) => call.args[0] === "display-message");
    const loads = runner.calls.filter((call) => call.args[0] === "load-buffer");
    const pastes = runner.calls.filter((call) => call.args[0] === "paste-buffer");
    const keys = runner.calls.filter((call) => call.args[0] === "send-keys");
    expect(displays).toHaveLength(0);
    expect(runner.calls.filter((call) => call.args[0] === "list-sessions")).toHaveLength(2);
    expect(loads).toHaveLength(1);
    expect(loads[0]?.input).toBe("first\nsecond 🌊");
    expect(pastes).toHaveLength(1);
    expect(pastes[0]?.args).toEqual([
      "paste-buffer",
      "-p",
      "-d",
      "-b",
      expect.stringMatching(/^ahub-/),
      "-t",
      `=${MAIN}:`,
    ]);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.args).toEqual(["send-keys", "-t", `=${MAIN}:`, "Enter"]);
  });

  it("separates Ctrl+U from Escape and keeps concurrent input after the final step", async () => {
    const socketPath = await unixSocket();
    let cleared!: () => void;
    const inputCleared = new Promise<void>((resolve) => {
      cleared = resolve;
    });
    class InterruptRunner extends FakeRunner {
      override async run(socket: string, args: readonly string[], input: string | undefined) {
        const result = await super.run(socket, args, input);
        if (args[0] === "send-keys" && args.at(-1) === "C-u") cleared();
        return result;
      }
    }
    const runner = new InterruptRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({
      ordinal: 1,
      valid: true,
      socketPath,
      sessionName: MAIN,
    });
    vi.useFakeTimers();
    const interrupt = service.sendKeys(binding, [
      { keys: ["C-u"], delayMs: 0 },
      { keys: ["Escape"], delayMs: 100 },
    ]);
    const concurrent = service.sendKeys(binding, [{ keys: ["Enter"], delayMs: 0 }]);
    const sentKeys = () =>
      runner.calls.filter((call) => call.args[0] === "send-keys").map((call) => call.args);
    await inputCleared;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(99);
    expect(sentKeys()).toEqual([["send-keys", "-t", `=${MAIN}:`, "C-u"]]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([interrupt, concurrent]);
    expect(sentKeys()).toEqual([
      ["send-keys", "-t", `=${MAIN}:`, "C-u"],
      ["send-keys", "-t", `=${MAIN}:`, "Escape"],
      ["send-keys", "-t", `=${MAIN}:`, "Enter"],
    ]);
  });

  it("serializes concurrent operations for the same pane", async () => {
    const socketPath = await unixSocket();
    let loadStarted!: () => void;
    const loading = new Promise<void>((resolve) => {
      loadStarted = resolve;
    });
    let releaseLoad!: () => void;
    const loadBlocked = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    class BlockingRunner extends FakeRunner {
      override async run(
        candidateSocket: string,
        args: readonly string[],
        input: string | undefined,
      ) {
        const result = await super.run(candidateSocket, args, input);
        if (args[0] === "load-buffer") {
          loadStarted();
          await loadBlocked;
        }
        return result;
      }
    }
    const runner = new BlockingRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({
      ordinal: 1,
      valid: true,
      socketPath,
      sessionName: MAIN,
    });
    const message = service.sendMessage(binding, "hello");
    await loading;
    const keys = service.sendKeys(binding, [{ keys: ["BTab"], delayMs: 0 }]);
    expect(runner.calls.filter((call) => call.args[0] === "list-sessions")).toHaveLength(2);
    releaseLoad();
    await Promise.all([message, keys]);
    const commands = runner.calls.map((call) => call.args[0]);
    expect(commands).toEqual([
      "list-sessions",
      "list-sessions",
      "load-buffer",
      "paste-buffer",
      "send-keys",
      "list-sessions",
      "send-keys",
    ]);
  });

  it("reports timeout as unknown and never retries or sends Enter", async () => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({
      ordinal: 1,
      valid: true,
      socketPath,
      sessionName: MAIN,
    });
    runner.failure = (call) =>
      call.args[0] === "paste-buffer" ? new InteractionTransportError("timeout", "unknown") : null;
    await expect(service.sendMessage(binding, "hello")).rejects.toMatchObject({ code: "timeout" });
    expect(runner.calls.filter((call) => call.args[0] === "paste-buffer")).toHaveLength(1);
    const paste = runner.calls.find((call) => call.args[0] === "paste-buffer");
    expect(runner.calls.find((call) => call.args[0] === "delete-buffer")?.args).toEqual([
      "delete-buffer",
      "-b",
      paste?.args[4],
    ]);
    expect(runner.calls.filter((call) => call.args.at(-1) === "Enter")).toHaveLength(0);
  });

  it("cleans up a temporary buffer when loading it fails", async () => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({
      ordinal: 1,
      valid: true,
      socketPath,
      sessionName: MAIN,
    });
    const loadFailure = new InteractionTransportError("timeout", "result unknown");
    runner.failure = (call) => (call.args[0] === "load-buffer" ? loadFailure : null);

    await expect(service.sendMessage(binding, "hello")).rejects.toBe(loadFailure);
    const load = runner.calls.find((call) => call.args[0] === "load-buffer");
    expect(runner.calls.find((call) => call.args[0] === "delete-buffer")?.args).toEqual([
      "delete-buffer",
      "-b",
      load?.args[2],
    ]);
    expect(runner.calls.some((call) => call.args[0] === "paste-buffer")).toBe(false);
  });

  it("preserves a load failure when deleting its temporary buffer also fails", async () => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({
      ordinal: 1,
      valid: true,
      socketPath,
      sessionName: MAIN,
    });
    const loadFailure = new InteractionTransportError("command_failed", "load failed");
    runner.failure = (call) => {
      if (call.args[0] === "load-buffer") return loadFailure;
      if (call.args[0] === "delete-buffer") {
        return new InteractionTransportError("command_failed", "buffer missing");
      }
      return null;
    };

    await expect(service.sendMessage(binding, "hello")).rejects.toBe(loadFailure);
    expect(runner.calls.map((call) => call.args[0])).toEqual([
      "list-sessions",
      "list-sessions",
      "load-buffer",
      "delete-buffer",
    ]);
  });

  it("preserves a paste failure when deleting its temporary buffer also fails", async () => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({
      ordinal: 1,
      valid: true,
      socketPath,
      sessionName: MAIN,
    });
    const pasteFailure = new InteractionTransportError("command_failed", "pane disappeared");
    runner.failure = (call) => {
      if (call.args[0] === "paste-buffer") return pasteFailure;
      if (call.args[0] === "delete-buffer") {
        return new InteractionTransportError("command_failed", "buffer missing");
      }
      return null;
    };

    await expect(service.sendMessage(binding, "hello")).rejects.toBe(pasteFailure);
    expect(runner.calls.map((call) => call.args[0])).toEqual([
      "list-sessions",
      "list-sessions",
      "load-buffer",
      "paste-buffer",
      "delete-buffer",
    ]);
  });
});

it("freshly resolves disconnected and dead targets and observes the original identity", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  const attempt = {
    valid: true as const,
    ordinal: 1,
    socketPath,
    sessionName: MAIN,
  };
  const binding = (await service.resolveTarget(attempt))!;
  expect(binding.sessionName).toBe(MAIN);
  expect(await service.inspect(binding)).toBe("alive");
  runner.present = false;
  expect(await service.inspect(binding)).toBe("exited");
  expect(await service.resolveTarget(attempt)).toBeNull();
  runner.present = true;
  expect(await service.inspect(binding)).toBe("alive");
});

it.each(["timeout", "command_failed"] as const)(
  "does not treat %s as exit evidence for a listening socket",
  async (code) => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({
      valid: true,
      ordinal: 1,
      socketPath,
      sessionName: MAIN,
    });
    runner.failure = () => new InteractionTransportError(code, "query failed");
    await expect(service.inspect(binding)).rejects.toMatchObject({ code });
    await expect(
      service.resolveTarget({
        valid: true,
        ordinal: 1,
        socketPath,
        sessionName: MAIN,
      }),
    ).rejects.toMatchObject({ code });
  },
);

it("disconnects a missing session before sending or after capture failure", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  const binding = await service.connect({
    valid: true,
    ordinal: 1,
    socketPath,
    sessionName: MAIN,
  });
  runner.present = false;
  await expect(service.sendMessage(binding, "hello")).rejects.toMatchObject({
    code: "disconnected",
  });
  runner.failure = (call) =>
    call.args[0] === "capture-pane"
      ? new InteractionTransportError("command_failed", "missing")
      : null;
  runner.calls.length = 0;
  await expect(service.captureTerminal(binding)).rejects.toMatchObject({ code: "disconnected" });
  expect(runner.calls.map((call) => call.args[0])).toEqual(["capture-pane", "list-sessions"]);
});

it("preserves timeout during operation validation", async () => {
  const code = "timeout";
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  const binding = await service.connect({
    valid: true,
    ordinal: 1,
    socketPath,
    sessionName: MAIN,
  });
  runner.failure = () => new InteractionTransportError(code, "query failed");
  await expect(service.captureTerminal(binding)).rejects.toMatchObject({ code });
});

it("coalesces only concurrent queries and recovers without rebinding", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  const attempt = {
    valid: true as const,
    ordinal: 1,
    socketPath,
    sessionName: MAIN,
  };
  const results = await Promise.all(
    Array.from({ length: 10 }, () => service.resolveTarget(attempt)),
  );
  expect(results.every((binding) => binding?.sessionName === MAIN)).toBe(true);
  expect(runner.calls).toHaveLength(1);
  runner.present = false;
  expect(await service.resolveTarget(attempt)).toBeNull();
  runner.present = true;
  expect(await service.resolveTarget(attempt)).toMatchObject({
    sessionName: MAIN,
  });
  expect(runner.calls).toHaveLength(3);
});

it("shares one socket enumeration across more than eight runtime pane probes", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  runner.sessionOutput = Array.from({ length: 20 }, (_, i) => (i === 1 ? "" : session(i)))
    .filter(Boolean)
    .join("\n");
  const service = new TmuxInteractionService(runner);
  const runtime = new SessionRuntime(service, new SessionManagerRegistry("test"));
  const results = await Promise.all(
    Array.from({ length: 21 }, (_, i) =>
      runtime.probe({ valid: true, ordinal: 1, socketPath, sessionName: session(i) }),
    ),
  );
  expect(runner.calls).toHaveLength(1);
  expect(runner.calls[0]?.args).toEqual(["list-sessions", "-F", "#{session_name}"]);
  expect(results[0]).toEqual({ socketPath, sessionName: session(0) });
  expect(results[1]).toBeNull();
  expect(results[20]).toBeNull();
  expect(results[19]).toMatchObject({ sessionName: session(19) });

  runner.sessionOutput = "";
  expect(
    await runtime.probe({
      valid: true,
      ordinal: 1,
      socketPath,
      sessionName: "ahub-00000000-0000-0000-0000-000000000000",
    }),
  ).toBeNull();
  expect(runner.calls).toHaveLength(2);
});

it("keeps concurrent socket enumerations independent", async () => {
  const firstSocket = await unixSocket();
  const secondSocket = await unixSocket();
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  const results = await Promise.all(
    [firstSocket, secondSocket].flatMap((socketPath) =>
      [MAIN, "ahub-00000000-0000-0000-0000-000000000004"].map((sessionName) =>
        service.resolveTarget({ valid: true, ordinal: 1, socketPath, sessionName }),
      ),
    ),
  );
  expect(runner.calls).toHaveLength(2);
  expect(new Set(runner.calls.map((call) => call.socketPath))).toEqual(
    new Set([firstSocket, secondSocket]),
  );
  expect(results).toEqual([
    { socketPath: firstSocket, sessionName: MAIN },
    null,
    { socketPath: secondSocket, sessionName: MAIN },
    null,
  ]);
});

it("shares observation failures across panes and retries on the next query", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  runner.failure = () => new InteractionTransportError("timeout", "query timed out");
  const service = new TmuxInteractionService(runner);
  const results = await Promise.allSettled(
    [MAIN, "ahub-00000000-0000-0000-0000-000000000004"].map((sessionName) =>
      service.resolveTarget({ valid: true, ordinal: 1, socketPath, sessionName }),
    ),
  );
  expect(runner.calls).toHaveLength(1);
  for (const result of results)
    expect(result).toMatchObject({ status: "rejected", reason: { code: "timeout" } });
  runner.failure = null;
  expect(
    await service.resolveTarget({
      valid: true,
      ordinal: 1,
      socketPath,
      sessionName: MAIN,
    }),
  ).toMatchObject({ sessionName: MAIN });
  expect(runner.calls).toHaveLength(2);
});

it("kills only the selected pane and checks queued input availability", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  const binding = await service.connect({
    valid: true,
    ordinal: 0,
    socketPath,
    sessionName: MAIN,
  });
  await service.killSession(binding);
  expect(
    runner.calls.filter((call) => call.args[0] === "kill-session").map((call) => call.args),
  ).toEqual([["kill-session", "-t", `=${MAIN}:`]]);
  await expect(
    service.sendMessage(binding, "draft", () => {
      throw new Error("session busy");
    }),
  ).rejects.toThrow("session busy");
  expect(runner.calls.some((call) => call.args[0] === "load-buffer")).toBe(false);
});

it("does not treat a non-socket binding path as confirmed pane death", async () => {
  const directory = await createTempDirectory("unsafe-binding-");
  const socketPath = join(directory, "ordinary-file");
  await writeFile(socketPath, "not a socket");
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  await expect(
    service.resolveTarget({
      valid: true,
      ordinal: 1,
      socketPath,
      sessionName: MAIN,
    }),
  ).rejects.toMatchObject({ code: "command_failed" });
  expect(runner.calls).toEqual([]);
});

it("bounds transport queries to eight distinct sockets", async () => {
  const paths = await Promise.all(Array.from({ length: 12 }, () => unixSocket()));
  let active = 0;
  let maximum = 0;
  const releases: (() => void)[] = [];
  const runner = new FakeRunner();
  const run = runner.run.bind(runner);
  vi.spyOn(runner, "run").mockImplementation(async (...args) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return run(...args);
  });
  const service = new TmuxInteractionService(runner);
  const batch = paths.map((socketPath) =>
    service.resolveTarget({ valid: true, ordinal: 0, socketPath, sessionName: MAIN }),
  );
  await vi.waitFor(() => expect(active).toBe(8));
  releases.splice(0).forEach((resolve) => resolve());
  await vi.waitFor(() => expect(active).toBe(4));
  releases.splice(0).forEach((resolve) => resolve());
  await Promise.all(batch);
  expect(maximum).toBe(8);
  expect(runner.calls).toHaveLength(12);
});

it("shares a queued send's liveness query with concurrent reads", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = runner.run.bind(runner);
  vi.spyOn(runner, "run").mockImplementation(async (...args) => {
    const result = await run(...args);
    if (args[1][0] === "list-sessions") {
      started();
      await blocked;
    }
    return result;
  });
  const service = new TmuxInteractionService(runner);
  const binding = { socketPath, sessionName: MAIN };
  const send = service.sendMessage(binding, "hello");
  await ready;
  const read = service.resolveTarget({ valid: true, ordinal: 0, ...binding });
  release();
  await Promise.all([send, read]);
  expect(runner.calls.map((call) => call.args[0])).toEqual([
    "list-sessions",
    "load-buffer",
    "paste-buffer",
    "send-keys",
  ]);
});

it("checks each delayed key after its wait and stops if the session exits", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  let first!: () => void;
  const sent = new Promise<void>((resolve) => {
    first = resolve;
  });
  const run = runner.run.bind(runner);
  vi.spyOn(runner, "run").mockImplementation(async (...args) => {
    const result = await run(...args);
    if (args[1][0] === "send-keys") {
      runner.present = false;
      first();
    }
    return result;
  });
  const task = service.sendKeys({ socketPath, sessionName: MAIN }, [
    { keys: ["C-u"], delayMs: 0 },
    { keys: ["Escape"], delayMs: 10 },
  ]);
  const rejected = expect(task).rejects.toMatchObject({ code: "disconnected" });
  await sent;
  await rejected;
  expect(runner.calls.map((call) => call.args[0])).toEqual([
    "list-sessions",
    "send-keys",
    "list-sessions",
  ]);
});

it("prepares sends, captures, and subscriptions without extra upper-layer probes", async () => {
  const { SessionInteractionService } = await import(
    "../../src/server/interaction/interaction-service.js"
  );
  const { PaneBindingManager } = await import(
    "../../src/server/interaction/pane-binding-manager.js"
  );
  const { codexInteraction } = await import(
    "../../src/server/adapters/codex/interaction-parser.js"
  );
  const socketPath = await unixSocket();
  const target = { socketPath, sessionName: MAIN };
  const runner = new FakeRunner();
  const tmux = new TmuxInteractionService(runner);
  const bindings = new PaneBindingManager();
  bindings.submit({
    sessionId: "session",
    time: 1,
    ordinal: 1,
    position: 0,
    attempt: { valid: true, ordinal: 1, ...target },
  });
  const listen = vi.fn(() => ({ ready: new Promise<void>(() => {}), close() {} }));
  const service = new SessionInteractionService(
    { getInteractionSession: async () => ({ archived: false, interaction: codexInteraction() }) },
    tmux,
    { enabled: true, bindings, listener: listen },
  );
  try {
    await service.sendMessage("session", "hello");
    expect(runner.calls.map((call) => call.args[0])).toEqual([
      "list-sessions",
      "load-buffer",
      "paste-buffer",
      "send-keys",
    ]);
    runner.calls.length = 0;
    await service.captureTerminal("session");
    expect(runner.calls.map((call) => call.args[0])).toEqual(["capture-pane"]);
    runner.calls.length = 0;
    const abort = new AbortController();
    const stop = await service.subscribePreview("session", vi.fn(), vi.fn(), abort.signal);
    expect(listen).toHaveBeenCalledOnce();
    expect(runner.calls).toHaveLength(0);
    stop();
  } finally {
    service.close();
  }
});

it.each(["custom", "%1", "ahub-invalid", "AHUB-00000000-0000-0000-0000-000000000001"])(
  "rejects invalid session name %s before querying",
  async (sessionName) => {
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    expect(
      await service.resolveTarget({
        valid: true,
        ordinal: 0,
        socketPath: "/tmp/socket",
        sessionName,
      }),
    ).toBeNull();
    expect(runner.calls).toEqual([]);
  },
);

it.each(["alive", "query_failed"])(
  "preserves capture errors when fallback is %s",
  async (state) => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const error = new InteractionTransportError("command_failed", "capture failed");
    runner.failure = (call) => {
      if (call.args[0] === "capture-pane") return error;
      return state === "query_failed"
        ? new InteractionTransportError("timeout", "probe failed")
        : null;
    };
    await expect(
      service.captureTerminal({
        socketPath,
        sessionName: MAIN,
      }),
    ).rejects.toBe(error);
    expect(runner.calls.map((call) => call.args[0])).toEqual(["capture-pane", "list-sessions"]);
  },
);

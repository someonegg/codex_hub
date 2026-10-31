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
  paneDead = "0";
  present = true;
  paneOutput: string | undefined;
  failure: ((call: Call) => Error | null) | null = null;
  terminalOutput = "recent terminal output";
  terminalTruncated = false;

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
    if (args[0] === "list-panes") {
      return {
        stdout: this.paneOutput ?? (this.present ? `%3|${this.paneDead}|arbitrary-session` : ""),
      };
    }
    if (args[0] === "capture-pane") {
      return { stdout: this.terminalOutput, truncated: this.terminalTruncated };
    }
    return { stdout: "" };
  }
}

const sockets: Server[] = [];
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
      paneId: "%3",
    });

    await service.sendMessage(binding, "first\r\nsecond 🌊");

    const displays = runner.calls.filter((call) => call.args[0] === "display-message");
    const loads = runner.calls.filter((call) => call.args[0] === "load-buffer");
    const pastes = runner.calls.filter((call) => call.args[0] === "paste-buffer");
    const keys = runner.calls.filter((call) => call.args[0] === "send-keys");
    expect(displays).toHaveLength(0);
    expect(runner.calls.filter((call) => call.args[0] === "list-panes")).toHaveLength(2);
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
      "%3",
    ]);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.args).toEqual(["send-keys", "-t", "%3", "Enter"]);
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
    const binding = await service.connect({ ordinal: 1, valid: true, socketPath, paneId: "%3" });
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
    expect(sentKeys()).toEqual([["send-keys", "-t", "%3", "C-u"]]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([interrupt, concurrent]);
    expect(sentKeys()).toEqual([
      ["send-keys", "-t", "%3", "C-u"],
      ["send-keys", "-t", "%3", "Escape"],
      ["send-keys", "-t", "%3", "Enter"],
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
    const binding = await service.connect({ ordinal: 1, valid: true, socketPath, paneId: "%3" });
    const message = service.sendMessage(binding, "hello");
    await loading;
    const keys = service.sendKeys(binding, [{ keys: ["BTab"], delayMs: 0 }]);
    expect(runner.calls.filter((call) => call.args[0] === "list-panes")).toHaveLength(2);
    releaseLoad();
    await Promise.all([message, keys]);
    const commands = runner.calls.map((call) => call.args[0]);
    expect(commands).toEqual([
      "list-panes",
      "list-panes",
      "load-buffer",
      "paste-buffer",
      "send-keys",
      "list-panes",
      "send-keys",
    ]);
  });

  it("reports timeout as unknown and never retries or sends Enter", async () => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({ ordinal: 1, valid: true, socketPath, paneId: "%3" });
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
    const binding = await service.connect({ ordinal: 1, valid: true, socketPath, paneId: "%3" });
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
    const binding = await service.connect({ ordinal: 1, valid: true, socketPath, paneId: "%3" });
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
      "list-panes",
      "list-panes",
      "load-buffer",
      "delete-buffer",
    ]);
  });

  it("preserves a paste failure when deleting its temporary buffer also fails", async () => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({ ordinal: 1, valid: true, socketPath, paneId: "%3" });
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
      "list-panes",
      "list-panes",
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
  const attempt = { valid: true as const, ordinal: 1, socketPath, paneId: "%3" };
  const binding = (await service.resolveTarget(attempt))!;
  expect(binding.sessionName).toBe("arbitrary-session");
  expect(await service.inspect(binding)).toBe("alive");
  runner.paneDead = "1";
  expect(await service.inspect(binding)).toBe("exited");
  expect(await service.resolveTarget(attempt)).toBeNull();
  runner.paneDead = "0";
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
    const binding = await service.connect({ valid: true, ordinal: 1, socketPath, paneId: "%3" });
    runner.failure = () => new InteractionTransportError(code, "query failed");
    await expect(service.inspect(binding)).rejects.toMatchObject({ code });
    await expect(
      service.resolveTarget({ valid: true, ordinal: 1, socketPath, paneId: "%3" }),
    ).rejects.toMatchObject({ code });
  },
);

it("accepts linked-window observations when targeting %3", async () => {
  const paneId = "%3";
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  runner.paneOutput = "%3|0|first-session\n%3|0|linked-session\n%4|0|other-session\n";
  const service = new TmuxInteractionService(runner);
  const attempt = { valid: true as const, ordinal: 1, socketPath, paneId };

  const binding = await service.connect(attempt);
  expect(binding.paneId).toBe(paneId);
  await expect(service.inspect(binding)).resolves.toBe("alive");
  await expect(service.resolveTarget(attempt)).resolves.toEqual(binding);
  await service.sendMessage(binding, "hello");
  await expect(service.captureTerminal(binding)).resolves.toMatchObject({
    content: runner.terminalOutput,
  });
});

it("does not treat malformed pane observations as exit evidence", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  const binding = await service.connect({ valid: true, ordinal: 1, socketPath, paneId: "%3" });
  runner.paneDead = "corrupt";
  await expect(service.inspect(binding)).rejects.toThrow("Invalid tmux pane observation");
});

it.each(["missing", "dead"])("disconnects a %s pane before sending or capturing", async (state) => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  const binding = await service.connect({ valid: true, ordinal: 1, socketPath, paneId: "%3" });
  runner.present = state !== "missing";
  runner.paneDead = state === "dead" ? "1" : "0";
  await expect(service.sendMessage(binding, "hello")).rejects.toMatchObject({
    code: "disconnected",
  });
  await expect(service.captureTerminal(binding)).rejects.toMatchObject({ code: "disconnected" });
  expect(runner.calls.some((call) => ["load-buffer", "capture-pane"].includes(call.args[0]!))).toBe(
    false,
  );
});

it("preserves timeout during operation validation", async () => {
  const code = "timeout";
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  const binding = await service.connect({ valid: true, ordinal: 1, socketPath, paneId: "%3" });
  runner.failure = () => new InteractionTransportError(code, "query failed");
  await expect(service.captureTerminal(binding)).rejects.toMatchObject({ code });
});

it("coalesces only concurrent queries and recovers without rebinding", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  const attempt = { valid: true as const, ordinal: 1, socketPath, paneId: "%3" };
  const results = await Promise.all(
    Array.from({ length: 10 }, () => service.resolveTarget(attempt)),
  );
  expect(results.every((binding) => binding?.paneId === "%3")).toBe(true);
  expect(runner.calls).toHaveLength(1);
  runner.present = false;
  expect(await service.resolveTarget(attempt)).toBeNull();
  runner.present = true;
  expect(await service.resolveTarget(attempt)).toMatchObject({ paneId: "%3" });
  expect(runner.calls).toHaveLength(3);
});

it("shares one socket enumeration across more than eight runtime pane probes", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  runner.paneOutput = Array.from(
    { length: 20 },
    (_, i) => `%${i}|${i === 1 ? 1 : 0}|session-${i}`,
  ).join("\n");
  // Preserve the first association for linked panes.
  runner.paneOutput += "\n%0|0|linked-session\n";
  const service = new TmuxInteractionService(runner);
  const runtime = new SessionRuntime(service, new SessionManagerRegistry("test"));
  const results = await Promise.all(
    Array.from({ length: 21 }, (_, i) =>
      runtime.probe({ valid: true, ordinal: 1, socketPath, paneId: `%${i}` }),
    ),
  );
  expect(runner.calls).toHaveLength(1);
  expect(runner.calls[0]?.args).toEqual([
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}|#{pane_dead}|#{session_name}",
  ]);
  expect(results[0]).toEqual({ socketPath, paneId: "%0", sessionName: "session-0" });
  expect(results[1]).toBeNull();
  expect(results[20]).toBeNull();
  expect(results[19]).toMatchObject({ paneId: "%19" });

  runner.paneOutput = "";
  expect(await runtime.probe({ valid: true, ordinal: 1, socketPath, paneId: "%0" })).toBeNull();
  expect(runner.calls).toHaveLength(2);
});

it("keeps concurrent socket enumerations independent", async () => {
  const firstSocket = await unixSocket();
  const secondSocket = await unixSocket();
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  const results = await Promise.all(
    [firstSocket, secondSocket].flatMap((socketPath) =>
      ["%3", "%4"].map((paneId) =>
        service.resolveTarget({ valid: true, ordinal: 1, socketPath, paneId }),
      ),
    ),
  );
  expect(runner.calls).toHaveLength(2);
  expect(new Set(runner.calls.map((call) => call.socketPath))).toEqual(
    new Set([firstSocket, secondSocket]),
  );
  expect(results).toEqual([
    { socketPath: firstSocket, paneId: "%3", sessionName: "arbitrary-session" },
    null,
    { socketPath: secondSocket, paneId: "%3", sessionName: "arbitrary-session" },
    null,
  ]);
});

it("shares observation failures across panes and retries on the next query", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  runner.failure = () => new InteractionTransportError("timeout", "query timed out");
  const service = new TmuxInteractionService(runner);
  const results = await Promise.allSettled(
    ["%3", "%4"].map((paneId) =>
      service.resolveTarget({ valid: true, ordinal: 1, socketPath, paneId }),
    ),
  );
  expect(runner.calls).toHaveLength(1);
  for (const result of results)
    expect(result).toMatchObject({ status: "rejected", reason: { code: "timeout" } });
  runner.failure = null;
  expect(
    await service.resolveTarget({ valid: true, ordinal: 1, socketPath, paneId: "%3" }),
  ).toMatchObject({ paneId: "%3" });
  expect(runner.calls).toHaveLength(2);
});

it("kills only the selected pane and checks queued input availability", async () => {
  const socketPath = await unixSocket();
  const runner = new FakeRunner();
  const service = new TmuxInteractionService(runner);
  const binding = await service.connect({ valid: true, ordinal: 0, socketPath, paneId: "%3" });
  await service.killPane(binding);
  expect(
    runner.calls.filter((call) => call.args[0] === "kill-pane").map((call) => call.args),
  ).toEqual([["kill-pane", "-t", "%3"]]);
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
    service.resolveTarget({ valid: true, ordinal: 1, socketPath, paneId: "%3" }),
  ).rejects.toMatchObject({ code: "command_failed" });
  expect(runner.calls).toEqual([]);
});

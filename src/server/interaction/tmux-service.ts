import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import type { InteractionBindingAttempt, InteractionKeyStep } from "../domain/session-domain.js";
import { normalizeMessage } from "./message.js";
import {
  type InteractionTransport,
  InteractionTransportError,
  type TmuxBinding,
} from "./transport.js";

export const MAX_TERMINAL_PREVIEW_BYTES = 256_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export interface TmuxCommandRunner {
  run(
    socketPath: string,
    args: readonly string[],
    input: string | undefined,
    timeoutMs: number,
    options?: TmuxCommandOptions,
  ): Promise<{ readonly stdout: string; readonly truncated?: boolean }>;
}

export interface TmuxCommandOptions {
  readonly maxOutputBytes: number;
  readonly truncateStart: boolean;
}

export class TmuxInteractionService implements InteractionTransport {
  readonly #queues = new Map<string, Promise<void>>();

  constructor(
    private readonly runner: TmuxCommandRunner = new SpawnTmuxCommandRunner(),
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  readonly #queries = new Map<string, Promise<ReadonlyMap<string, TmuxBinding | null>>>();

  async connect(attempt: InteractionBindingAttempt): Promise<TmuxBinding> {
    const binding = await this.resolveTarget(attempt);
    if (!binding) throw disconnected();
    return binding;
  }

  resolveTarget(attempt: InteractionBindingAttempt): Promise<TmuxBinding | null> {
    if (!attempt.valid || !attempt.socketPath.startsWith("/") || !/^%\d+$/.test(attempt.paneId))
      return Promise.resolve(null);
    const { socketPath, paneId } = attempt;
    let query = this.#queries.get(socketPath);
    if (!query) {
      query = this.#query(socketPath);
      this.#queries.set(socketPath, query);
      // Share only in-flight observations, never completed results.
      void query.then(
        () => this.#queries.delete(socketPath),
        () => this.#queries.delete(socketPath),
      );
    }
    return query.then((panes) => panes.get(paneId) ?? null);
  }

  async #query(socketPath: string): Promise<ReadonlyMap<string, TmuxBinding | null>> {
    try {
      await validateSocket(socketPath);
    } catch (error) {
      if (error instanceof InteractionTransportError && error.code === "disconnected")
        return new Map();
      throw error;
    }
    let result: { stdout: string };
    try {
      result = await this.runner.run(
        socketPath,
        ["list-panes", "-a", "-F", "#{pane_id}|#{pane_dead}|#{session_name}"],
        undefined,
        this.timeoutMs,
      );
    } catch (error) {
      if (
        error instanceof InteractionTransportError &&
        error.code === "command_failed" &&
        !(await socketListening(socketPath, this.timeoutMs))
      )
        return new Map();
      throw error;
    }
    const rows = result.stdout
      .replace(/\n$/, "")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"));
    if (
      rows.some(
        (row) =>
          row.length < 3 ||
          !/^%\d+$/.test(row[0]!) ||
          !/^[01]$/.test(row[1]!) ||
          !row.slice(2).join("|"),
      )
    ) {
      throw new InteractionTransportError("command_failed", "Invalid tmux pane observation");
    }
    const panes = new Map<string, TmuxBinding | null>();
    for (const row of rows) {
      const paneId = row[0]!;
      // Linked windows can report a pane more than once; preserve the first session name.
      if (!panes.has(paneId))
        panes.set(
          paneId,
          row[1] === "1" ? null : { socketPath, paneId, sessionName: row.slice(2).join("|") },
        );
    }
    return panes;
  }

  killPane(binding: TmuxBinding, assertAvailable: () => void = () => {}): Promise<void> {
    return this.#serialize(binding, async () => {
      await this.#revalidate(binding);
      assertAvailable();
      await this.#run(binding, ["kill-pane", "-t", binding.paneId]);
    });
  }

  sendMessage(
    binding: TmuxBinding,
    message: string,
    assertAvailable: () => void = () => {},
  ): Promise<void> {
    const normalized = normalizeMessage(message);
    return this.#serialize(binding, async () => {
      await this.#revalidate(binding);
      assertAvailable();
      const bufferName = `ahub-${process.pid}-${randomUUID()}`;
      let bufferMayExist = true;
      try {
        await this.#run(binding, ["load-buffer", "-b", bufferName, "-"], normalized);
        assertAvailable();
        await this.#run(binding, [
          "paste-buffer",
          "-p",
          "-d",
          "-b",
          bufferName,
          "-t",
          binding.paneId,
        ]);
        bufferMayExist = false;
        assertAvailable();
        await this.#run(binding, ["send-keys", "-t", binding.paneId, "Enter"]);
      } finally {
        if (bufferMayExist) {
          try {
            await this.#run(binding, ["delete-buffer", "-b", bufferName]);
          } catch {
            // Preserve the original failure; the buffer may not exist or may already be deleted.
          }
        }
      }
    });
  }

  sendKeys(
    binding: TmuxBinding,
    steps: readonly InteractionKeyStep[],
    assertAvailable: () => void = () => {},
  ): Promise<void> {
    return this.#serialize(binding, async () => {
      for (const step of steps) {
        if (step.delayMs > 0) await delay(step.delayMs);
        await this.#revalidate(binding);
        assertAvailable();
        await this.#run(binding, ["send-keys", "-t", binding.paneId, ...step.keys]);
      }
    });
  }

  captureTerminal(
    binding: TmuxBinding,
    assertAvailable: () => void = () => {},
  ): Promise<{
    readonly content: string;
    readonly truncated: boolean;
  }> {
    return this.#serialize(binding, async () => {
      await this.#revalidate(binding);
      assertAvailable();
      const result = await this.runner.run(
        binding.socketPath,
        ["capture-pane", "-p", "-t", binding.paneId],
        undefined,
        this.timeoutMs,
        { maxOutputBytes: MAX_TERMINAL_PREVIEW_BYTES, truncateStart: true },
      );
      return { content: result.stdout, truncated: result.truncated === true };
    });
  }

  /** Query errors never establish that the selected pane exited. */
  async inspect(binding: TmuxBinding): Promise<"alive" | "exited"> {
    return (await this.resolveTarget({ valid: true, ordinal: 0, ...binding })) ? "alive" : "exited";
  }

  async #revalidate(binding: TmuxBinding): Promise<void> {
    if (!(await this.resolveTarget({ valid: true, ordinal: 0, ...binding }))) throw disconnected();
  }

  async #run(binding: TmuxBinding, args: readonly string[], input?: string): Promise<void> {
    await this.runner.run(binding.socketPath, args, input, this.timeoutMs);
  }

  #serialize<T>(binding: TmuxBinding, operation: () => Promise<T>): Promise<T> {
    const key = `${binding.socketPath}\0${binding.paneId}`;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(key, settled);
    void settled.finally(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return current;
  }
}

async function validateSocket(socketPath: string): Promise<void> {
  try {
    const info = await lstat(socketPath);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!info.isSocket() || currentUid === null || info.uid !== currentUid)
      throw new InteractionTransportError("command_failed", "Unsafe tmux socket");
  } catch (error) {
    if (error instanceof InteractionTransportError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw disconnected();
    throw error;
  }
}

function disconnected(): InteractionTransportError {
  return new InteractionTransportError("disconnected", "tmux target is not connected");
}

export class SpawnTmuxCommandRunner implements TmuxCommandRunner {
  run(
    socketPath: string,
    args: readonly string[],
    input: string | undefined,
    timeoutMs: number,
    options?: TmuxCommandOptions,
  ): Promise<{ readonly stdout: string; readonly truncated?: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn("tmux", ["-S", socketPath, ...args], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout: Buffer = Buffer.alloc(0);
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let truncated = false;
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() =>
          reject(
            new InteractionTransportError(
              "timeout",
              "tmux operation timed out; the result is unknown",
            ),
          ),
        );
      }, timeoutMs);
      const collectStdout = (chunk: Buffer) => {
        if (options?.truncateStart) {
          stdout = Buffer.concat([stdout, chunk]);
          if (stdout.byteLength > options.maxOutputBytes) {
            stdout = trimLeadingPartialUtf8(
              stdout.subarray(stdout.byteLength - options.maxOutputBytes),
            );
            truncated = true;
          }
          return;
        }
        outputBytes += chunk.byteLength;
        if (outputBytes <= MAX_COMMAND_OUTPUT_BYTES) stdout = Buffer.concat([stdout, chunk]);
        else child.kill("SIGKILL");
      };
      const collectStderr = (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes <= MAX_COMMAND_OUTPUT_BYTES) stderr.push(chunk);
        else child.kill("SIGKILL");
      };
      child.stdout.on("data", collectStdout);
      child.stderr.on("data", collectStderr);
      child.once("error", (error) =>
        finish(() => reject(new InteractionTransportError("command_failed", error.message))),
      );
      child.stdin.once("error", (error) =>
        finish(() => reject(new InteractionTransportError("command_failed", error.message))),
      );
      child.once("close", (code) =>
        finish(() => {
          if (outputBytes > MAX_COMMAND_OUTPUT_BYTES || code !== 0) {
            reject(
              new InteractionTransportError(
                "command_failed",
                Buffer.concat(stderr).toString("utf8").trim() || "tmux command failed",
              ),
            );
            return;
          }
          resolve({ stdout: stdout.toString("utf8"), truncated });
        }),
      );
      if (input === undefined) child.stdin.end();
      else child.stdin.end(input, "utf8");
    });
  }
}

function trimLeadingPartialUtf8(buffer: Buffer): Buffer {
  let start = 0;
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start);
}

// A refused connection establishes a stopped server even when tmux left its socket file.
// Timeouts, permissions and other socket failures remain unknown.
function socketListening(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new InteractionTransportError("timeout", "Socket validation timed out"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

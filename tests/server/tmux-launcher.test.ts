import type * as ChildProcess from "node:child_process";

import { beforeEach, expect, it, vi } from "vitest";

import {
  attachCommand,
  shellQuote,
  TmuxLauncher,
} from "../../src/server/interaction/tmux-launcher.js";
import { TmuxInteractionService } from "../../src/server/interaction/tmux-service.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => {
  const { promisify } = await import("node:util");
  // execFile's custom promisifier returns both output streams; keep that contract
  // local to this callback-based substitute instead of replacing node:util.
  Object.defineProperty(execute, promisify.custom, {
    value: (file: string, args: string[], options: ChildProcess.ExecFileOptions) =>
      new Promise((resolve, reject) => {
        execute(file, args, options, (error: Error | null, stdout: string, stderr: string) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      }),
  });
  return { ...(await original<typeof ChildProcess>()), execFile: execute };
});

type ExecuteCallback = (error: Error | null, stdout: string, stderr: string) => void;

function succeeds(stdout: string) {
  return (
    _file: string,
    _args: string[],
    _options: ChildProcess.ExecFileOptions,
    callback: ExecuteCallback,
  ) => {
    callback(null, stdout, "");
  };
}

function fails(error: Error) {
  return (
    _file: string,
    _args: string[],
    _options: ChildProcess.ExecFileOptions,
    callback: ExecuteCallback,
  ) => {
    callback(error, "", "");
  };
}

beforeEach(() => {
  execute.mockReset();
  execute.mockImplementation(succeeds("/actual/tmux.sock|%7"));
  vi.spyOn(TmuxInteractionService.prototype, "connect").mockImplementation(async (attempt) => {
    if (!attempt.valid) throw new Error("invalid");
    return { socketPath: attempt.socketPath, paneId: attempt.paneId };
  });
});
it.each([undefined, "/configured/socket path"])(
  "launches with configured socket %s and records the actual socket",
  async (socket) => {
    const binding = await new TmuxLauncher(socket).launch("id", "/project", [
      "codex",
      "--no-daemon",
    ]);
    const args = execute.mock.calls[0]![1] as string[];
    expect(args.slice(0, socket ? 2 : 1)).toEqual(socket ? ["-S", socket] : ["new-session"]);
    expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual(["-s", "ahub-id"]);
    expect(args).not.toContain("-L");
    if (!socket) expect(args).not.toContain("-S");
    expect(binding.socketPath).toBe("/actual/tmux.sock");
    expect(execute.mock.calls[1]![1]).toEqual([
      "-S",
      "/actual/tmux.sock",
      "set-option",
      "-p",
      "-t",
      "%7",
      "remain-on-exit",
      "off",
    ]);
  },
);
it("quotes shell values for attach", () => {
  expect(shellQuote("/tmp/a'b ; $HOME")).toBe(
    "'/tmp/a'" + String.fromCharCode(92) + "''b ; $HOME'",
  );
  expect(attachCommand(undefined, "ahub-123")).toBe("tmux attach-session -t 'ahub-123'");
});

it("classifies a refused launch as definitely not started", async () => {
  execute.mockImplementationOnce(fails(new Error("refused")));
  await expect(new TmuxLauncher().launch("id", "/project", ["codex"])).rejects.toMatchObject({
    outcome: "not_started",
    attachCommand: null,
  });
  expect(execute).toHaveBeenCalledOnce();
});

it("preserves a fallback attach command when launch times out", async () => {
  execute.mockImplementationOnce(fails(Object.assign(new Error("timeout"), { killed: true })));
  await expect(
    new TmuxLauncher("/configured/socket").launch("id", "/project", ["codex"]),
  ).rejects.toMatchObject({
    outcome: "unknown",
    attachCommand: attachCommand("/configured/socket", "ahub-id"),
  });
  expect(execute).toHaveBeenCalledOnce();
});

it.each(["broken", "|%7", "/actual/socket|bad"])(
  "preserves fallback attach for malformed launch output %s",
  async (stdout) => {
    execute.mockImplementationOnce(succeeds(stdout));
    await expect(
      new TmuxLauncher("/configured/socket").launch("id", "/project", ["codex"]),
    ).rejects.toMatchObject({
      outcome: "unknown",
      attachCommand: attachCommand("/configured/socket", "ahub-id"),
    });
    expect(execute).toHaveBeenCalledOnce();
  },
);

it("keeps the known target when post-launch setup fails", async () => {
  execute
    .mockImplementationOnce(succeeds("/actual/socket|%7"))
    .mockImplementationOnce(fails(new Error("set-option failed")));
  await expect(new TmuxLauncher().launch("id", "/project", ["codex"])).rejects.toMatchObject({
    outcome: "unknown",
    target: { socketPath: "/actual/socket", paneId: "%7" },
    attachCommand: attachCommand("/actual/socket", "ahub-id"),
  });
  expect(execute).toHaveBeenCalledTimes(2);
});

it("keeps the known target when post-launch connection validation fails", async () => {
  vi.spyOn(TmuxInteractionService.prototype, "connect").mockRejectedValueOnce(
    new Error("invalid connection"),
  );
  await expect(new TmuxLauncher().launch("id", "/project", ["codex"])).rejects.toMatchObject({
    outcome: "unknown",
    target: { socketPath: "/actual/tmux.sock", paneId: "%7" },
  });
  expect(execute).toHaveBeenCalledTimes(2);
});

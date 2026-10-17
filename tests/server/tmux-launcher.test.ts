import type * as ChildProcess from "node:child_process";
import type * as NodeUtil from "node:util";

import { beforeEach, expect, it, vi } from "vitest";

import {
  attachCommand,
  shellQuote,
  TmuxLauncher,
} from "../../src/server/interaction/tmux-launcher.js";
import { TmuxInteractionService } from "../../src/server/interaction/tmux-service.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcess>()),
  execFile: execute,
}));
vi.mock("node:util", async (original) => ({
  ...(await original<typeof NodeUtil>()),
  promisify: (fn: unknown) => fn,
}));

beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValue({ stdout: "/actual/tmux.sock|%7" });
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
    expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual(["-s", "codex-hub-id"]);
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
  expect(attachCommand(undefined, "codex-hub-123")).toBe("tmux attach-session -t 'codex-hub-123'");
});

it("classifies a refused launch as definitely not started", async () => {
  execute.mockRejectedValueOnce(new Error("refused"));
  await expect(new TmuxLauncher().launch("id", "/project", ["codex"])).rejects.toMatchObject({
    outcome: "not_started",
    attachCommand: null,
  });
  expect(execute).toHaveBeenCalledOnce();
});

it("preserves a fallback attach command when launch times out", async () => {
  execute.mockRejectedValueOnce(Object.assign(new Error("timeout"), { killed: true }));
  await expect(
    new TmuxLauncher("/configured/socket").launch("id", "/project", ["codex"]),
  ).rejects.toMatchObject({
    outcome: "unknown",
    attachCommand: attachCommand("/configured/socket", "codex-hub-id"),
  });
  expect(execute).toHaveBeenCalledOnce();
});

it.each(["broken", "|%7", "/actual/socket|bad"])(
  "preserves fallback attach for malformed launch output %s",
  async (stdout) => {
    execute.mockResolvedValueOnce({ stdout });
    await expect(
      new TmuxLauncher("/configured/socket").launch("id", "/project", ["codex"]),
    ).rejects.toMatchObject({
      outcome: "unknown",
      attachCommand: attachCommand("/configured/socket", "codex-hub-id"),
    });
    expect(execute).toHaveBeenCalledOnce();
  },
);

it("keeps the known target when post-launch setup fails", async () => {
  execute
    .mockResolvedValueOnce({ stdout: "/actual/socket|%7" })
    .mockRejectedValueOnce(new Error("set-option failed"));
  await expect(new TmuxLauncher().launch("id", "/project", ["codex"])).rejects.toMatchObject({
    outcome: "unknown",
    target: { socketPath: "/actual/socket", paneId: "%7" },
    attachCommand: attachCommand("/actual/socket", "codex-hub-id"),
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

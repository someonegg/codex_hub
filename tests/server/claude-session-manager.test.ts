import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import {
  claudeBindingAttempts,
  claudeBindingCommand,
  claudeInteraction,
} from "../../src/server/adapters/claude/interaction.js";
import * as readyScript from "../../src/server/adapters/claude/ready-script.js";
import {
  BINDING_PROMPT_WAIT_MS,
  ClaudeSessionManager,
} from "../../src/server/adapters/claude/session-manager.js";
import { interruptSteps } from "../../src/server/adapters/shared/session-management.js";
import { TmuxLauncher } from "../../src/server/interaction/tmux-launcher.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

// Route promise-based sleeps through the clock controlled by vi.useFakeTimers().
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}));

it("validates identity and missing directories before starting Claude", async () => {
  const tmux = new TmuxLauncher();
  const launch = vi.spyOn(tmux, "launch");
  const manager = new ClaudeSessionManager("/test/home", tmux);
  await expect(
    manager.launch({
      operationId: "00000000-0000-4000-8000-000000000001",
      workingDirectory: "/test/project",
      resumeNativeId: "not-a-claude-id",
      worktree: false,
      yolo: false,
    }),
  ).rejects.toThrow("Invalid resume identity");
  expect(launch).not.toHaveBeenCalled();
  const directory = await createTempDirectory("claude-directory-");
  await expect(manager.resolveDirectory(directory + "/missing")).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(manager.resolveDirectory("relative/path")).rejects.toThrow("absolute local path");
});

it("validates independent V3 binding metadata, preserving pane validity for invalid optional metadata", () => {
  expect(claudeBindingCommand("", "/project with 'quotes'", "Task")).toContain("AHUB_TMUX_BIND_V3");
  expect(() => claudeBindingCommand("bad-operation")).toThrow("Invalid operation ID");
  expect(
    claudeBindingAttempts(
      "<bash-stdout>AHUB_TMUX_BIND_V3\n/tmp/tmux.sock\nahub-00000000-0000-0000-0000-000000000002\n\n/project\ninvalid-json</bash-stdout>",
      1,
    ),
  ).toEqual([
    {
      ordinal: 1,
      valid: true,
      socketPath: "/tmp/tmux.sock",
      sessionName: "ahub-00000000-0000-0000-0000-000000000002",
      projectDirectory: "/project",
    },
  ]);
  expect(
    claudeBindingAttempts(
      "<bash-stdout>AHUB_TMUX_BIND_V3\nrelative\nahub-00000000-0000-0000-0000-000000000002\n\n/project\nnull</bash-stdout>",
      2,
    ),
  ).toEqual([{ ordinal: 2, valid: false }]);
  expect(
    claudeBindingAttempts(
      "<bash-stderr>AHUB_TMUX_BIND_V3\n/tmp/tmux.sock\nahub-00000000-0000-0000-0000-000000000002\n\n/project\nnull</bash-stderr>",
      3,
    ),
  ).toEqual([]);
});

it.each([false, true])(
  "routes explicit Claude home and native launch flags (resume=%s)",
  async (resume) => {
    const tmux = new TmuxLauncher();
    const launch = vi.spyOn(tmux, "launch").mockRejectedValue(new Error("Stop before bootstrap"));
    const manager = new ClaudeSessionManager("/claude home", tmux);
    const nativeId = "11111111-2222-4333-8444-555555555555";
    await expect(
      manager.launch({
        operationId: "00000000-0000-4000-8000-000000000001",
        workingDirectory: "/launch-directory",
        projectDirectory: "/project",
        worktree: !resume,
        yolo: true,
        ...(resume ? { resumeNativeId: nativeId } : {}),
      }),
    ).rejects.toThrow("Stop before bootstrap");
    expect(launch).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "/launch-directory",
      [
        "env",
        "CLAUDE_CONFIG_DIR=/claude home",
        "claude",
        ...(resume ? ["--resume", nativeId] : ["--worktree"]),
        "--dangerously-skip-permissions",
      ],
    );
  },
);

it("provides shared interrupt steps and two pairs of exit interrupts", () => {
  expect(claudeInteraction(null, null).interruptSteps).toBe(interruptSteps);
  let elapsed = 0;
  expect(
    new ClaudeSessionManager("/test/home").exitSteps().map((step) => ({
      keys: step.keys,
      atMs: (elapsed += step.delayMs),
    })),
  ).toEqual([
    { keys: ["C-c"], atMs: 0 },
    { keys: ["C-c"], atMs: 200 },
    { keys: ["C-c"], atMs: 2600 },
    { keys: ["C-c"], atMs: 2800 },
  ]);
});

const target = {
  socketPath: "/tmp/claude-test.sock",
  sessionName: "ahub-00000000-0000-4000-8000-000000000002",
};
const launchOptions = {
  operationId: "00000000-0000-4000-8000-000000000001",
  workingDirectory: "/project",
  worktree: false,
  yolo: false,
};
const readyScreen = { content: "Welcome\n\n❯\u00a0\nStatus", cursorX: 2, cursorY: 2 };

function mockClaudeLaunch() {
  const tmux = new TmuxLauncher();
  vi.spyOn(tmux, "launch").mockResolvedValue(target);
  const capture = vi
    .spyOn(tmux.transport, "captureTerminalWithCursor")
    .mockResolvedValue(readyScreen);
  const send = vi.spyOn(tmux.transport, "sendMessage").mockResolvedValue();
  return { manager: new ClaudeSessionManager("/home", tmux), tmux, capture, send };
}

it("accepts a single ready sample and sends the binding once", async () => {
  const { manager, capture, send } = mockClaudeLaunch();
  await expect(manager.launch(launchOptions)).resolves.toEqual(target);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledExactlyOnceWith(
    target,
    claudeBindingCommand(launchOptions.operationId),
  );
});

it("waits one second between samples", async () => {
  vi.useFakeTimers();
  const { manager, capture, send } = mockClaudeLaunch();
  capture.mockResolvedValueOnce(null);
  const launch = manager.launch(launchOptions);
  await vi.advanceTimersByTimeAsync(999);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(launch).resolves.toEqual(target);
  expect(capture).toHaveBeenCalledTimes(2);
});

it.each([
  { content: "Starting…", cursorX: 2, cursorY: 0 },
  {
    content: "Is this a project you trust?\n❯ No, exit\n  Yes, I trust this folder",
    cursorX: 2,
    cursorY: 1,
  },
  // A dialog retains a previous empty prompt, but owns the cursor elsewhere.
  { content: "❯ \n\nUpdate available\n❯ Restart now\n  Later", cursorX: 2, cursorY: 3 },
  { content: "❯ \n\nStatus", cursorX: 8, cursorY: 0 },
  null,
])("never sends on an unconfirmed screen: %j", async (screen) => {
  vi.useFakeTimers();
  const { manager, capture, send } = mockClaudeLaunch();
  capture.mockResolvedValue(screen);
  const result = manager.launch(launchOptions).then(
    () => null,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(BINDING_PROMPT_WAIT_MS);
  expect(await result).toMatchObject({
    outcome: "unknown",
    target,
    attachCommand: expect.stringContaining("tmux"),
    message: expect.stringContaining("readiness was not confirmed"),
  });
  expect(send).not.toHaveBeenCalled();
});

it("does not count a capture that finishes after the readiness deadline", async () => {
  vi.useFakeTimers();
  const { manager, capture, send } = mockClaudeLaunch();
  capture.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, BINDING_PROMPT_WAIT_MS));
    return readyScreen;
  });
  const result = manager.launch(launchOptions).then(
    () => null,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(BINDING_PROMPT_WAIT_MS + 100);
  expect(await result).toMatchObject({ outcome: "unknown" });
  expect(send).not.toHaveBeenCalled();
});

it.each(["capture", "send"])("preserves recovery information when %s fails", async (failure) => {
  const tmux = new TmuxLauncher();
  const target = {
    socketPath: "/tmp/claude-test.sock",
    sessionName: "ahub-00000000-0000-0000-0000-000000000002",
  };
  vi.spyOn(tmux, "launch").mockResolvedValue(target);
  const capture = vi
    .spyOn(tmux.transport, "captureTerminalWithCursor")
    .mockResolvedValue(readyScreen);
  const send = vi.spyOn(tmux.transport, "sendMessage").mockResolvedValue();
  if (failure === "capture") capture.mockRejectedValue(new Error("capture failed"));
  else send.mockRejectedValue(new Error("send failed"));
  await expect(
    new ClaudeSessionManager("/home", tmux).launch({
      operationId: "00000000-0000-4000-8000-000000000001",
      workingDirectory: "/project",
      worktree: false,
      yolo: false,
    }),
  ).rejects.toMatchObject({
    outcome: "unknown",
    target,
    attachCommand: expect.any(String),
    message: `${failure} failed`,
  });
  expect(send).toHaveBeenCalledTimes(failure === "capture" ? 0 : 1);
});

it("deletes Claude logs and subagents across projects while preserving other content", async () => {
  const home = await createTempDirectory("claude-delete-");
  const id = "11111111-2222-4333-8444-555555555555";
  for (const project of ["one", "two"]) {
    const root = join(home, "projects", project);
    await mkdir(join(root, id, "subagents", "nested"), { recursive: true });
    await writeFile(join(root, `${id}.jsonl`), "history");
    await writeFile(join(root, id, "subagents", "nested", "agent.jsonl"), "agent");
    await writeFile(join(root, id, "keep"), "keep");
    await writeFile(join(root, "other.jsonl"), "other");
  }
  const manager = new ClaudeSessionManager(home);
  await expect(manager.delete("../invalid")).rejects.toThrow("Invalid Claude");
  await manager.delete(id);
  await manager.delete(id);
  for (const project of ["one", "two"]) {
    const root = join(home, "projects", project);
    await expect(access(join(root, `${id}.jsonl`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, id, "subagents"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, id, "keep"), "utf8")).toBe("keep");
    expect(await readFile(join(root, "other.jsonl"), "utf8")).toBe("other");
  }
});

it.each(["V1", "UNKNOWN"])("ignores Claude binding marker %s", (version) => {
  expect(
    claudeBindingAttempts(
      `<bash-stdout>AHUB_TMUX_BIND_${version}\n/tmp/socket\nahub-00000000-0000-0000-0000-000000000001\n\n/project\nnull</bash-stdout>`,
      1,
    ),
  ).toEqual([]);
});

it("emits V3 using launcher metadata without executing commands in Claude's shell", () => {
  const sessionName = "ahub-00000000-0000-0000-0000-000000000001";
  const command = claudeBindingCommand("", "/project", "Task");
  expect(command).not.toContain("$(");
  const output = execFileSync("bash", ["-c", command.slice(2)], {
    encoding: "utf8",
    env: { ...process.env, TMUX: "/tmp/test.sock,123,0", AHUB_TMUX_SESSION_NAME: sessionName },
  });
  expect(claudeBindingAttempts(`<bash-stdout>${output}</bash-stdout>`, 1)).toEqual([
    {
      ordinal: 1,
      valid: true,
      socketPath: "/tmp/test.sock",
      sessionName,
      projectDirectory: "/project",
      taskName: "Task",
    },
  ]);
});

it("skips missing snapshots, preserves context, and resets it for each launch", async () => {
  vi.useFakeTimers();
  const check = vi
    .spyOn(readyScript, "checkClaudeReadyScript")
    .mockResolvedValueOnce({ ready: false, context: "next" })
    .mockResolvedValueOnce({ ready: true, context: "done" })
    .mockResolvedValueOnce({ ready: false, context: "next" })
    .mockResolvedValueOnce({ ready: true, context: "done" });
  const { tmux, capture, send } = mockClaudeLaunch();
  const screen = { content: "Starting…", cursorX: 0, cursorY: 0 };
  capture
    .mockResolvedValue(screen)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(screen)
    .mockResolvedValueOnce(null);
  const manager = new ClaudeSessionManager("/home", tmux, "/ready");
  const first = manager.launch(launchOptions);
  await vi.advanceTimersByTimeAsync(3_000);
  await expect(first).resolves.toEqual(target);
  const second = manager.launch(launchOptions);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(second).resolves.toEqual(target);
  expect(check.mock.calls.map(([, current, context]) => ({ current, context }))).toEqual([
    { current: screen, context: "" },
    { current: screen, context: "next" },
    { current: screen, context: "" },
    { current: screen, context: "next" },
  ]);
  expect(capture).toHaveBeenCalledTimes(6);
  expect(send).toHaveBeenCalledTimes(2);
});

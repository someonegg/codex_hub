import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { CodexSessionManager } from "../../src/server/adapters/codex/session-manager.js";
import {
  MAX_TERMINAL_PREVIEW_BYTES,
  TmuxInteractionService,
} from "../../src/server/interaction/tmux-service.js";
import { type TmuxBinding } from "../../src/server/interaction/transport.js";
import { SessionExitService } from "../../src/server/management/session-exit-service.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

beforeAll(() => {
  if (spawnSync("tmux", ["-V"]).status !== 0) {
    throw new Error("tmux is required for the tmux integration test");
  }
});

describe("tmux interaction integration", () => {
  it("validates and captures only the current real tmux pane as bounded plain text", async () => {
    const directory = await createTempDirectory("codex-real-tmux-");
    const socketPath = join(directory, "server.sock");
    execFileSync("tmux", [
      "-S",
      socketPath,
      "new-session",
      "-d",
      "-x",
      "120",
      "-y",
      "20",
      "-s",
      "codex-hub-test",
      "i=0; while [ \"$i\" -lt 80 ]; do printf 'HISTORY-%03d\\n' \"$i\"; i=$((i + 1)); done; printf '\\033[31mTAIL-世界\\033[0m\\n'; sleep 30",
    ]);
    try {
      const paneId = execFileSync(
        "tmux",
        ["-S", socketPath, "display-message", "-p", "-t", "codex-hub-test", "#{pane_id}"],
        { encoding: "utf8" },
      ).trim();
      const service = new TmuxInteractionService();
      const binding = await service.connect({
        ordinal: 1,
        valid: true,
        socketPath,
        paneId,
      });
      expect(binding.paneId).toBe(paneId);
      await service.sendKeys(binding, ["Up", "Down", "Left", "Right", "BTab"]);
      const preview = await waitForPreview(service, binding, "TAIL-世界");
      expect(preview.truncated).toBe(false);
      expect(Buffer.byteLength(preview.content, "utf8")).toBeLessThanOrEqual(
        MAX_TERMINAL_PREVIEW_BYTES,
      );
      expect(preview.content).toContain("TAIL-世界");
      expect(preview.content).not.toContain("HISTORY-000");
      expect(preview.content).not.toContain("\u001b[");
      expect(preview.content).not.toContain("�");
      // Keep the server alive while the original target disappears.
      execFileSync("tmux", ["-S", socketPath, "new-session", "-d", "-s", "other", "sleep 30"]);
      execFileSync("tmux", ["-S", socketPath, "kill-pane", "-t", paneId]);
      await expect(service.captureTerminal(binding)).rejects.toMatchObject({
        code: "disconnected",
      });
      await expect(service.sendKeys(binding, ["Enter"])).rejects.toMatchObject({
        code: "disconnected",
      });
    } finally {
      spawnSync("tmux", ["-S", socketPath, "kill-server"]);
    }
  });
});

async function waitForPreview(
  service: TmuxInteractionService,
  binding: TmuxBinding,
  marker: string,
) {
  const deadline = Date.now() + 2_000;
  do {
    const preview = await service.captureTerminal(binding);
    if (preview.content.includes(marker)) return preview;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for terminal marker: ${marker}`);
}

it("forces only the transferred pane closed when its outer shell ignores interrupts and EOF", async () => {
  const directory = await createTempDirectory("tmux-exit-");
  const socketPath = join(directory, "server.sock");
  const output = execFileSync(
    "tmux",
    [
      "-S",
      socketPath,
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      "transferred",
      "bash --noprofile --norc -i",
    ],
    { encoding: "utf8" },
  );
  const target = { socketPath, paneId: output.trim() };
  const transport = new TmuxInteractionService();
  try {
    execFileSync("tmux", ["-S", socketPath, "new-session", "-d", "-s", "untouched", "sleep 30"]);
    execFileSync("tmux", [
      "-S",
      socketPath,
      "send-keys",
      "-t",
      target.paneId,
      "set -o ignoreeof; trap '' INT; printf '%s%s\\n' EXIT- READY",
      "Enter",
    ]);
    await waitForPreview(transport, target, "EXIT-READY");
    const killTarget = vi.fn(async (pane: TmuxBinding, _id: string, check: () => void) =>
      transport.killPane(pane, check),
    );
    let now = 0;
    const exit = new SessionExitService(
      {
        inspectTarget: (pane) => transport.inspect(pane),
        sendExitKeys: (pane, _id, keys, check) => transport.sendKeys(pane, keys, check),
        killTarget,
      },
      () => now,
    );
    const task = exit.start("manual", target, new CodexSessionManager("/unused"), () => {});
    for (const value of [0, 1_000, 2_000, 6_000]) {
      now = value;
      expect(await task.advance()).toBe(false);
    }
    expect(killTarget).not.toHaveBeenCalled();
    now = 15_000;
    expect(await task.advance()).toBe(false);
    expect(killTarget).toHaveBeenCalledOnce();
    expect(await task.advance()).toBe(true);
    expect(
      execFileSync("tmux", ["-S", socketPath, "list-sessions", "-F", "#{session_name}"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("untouched");
  } finally {
    spawnSync("tmux", ["-S", socketPath, "kill-server"]);
  }
});

it("shares control listeners without changing sizes and rebuilds after session exit", async () => {
  const { createTmuxPreviewListener } = await import(
    "../../src/server/interaction/tmux-preview-listener.js"
  );
  const { TerminalPreviewService } = await import(
    "../../src/server/interaction/terminal-preview-service.js"
  );
  const directory = await createTempDirectory("codex-control-tmux-");
  const socketPath = join(directory, "server.sock");
  const run = (...args: string[]) =>
    execFileSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" }).trim();
  run("new-session", "-d", "-x", "101", "-y", "31", "-s", "preview", "sleep 60");
  const transport = new TmuxInteractionService();
  const binding = await transport.connect({
    valid: true,
    ordinal: 0,
    socketPath,
    paneId: run("display-message", "-p", "-t", "preview", "#{pane_id}"),
  });
  const capture = vi.fn((target: TmuxBinding) => transport.captureTerminal(target));
  const listener = createTmuxPreviewListener();
  const service = new TerminalPreviewService(capture, listener);
  const other = listener(
    binding,
    () => {},
    () => {},
  );
  try {
    await other.ready;
    const [first, second] = await Promise.all([
      service.preview("session", binding, () => {}),
      service.preview("session", binding, () => {}),
    ]);
    expect(first).toEqual(second);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(run("list-clients", "-F", "#{client_control_mode}")).toBe("1");
    expect(run("display-message", "-p", "-t", binding.paneId, "#{pane_width}x#{pane_height}")).toBe(
      "101x31",
    );
    const waiting = service.preview("session", binding, () => {}, first!.revision);
    run("respawn-pane", "-k", "-t", binding.paneId, "printf 'CONTROL-OUTPUT'; sleep 60");
    expect((await waiting)!.content).toContain("CONTROL-OUTPUT");
    const pending = service.preview(
      "session",
      binding,
      () => {},
      (await service.preview("session", binding, () => {}))!.revision,
    );
    const rejected = expect(pending).rejects.toThrow();
    run("kill-session", "-t", "preview");
    await rejected;
    run("new-session", "-d", "-s", "rebuilt", "sleep 60");
    const rebound = await transport.connect({
      valid: true,
      ordinal: 1,
      socketPath,
      paneId: run("display-message", "-p", "-t", "rebuilt", "#{pane_id}"),
    });
    expect(await service.preview("session", rebound, () => {})).toBeTruthy();
  } finally {
    service.close();
    other.close();
    spawnSync("tmux", ["-S", socketPath, "kill-server"]);
  }
}, 15000);

it.each(["move-window", "join-pane"])(
  "rebuilds preview listening after cross-session %s",
  async (operation) => {
    const { TerminalPreviewService } = await import(
      "../../src/server/interaction/terminal-preview-service.js"
    );
    const directory = await createTempDirectory("codex-moved-preview-");
    const socketPath = join(directory, "server.sock");
    const run = (...args: string[]) =>
      execFileSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" }).trim();
    const transport = new TmuxInteractionService();
    const service = new TerminalPreviewService(
      (binding, guard) => transport.captureTerminal(binding, guard),
      undefined,
      (binding) => transport.resolveTarget({ valid: true, ordinal: 0, ...binding }),
    );
    try {
      run("new-session", "-d", "-s", "source", "sleep 60");
      run("new-window", "-d", "-t", "source", "-n", "keep", "sleep 60");
      run("new-session", "-d", "-s", "destination", "sleep 60");
      const paneId = run("display-message", "-p", "-t", "source:0", "#{pane_id}");
      const attempt = { valid: true as const, ordinal: 0, socketPath, paneId };
      const binding = await transport.connect(attempt);
      const first = await service.preview("session", binding, () => {});
      const pending = service.preview("session", binding, () => {}, first!.revision);
      const rejected = expect(pending).rejects.toThrow("tmux session changed");
      if (operation === "move-window") run(operation, "-s", "source:0", "-t", "destination:1");
      else run(operation, "-s", paneId, "-t", "destination:0");
      await rejected;
      const moved = await transport.connect(attempt);
      expect(moved.paneId).toBe(paneId);
      expect(moved.sessionName).toBe("destination");
      const next = await service.preview("session", moved, () => {});
      const waiting = service.preview("session", moved, () => {}, next!.revision);
      run("respawn-pane", "-k", "-t", paneId, "printf 'MOVED-OUTPUT'; sleep 60");
      expect((await waiting)!.content).toContain("MOVED-OUTPUT");
    } finally {
      service.close();
      spawnSync("tmux", ["-S", socketPath, "kill-server"]);
    }
  },
  10000,
);

it("sends chat messages while terminal preview is waiting", async () => {
  const { TerminalPreviewService } = await import(
    "../../src/server/interaction/terminal-preview-service.js"
  );
  const directory = await createTempDirectory("codex-send-preview-");
  const socketPath = join(directory, "server.sock");
  const run = (...args: string[]) =>
    execFileSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" }).trim();
  const transport = new TmuxInteractionService();
  const service = new TerminalPreviewService(
    (target, guard) => transport.captureTerminal(target, guard),
    undefined,
    (target) => transport.resolveTarget({ valid: true, ordinal: 0, ...target }),
  );
  try {
    run("new-session", "-d", "-s", "chat", "bash --noprofile --norc -i");
    const binding = await transport.connect({
      valid: true,
      ordinal: 0,
      socketPath,
      paneId: run("display-message", "-p", "-t", "chat", "#{pane_id}"),
    });
    await vi.waitFor(() =>
      expect(run("capture-pane", "-p", "-t", binding.paneId)).toContain("bash"),
    );
    const first = (await service.preview("session", binding, () => {}))!;
    const waiting = service.preview("session", binding, () => {}, first.revision);
    void waiting.catch(() => {});
    await transport.sendMessage(binding, "printf 'CHAT-%s\\n' SENT");
    const next = await waiting;
    expect(next).toBeTruthy();
    expect((await service.preview("session", binding, () => {}))!.content).toContain("CHAT-SENT");
  } finally {
    service.close();
    spawnSync("tmux", ["-S", socketPath, "kill-server"]);
  }
}, 15000);

it("transports real tmux output as a shared line delta", async () => {
  const { TerminalPreviewService } = await import(
    "../../src/server/interaction/terminal-preview-service.js"
  );
  const { applyPreview } = await import("../../src/client/state/terminal-preview-patch.js");
  const directory = await createTempDirectory("codex-delta-tmux-");
  const socketPath = join(directory, "server.sock");
  const run = (...args: string[]) =>
    execFileSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" }).trim();
  run(
    "new-session",
    "-d",
    "-x",
    "100",
    "-y",
    "30",
    "-s",
    "delta",
    "i=0; while [ \"$i\" -lt 20 ]; do printf 'stable terminal line %03d with padding for delta transport\\n' \"$i\"; i=$((i + 1)); done; read line; printf 'DELTA-世界😀\\n'; sleep 60",
  );
  const transport = new TmuxInteractionService();
  const binding = await transport.connect({
    valid: true,
    ordinal: 0,
    socketPath,
    paneId: run("display-message", "-p", "-t", "delta", "#{pane_id}"),
  });
  const service = new TerminalPreviewService((target, guard) =>
    transport.captureTerminal(target, guard),
  );
  try {
    await vi.waitFor(() =>
      expect(run("capture-pane", "-p", "-t", binding.paneId)).toContain("stable terminal line 019"),
    );
    const first = (await service.preview("session", binding, () => {}))!;
    if (typeof first.content !== "string") throw new Error("Expected initial full snapshot");
    const a = service.preview("session", binding, () => {}, first.revision);
    const b = service.preview("session", binding, () => {}, first.revision);
    run(
      "respawn-pane",
      "-k",
      "-t",
      binding.paneId,
      "i=0; while [ \"$i\" -lt 20 ]; do printf 'stable terminal line %03d with padding for delta transport\\n' \"$i\"; i=$((i + 1)); done; printf 'DELTA-世界😀\\n'; sleep 60",
    );
    const [next, shared] = await Promise.all([a, b]);
    expect(next).toEqual(shared);
    expect(next).toHaveProperty("patches");
    const restored = applyPreview(first, next!);
    expect(restored!.content).toContain("DELTA-世界😀");
    expect(restored!.content).toBe((await service.preview("session", binding, () => {}))!.content);
  } finally {
    service.close();
    spawnSync("tmux", ["-S", socketPath, "kill-server"]);
  }
}, 15000);

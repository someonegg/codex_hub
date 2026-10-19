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

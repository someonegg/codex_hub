import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  MAX_TERMINAL_PREVIEW_BYTES,
  TmuxInteractionService,
} from "../../src/server/interaction/tmux-service.js";
import { type TmuxBinding } from "../../src/server/interaction/transport.js";
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

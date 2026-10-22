import { execFileSync, spawnSync } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type {
  TerminalPreviewMessage,
  TerminalPreviewSnapshot,
} from "../../src/shared/api-contract.js";

import { applyPreview } from "../../src/client/state/terminal-preview-patch.js";
import { codexInterruptSteps } from "../../src/server/adapters/codex/interaction-parser.js";
import { CodexSessionManager } from "../../src/server/adapters/codex/session-manager.js";
import { TerminalPreviewService } from "../../src/server/interaction/terminal-preview-service.js";
import {
  MAX_TERMINAL_PREVIEW_BYTES,
  TmuxInteractionService,
} from "../../src/server/interaction/tmux-service.js";
import { type TmuxBinding } from "../../src/server/interaction/transport.js";
import { SessionExitService } from "../../src/server/management/session-exit-service.js";
import { startPreviewServer } from "../helpers/preview-websocket.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

beforeAll(() => {
  if (spawnSync("tmux", ["-V"]).status !== 0) {
    throw new Error("tmux is required for the tmux integration test");
  }
});

describe("tmux interaction integration", () => {
  it("delivers interrupt End then Escape separately through a real terminal", async () => {
    const directory = await createTempDirectory("codex-interrupt-tmux-");
    const socketPath = join(directory, "server.sock");
    const script = join(directory, "read.cjs");
    const output = join(directory, "events.json");
    await writeFile(
      script,
      `
      const fs = require("node:fs");
      process.stdin.setRawMode(true);
      const events = [];
      process.stdin.on("data", data => {
        events.push({ bytes: [...data], at: Date.now() });
        fs.writeFileSync(process.argv[2], JSON.stringify(events));
      });
      console.log("READER-READY");
    `,
    );
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    execFileSync("tmux", [
      "-S",
      socketPath,
      "new-session",
      "-d",
      "-s",
      "interrupt-test",
      [process.execPath, script, output].map(quote).join(" "),
    ]);
    try {
      const paneId = execFileSync(
        "tmux",
        ["-S", socketPath, "display-message", "-p", "-t", "interrupt-test", "#{pane_id}"],
        { encoding: "utf8" },
      ).trim();
      const service = new TmuxInteractionService();
      const binding = await service.connect({ ordinal: 1, valid: true, socketPath, paneId });
      await waitForPreview(service, binding, "READER-READY");
      await service.sendKeys(binding, codexInterruptSteps());
      let events: { bytes: number[]; at: number }[] = [];
      await vi.waitFor(async () => {
        events = JSON.parse(await readFile(output, "utf8"));
        expect(events.flatMap((event) => event.bytes)).toEqual([27, 91, 52, 126, 27]);
      });
      const end = events.find((event) => event.bytes.includes(126))!;
      const escape = events.at(-1)!;
      expect(escape.bytes).toEqual([27]);
      expect(escape.at - end.at).toBeGreaterThanOrEqual(80);
    } finally {
      spawnSync("tmux", ["-S", socketPath, "kill-server"]);
    }
  });

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
      await service.sendKeys(binding, [
        { keys: ["Up", "Down", "Left", "Right", "BTab"], delayMs: 0 },
      ]);
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
      await expect(
        service.sendKeys(binding, [{ keys: ["Enter"], delayMs: 0 }]),
      ).rejects.toMatchObject({
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
        sendExitKeys: (pane, _id, keys, check) =>
          transport.sendKeys(pane, [{ keys, delayMs: 0 }], check),
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

it("shares WebSocket preview captures without changing sizes and rebuilds after session exit", async () => {
  const directory = await createTempDirectory("codex-control-tmux-");
  const socketPath = join(directory, "server.sock");
  const run = (...args: string[]) =>
    execFileSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" }).trim();
  run("new-session", "-d", "-x", "101", "-y", "31", "-s", "preview", "sleep 60");
  const transport = new TmuxInteractionService();
  let binding = await transport.connect({
    valid: true,
    ordinal: 0,
    socketPath,
    paneId: run("display-message", "-p", "-t", "preview", "#{pane_id}"),
  });
  const capture = vi.fn((target: TmuxBinding, guard: () => void) =>
    transport.captureTerminal(target, guard),
  );
  const service = new TerminalPreviewService(capture);
  const server = await startPreviewServer({
    subscribePreview: async (session, frame, fail, signal) =>
      service.subscribe(session, binding, () => {}, frame, fail, signal),
  });
  try {
    const a = server.connect(),
      b = server.connect();
    await vi.waitFor(() => {
      expect(a.messages).toHaveLength(1);
      expect(b.messages).toHaveLength(1);
    });
    expect(a.messages).toEqual(b.messages);
    expect(capture).toHaveBeenCalledOnce();
    expect(
      run("display-message", "-p", "-t", binding.paneId, "#{window_width}x#{window_height}"),
    ).toBe("101x31");
    run("respawn-pane", "-k", "-t", binding.paneId, "printf 'CONTROL-OUTPUT'; sleep 60");
    await vi.waitFor(() => expect(reconstruct(a.messages)?.content).toContain("CONTROL-OUTPUT"), {
      timeout: 5000,
    });
    run("kill-session", "-t", "preview");
    await vi.waitFor(
      () => expect(a.messages.at(-1)).toMatchObject({ type: "error", retryable: true }),
      { timeout: 5000 },
    );
    run("new-session", "-d", "-s", "rebuilt", "sleep 60");
    binding = await transport.connect({
      valid: true,
      ordinal: 1,
      socketPath,
      paneId: run("display-message", "-p", "-t", "rebuilt", "#{pane_id}"),
    });
    const rebuilt = server.connect();
    await vi.waitFor(() => expect(rebuilt.messages[0]).toMatchObject({ type: "snapshot" }));
  } finally {
    await server.close();
    service.close();
    spawnSync("tmux", ["-S", socketPath, "kill-server"]);
  }
}, 15000);

it.each(["move-window", "join-pane"])(
  "rebuilds WebSocket preview after cross-session %s",
  async (operation) => {
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
    run("new-session", "-d", "-s", "source", "sleep 60");
    run("new-window", "-d", "-t", "source", "-n", "keep", "sleep 60");
    run("new-session", "-d", "-s", "destination", "sleep 60");
    const paneId = run("display-message", "-p", "-t", "source:0", "#{pane_id}");
    const attempt = { valid: true as const, ordinal: 0, socketPath, paneId };
    const server = await startPreviewServer({
      subscribePreview: async (session, frame, fail, signal) =>
        service.subscribe(session, await transport.connect(attempt), () => {}, frame, fail, signal),
    });
    try {
      const first = server.connect();
      await vi.waitFor(() => expect(first.messages).toHaveLength(1));
      if (operation === "move-window") run(operation, "-s", "source:0", "-t", "destination:1");
      else run(operation, "-s", paneId, "-t", "destination:0");
      await vi.waitFor(
        () =>
          expect(first.messages.at(-1)).toMatchObject({
            type: "error",
            code: "interaction_not_connected",
            retryable: false,
          }),
        { timeout: 5000 },
      );
      const moved = await transport.connect(attempt);
      expect(moved.paneId).toBe(paneId);
      expect(moved.sessionName).toBe("destination");
      const next = server.connect();
      await vi.waitFor(() => expect(next.messages[0]).toMatchObject({ type: "snapshot" }));
      run("respawn-pane", "-k", "-t", paneId, "printf 'MOVED-OUTPUT'; sleep 60");
      await vi.waitFor(
        () => expect(reconstruct(next.messages)?.content).toContain("MOVED-OUTPUT"),
        { timeout: 5000 },
      );
    } finally {
      await server.close();
      service.close();
      spawnSync("tmux", ["-S", socketPath, "kill-server"]);
    }
  },
  15000,
);

it("sends chat messages while WebSocket preview is subscribed", async () => {
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
  run("new-session", "-d", "-s", "chat", "bash --noprofile --norc -i");
  const binding = await transport.connect({
    valid: true,
    ordinal: 0,
    socketPath,
    paneId: run("display-message", "-p", "-t", "chat", "#{pane_id}"),
  });
  const server = await startPreviewServer({
    subscribePreview: async (session, frame, fail, signal) =>
      service.subscribe(session, binding, () => {}, frame, fail, signal),
  });
  try {
    await vi.waitFor(() =>
      expect(run("capture-pane", "-p", "-t", binding.paneId)).toContain("bash"),
    );
    const client = server.connect();
    await vi.waitFor(() => expect(client.messages).toHaveLength(1));
    await transport.sendMessage(binding, "printf 'CHAT-%s\\n' SENT");
    await vi.waitFor(() => expect(reconstruct(client.messages)?.content).toContain("CHAT-SENT"), {
      timeout: 5000,
    });
  } finally {
    await server.close();
    service.close();
    spawnSync("tmux", ["-S", socketPath, "kill-server"]);
  }
}, 15000);

it("transports real tmux output over WebSocket as a shared line delta", async () => {
  const directory = await createTempDirectory("codex-delta-tmux-");
  const socketPath = join(directory, "server.sock");
  const run = (...args: string[]) =>
    execFileSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" }).trim();
  const lines =
    'i=0; while [ "$i" -lt 20 ]; do printf \'stable terminal line %03d with padding for delta transport\\n\' "$i"; i=$((i + 1)); done; ';
  run("new-session", "-d", "-x", "100", "-y", "30", "-s", "delta", `${lines}read line; sleep 60`);
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
  const server = await startPreviewServer({
    subscribePreview: async (session, frame, fail, signal) =>
      service.subscribe(session, binding, () => {}, frame, fail, signal),
  });
  try {
    await vi.waitFor(() =>
      expect(run("capture-pane", "-p", "-t", binding.paneId)).toContain("stable terminal line 019"),
    );
    const a = server.connect(),
      b = server.connect();
    await vi.waitFor(() => {
      expect(a.messages).toHaveLength(1);
      expect(b.messages).toHaveLength(1);
    });
    run("respawn-pane", "-k", "-t", binding.paneId, `${lines}printf 'DELTA-世界😀\\n'; sleep 60`);
    await vi.waitFor(() => expect(reconstruct(a.messages)?.content).toContain("DELTA-世界😀"), {
      timeout: 5000,
    });
    await vi.waitFor(() => expect(b.messages).toEqual(a.messages));
    expect(a.messages[1]).toMatchObject({ type: "delta" });
    const fresh = server.connect();
    await vi.waitFor(() => expect(fresh.messages[0]).toMatchObject({ type: "snapshot" }));
    expect(reconstruct(fresh.messages)).toEqual(reconstruct(a.messages));
  } finally {
    await server.close();
    service.close();
    spawnSync("tmux", ["-S", socketPath, "kill-server"]);
  }
}, 15000);

function reconstruct(messages: TerminalPreviewMessage[]): TerminalPreviewSnapshot | null {
  let snapshot: TerminalPreviewSnapshot | null = null;
  for (const message of messages) {
    if (message.type === "error") continue;
    snapshot = applyPreview(snapshot, message);
    if (!snapshot) throw new Error("Invalid preview frame");
  }
  return snapshot;
}

import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { interruptSteps as codexInterruptSteps } from "../../src/server/adapters/shared/session-management.js";
import type {
  TerminalPreviewMessage,
  TerminalPreviewSnapshot,
} from "../../src/shared/api-contract.js";

import { applyPreview } from "../../src/client/state/terminal-preview-patch.js";
import { CodexSessionManager } from "../../src/server/adapters/codex/session-manager.js";
import type { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import { TerminalPreviewService } from "../../src/server/interaction/terminal-preview-service.js";
import type { PreviewListener } from "../../src/server/interaction/tmux-preview-listener.js";
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
  it("captures the visible terminal with zero-based cursor coordinates", async () => {
    const directory = await createTempDirectory("tmux-cursor-");
    const socketPath = join(directory, "server.sock");
    const sessionName = "ahub-00000000-0000-4000-8000-000000000001";
    const script = join(directory, "screen.cjs");
    await writeFile(
      script,
      `process.stdout.write("\\x1b[2J\\x1b[HHeader\\n❯ \\nStatus\\x1b[2;3H"); process.stdin.resume();`,
    );
    execFileSync("tmux", [
      "-S",
      socketPath,
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-x",
      "120",
      "-y",
      "40",
      process.execPath,
      script,
    ]);
    try {
      const service = new TmuxInteractionService();
      const binding = { socketPath, sessionName };
      await waitForPreview(service, binding, "Header");
      const snapshot = await service.captureTerminalWithCursor(binding);
      expect(snapshot).toMatchObject({ cursorX: 2, cursorY: 1 });
      expect(snapshot?.content.split("\n").slice(0, 3)).toEqual(["Header", "❯", "Status"]);
    } finally {
      execFileSync("tmux", ["-S", socketPath, "kill-server"]);
    }
  });

  it("delivers interrupt Ctrl+U then Escape separately through a real terminal", async () => {
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
    const sessionName = "ahub-00000000-0000-0000-0000-000000000001";
    execFileSync("tmux", [
      "-S",
      socketPath,
      "new-session",
      "-d",
      "-s",
      sessionName,
      [process.execPath, script, output].map(quote).join(" "),
    ]);
    try {
      const service = new TmuxInteractionService();
      const binding = await service.connect({ ordinal: 1, valid: true, socketPath, sessionName });
      await waitForPreview(service, binding, "READER-READY");
      await service.sendKeys(binding, codexInterruptSteps());
      let events: { bytes: number[]; at: number }[] = [];
      await vi.waitFor(async () => {
        events = JSON.parse(await readFile(output, "utf8"));
        expect(events.flatMap((event) => event.bytes)).toEqual([21, 27]);
      });
      const clearInput = events.find((event) => event.bytes.includes(21))!;
      const escape = events.at(-1)!;
      expect(escape.bytes).toEqual([27]);
      expect(escape.at - clearInput.at).toBeGreaterThanOrEqual(80);
    } finally {
      spawnSync("tmux", ["-S", socketPath, "kill-server"]);
    }
  });

  it("validates and captures only the current real tmux pane as bounded plain text", async () => {
    const directory = await createTempDirectory("codex-real-tmux-");
    const socketPath = join(directory, "server.sock");
    const sessionName = "ahub-00000000-0000-0000-0000-000000000002";
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
      sessionName,
      "i=0; while [ \"$i\" -lt 80 ]; do printf 'HISTORY-%03d\\n' \"$i\"; i=$((i + 1)); done; printf '\\033[31mTAIL-世界\\033[0m\\n'; sleep 30",
    ]);
    try {
      const service = new TmuxInteractionService();
      const binding = await service.connect({
        ordinal: 1,
        valid: true,
        socketPath,
        sessionName,
      });
      expect(binding.sessionName).toBe(sessionName);
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
      execFileSync("tmux", [
        "-S",
        socketPath,
        "new-session",
        "-d",
        "-s",
        "ahub-00000000-0000-0000-0000-000000000010",
        "sleep 30",
      ]);
      execFileSync("tmux", ["-S", socketPath, "kill-pane", "-t", sessionName]);
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

it("forces only the bound session closed when its outer shell ignores interrupts and EOF", async () => {
  const directory = await createTempDirectory("tmux-exit-");
  const socketPath = join(directory, "server.sock");
  const sessionName = "ahub-00000000-0000-0000-0000-000000000003";
  execFileSync("tmux", [
    "-S",
    socketPath,
    "new-session",
    "-d",
    "-s",
    sessionName,
    "bash --noprofile --norc -i",
  ]);
  const target = { socketPath, sessionName };
  const transport = new TmuxInteractionService();
  try {
    execFileSync("tmux", [
      "-S",
      socketPath,
      "new-session",
      "-d",
      "-s",
      "ahub-00000000-0000-0000-0000-000000000009",
      "sleep 30",
    ]);
    execFileSync("tmux", [
      "-S",
      socketPath,
      "send-keys",
      "-t",
      target.sessionName,
      "set -o ignoreeof; trap '' INT; printf '%s%s\\n' EXIT- READY",
      "Enter",
    ]);
    await waitForPreview(transport, target, "EXIT-READY");
    const killTarget = vi.fn(async (pane: TmuxBinding, _id: string, check: () => void) =>
      transport.killSession(pane, check),
    );
    const sendExitKeys = vi.fn<SessionInteractionService["sendExitKeys"]>(
      (pane, _id, keys, check) => transport.sendKeys(pane, [{ keys, delayMs: 0 }], check),
    );
    let now = 0;
    const exit = new SessionExitService(
      {
        inspectTarget: (pane) => transport.inspect(pane),
        sendExitKeys,
        killTarget,
      },
      () => now,
    );
    const task = exit.start("manual", target, new CodexSessionManager("/unused"), () => {});
    // Four adapter interrupts, then EOF after the shell grace period.
    for (const value of [0, 200, 2_600, 2_800, 6_000]) {
      now = value;
      expect(await task.advance()).toBe(false);
    }
    expect(sendExitKeys.mock.calls.map((call) => call[2])).toEqual([
      ["C-c"],
      ["C-c"],
      ["C-c"],
      ["C-c"],
      ["C-d"],
    ]);
    now = 14_999;
    expect(await task.advance()).toBe(false);
    expect(killTarget).not.toHaveBeenCalled();
    now = 15_000;
    expect(await task.advance()).toBe(false);
    expect(killTarget).toHaveBeenCalledOnce();
    expect(await task.advance()).toBe(true);
    expect(
      execFileSync("tmux", ["-S", socketPath, "list-sessions", "-F", "#{session_name}"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("ahub-00000000-0000-0000-0000-000000000009");
  } finally {
    spawnSync("tmux", ["-S", socketPath, "kill-server"]);
  }
});

it("shares WebSocket preview captures without changing sizes and rebuilds after session exit", async () => {
  const directory = await createTempDirectory("codex-control-tmux-");
  const socketPath = join(directory, "server.sock");
  const run = (...args: string[]) =>
    execFileSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" }).trim();
  const sessionName = "ahub-00000000-0000-0000-0000-000000000004";
  run("new-session", "-d", "-x", "101", "-y", "31", "-s", sessionName, "sleep 60");
  const transport = new TmuxInteractionService();
  let binding = await transport.connect({ valid: true, ordinal: 0, socketPath, sessionName });
  const capture = vi.fn((target: TmuxBinding, guard: () => void) =>
    transport.captureTerminal(target, guard),
  );
  const service = new TerminalPreviewService(capture);
  const server = await startPreviewServer({
    subscribePreview: async (_session, frame, fail, signal) =>
      service.subscribe(binding, () => {}, frame, fail, signal),
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
      run("display-message", "-p", "-t", binding.sessionName, "#{window_width}x#{window_height}"),
    ).toBe("101x31");
    run("respawn-pane", "-k", "-t", binding.sessionName, "printf 'CONTROL-OUTPUT'; sleep 60");
    await vi.waitFor(() => expect(reconstruct(a.messages)?.content).toContain("CONTROL-OUTPUT"), {
      timeout: 5000,
    });
    run("kill-session", "-t", binding.sessionName);
    await vi.waitFor(
      () => expect(a.messages.at(-1)).toMatchObject({ type: "error", retryable: true }),
      { timeout: 5000 },
    );
    run("new-session", "-d", "-s", "ahub-00000000-0000-0000-0000-000000000005", "sleep 60");
    binding = await transport.connect({
      valid: true,
      ordinal: 1,
      socketPath,
      sessionName: "ahub-00000000-0000-0000-0000-000000000005",
    });
    const rebuilt = server.connect();
    await vi.waitFor(() => expect(rebuilt.messages[0]).toMatchObject({ type: "snapshot" }));
  } finally {
    await server.close();
    service.close();
    spawnSync("tmux", ["-S", socketPath, "kill-server"]);
  }
}, 15000);

it("sends chat messages while WebSocket preview is subscribed", async () => {
  const directory = await createTempDirectory("codex-send-preview-");
  const socketPath = join(directory, "server.sock");
  const run = (...args: string[]) =>
    execFileSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" }).trim();
  const transport = new TmuxInteractionService();
  const service = new TerminalPreviewService((target, guard) =>
    transport.captureTerminal(target, guard),
  );
  const sessionName = "ahub-00000000-0000-0000-0000-000000000006";
  run("new-session", "-d", "-s", sessionName, "bash --noprofile --norc -i");
  const binding = await transport.connect({ valid: true, ordinal: 0, socketPath, sessionName });
  const server = await startPreviewServer({
    subscribePreview: async (_session, frame, fail, signal) =>
      service.subscribe(binding, () => {}, frame, fail, signal),
  });
  try {
    await vi.waitFor(() =>
      expect(run("capture-pane", "-p", "-t", binding.sessionName)).toContain("bash"),
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
  const sessionName = "ahub-00000000-0000-0000-0000-000000000007";
  run(
    "new-session",
    "-d",
    "-x",
    "100",
    "-y",
    "30",
    "-s",
    sessionName,
    `${lines}read line; sleep 60`,
  );
  const transport = new TmuxInteractionService();
  const binding = await transport.connect({ valid: true, ordinal: 0, socketPath, sessionName });
  const service = new TerminalPreviewService((target, guard) =>
    transport.captureTerminal(target, guard),
  );
  const server = await startPreviewServer({
    subscribePreview: async (_session, frame, fail, signal) =>
      service.subscribe(binding, () => {}, frame, fail, signal),
  });
  try {
    await vi.waitFor(() =>
      expect(run("capture-pane", "-p", "-t", binding.sessionName)).toContain(
        "stable terminal line 019",
      ),
    );
    const a = server.connect(),
      b = server.connect();
    await vi.waitFor(() => {
      expect(a.messages).toHaveLength(1);
      expect(b.messages).toHaveLength(1);
    });
    run(
      "respawn-pane",
      "-k",
      "-t",
      binding.sessionName,
      `${lines}printf 'DELTA-世界😀\\n'; sleep 60`,
    );
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

it("keeps output activity alive without preview and preserves pane dimensions", async () => {
  const { TerminalActivityService } = await import(
    "../../src/server/interaction/terminal-activity-service.js"
  );
  const { createTmuxPreviewListener } = await import(
    "../../src/server/interaction/tmux-preview-listener.js"
  );
  const directory = await createTempDirectory("activity-tmux-");
  const socketPath = join(directory, "server.sock");
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" }).trim();
  const sessionName = "ahub-00000000-0000-0000-0000-000000000008";
  tmux("new-session", "-d", "-s", sessionName, "-x", "100", "-y", "30");
  let now = 0;
  const listen = createTmuxPreviewListener();
  const subscriptions: { ready: Promise<void>; disconnected: Promise<void> }[] = [];
  const observe: PreviewListener = (binding, change, fail) => {
    let disconnected!: () => void;
    const ended = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const subscription = listen(binding, change, (error) => {
      fail(error);
      disconnected();
    });
    subscriptions.push({ ready: subscription.ready, disconnected: ended });
    return subscription;
  };
  const activity = new TerminalActivityService(observe, () => now);
  try {
    const binding = { socketPath, sessionName };
    const size = () =>
      tmux("display-message", "-p", "-t", sessionName, "#{pane_width}x#{pane_height}");
    const before = size();
    expect(activity.read("test", binding)).toBe("unknown");
    await subscriptions[0]!.ready;
    now = 5000;
    expect(activity.read("test", binding)).toBe("idle");
    tmux("send-keys", "-t", sessionName, "printf 'activity-test\\n'", "Enter");
    await vi.waitFor(() => expect(activity.read("test", binding)).toBe("working"));
    expect(size()).toBe(before);
    tmux("list-clients", "-F", "#{client_name}")
      .split("\n")
      .forEach((client) => tmux("detach-client", "-t", client));
    await subscriptions[0]!.disconnected;
    expect(activity.read("test", binding)).toBe("unknown");
    expect(subscriptions).toHaveLength(2);
    await subscriptions[1]!.ready;
    now += 5000;
    expect(activity.read("test", binding)).toBe("idle");
  } finally {
    activity.close();
    tmux("kill-server");
  }
});

import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { createCodexHub } from "../../src/server/create-hub.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { claudePromptPosition } from "../../src/server/adapters/claude/prompt-readiness.js";
import { ClaudeSessionManager } from "../../src/server/adapters/claude/session-manager.js";
import { TmuxLauncher } from "../../src/server/interaction/tmux-launcher.js";
import { TmuxInteractionService } from "../../src/server/interaction/tmux-service.js";
import { startHttpServer } from "../helpers/http-server.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

it("does not send bootstrap input to Claude's real directory trust dialog", async () => {
  const root = await realpath(await createTempDirectory("claude-native-trust-"));
  const directory = join(root, "untrusted-project");
  const home = join(root, "home");
  const socket = join(root, "tmux.sock");
  await mkdir(directory);
  await mkdir(home);
  const key = "test-only-not-a-real-api-key";
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.318",
      theme: "dark",
      customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
    }),
  );
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: key,
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    }),
  );
  const tmux = new TmuxLauncher(socket);
  const send = vi.spyOn(tmux.transport, "sendMessage");
  const operationId = "00000000-0000-4000-8000-000000000001";
  const target = { socketPath: socket, sessionName: `ahub-${operationId}` };
  const result = new ClaudeSessionManager(home, tmux)
    .launch({
      operationId,
      workingDirectory: directory,
      worktree: false,
      yolo: false,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  try {
    let sawTrustDialog = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const snapshot = await tmux.transport.captureTerminalWithCursor(target).catch(() => null);
      if (snapshot?.content.includes("Yes, I trust this folder")) {
        expect(claudePromptPosition(snapshot)).toBeNull();
        sawTrustDialog = true;
        break;
      }
      await delay(100);
    }
    expect(sawTrustDialog).toBe(true);
    expect(await result).toMatchObject({
      outcome: "unknown",
      target,
      message: expect.stringContaining("readiness was not confirmed"),
      attachCommand: expect.stringContaining("tmux"),
    });
    expect(send).not.toHaveBeenCalled();
  } finally {
    try {
      execFileSync("tmux", ["-S", socket, "kill-server"]);
    } catch {}
    await result;
  }
}, 30_000);

/** Native CLI and tmux; credentials, model responses, homes and projects are test-owned. */
it("creates, interacts, interrupts, exits and resumes the original Claude identity, including worktrees", async () => {
  const root = await realpath(await createTempDirectory("claude-native-management-"));
  const directory = join(root, "project");
  const home = join(root, "home");
  const socket = join(root, "tmux.sock");
  await mkdir(directory);
  await mkdir(home);
  execFileSync("git", ["-C", directory, "init", "-q"]);
  execFileSync("git", [
    "-C",
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "Test",
  ]);
  let mode: "text" | "question" | "hold" = "text";
  let requests = 0;
  const api = createServer(async (req, res) => {
    for await (const _ of req) {
      /* Drain the request without retaining prompts. */
    }
    if (!req.url?.includes("/messages")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    requests++;
    if (mode === "hold") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type: string, data: unknown) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    event("message_start", {
      type: "message_start",
      message: {
        id: `msg_test_${requests}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    const question = mode === "question";
    mode = "text";
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: question
        ? { type: "tool_use", id: "ask_native", name: "AskUserQuestion", input: {} }
        : { type: "text", text: "" },
    });
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: question
        ? {
            type: "input_json_delta",
            partial_json: JSON.stringify({
              questions: [
                {
                  header: "Test",
                  question: "Choose a test option",
                  options: [
                    { label: "One", description: "First" },
                    { label: "Two", description: "Second" },
                  ],
                  multiSelect: false,
                },
              ],
            }),
          }
        : { type: "text_delta", text: "Native Claude integration response" },
    });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: question ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    event("message_stop", { type: "message_stop" });
    res.end();
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("Missing mock address");
  const key = "test-only-not-a-real-api-key";
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.318",
      theme: "dark",
      customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
      projects: {
        [directory]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      },
    }),
  );
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: key,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      model: "claude-sonnet-4-6",
    }),
  );
  const hub = await createCodexHub({
    homes: [{ nickname: "claude", path: home, adapter: "claude" }],
    socket,
  });
  const kill = vi.spyOn(hub.interaction, "killTarget");
  const { base } = await startHttpServer(createApiRouter(hub), () => hub.close());
  const until = async (predicate: () => Promise<boolean>, description: string) => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await hub.operations.poll();
      if (await predicate()) return;
      await delay(100);
    }
    let terminal = "";
    try {
      terminal = execFileSync("tmux", ["-S", socket, "capture-pane", "-p"], { encoding: "utf8" });
    } catch {}
    throw new Error(`Timed out: ${description}\n${terminal}`);
  };
  const succeeded = async (id: string) => {
    await until(async () => {
      const op = await hub.operations.get(id);
      if (op?.status === "failed" || op?.status === "unknown") throw new Error(JSON.stringify(op));
      return op?.status === "succeeded";
    }, "operation confirmation");
    return (await hub.operations.get(id))!;
  };
  try {
    const created = await succeeded(
      hub.operations.create({
        projectDirectory: directory,
        worktree: false,
        requestId: "claude-native-create",
      }).operationId,
    );
    const sessionId = created.sessionId!;
    const nativeId = (await hub.sessions.managementSnapshot()).byId.get(sessionId)!.sourceId;
    expect(nativeId).toMatch(/^[a-f0-9-]+$/);
    expect((await hub.sessions.list()).homes).toEqual([
      { nickname: "claude", management: { archive: false } },
    ]);
    // Unsupported HTTP and internal operations must leave the live pane untouched.
    const response = await fetch(`${base}/api/v1/sessions/${sessionId}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "operation_not_supported" } });
    const rejected = hub.operations.manage("archive", sessionId);
    await until(
      async () => (await hub.operations.get(rejected.operationId))?.status === "failed",
      "unsupported operation",
    );
    expect(await hub.interaction.describe(sessionId)).toMatchObject({
      supported: true,
      state: "connected",
    });
    await hub.interaction.sendMessage(sessionId, "Say hello");
    await until(
      async () =>
        JSON.stringify(await hub.sessions.messages(sessionId, {})).includes(
          "Native Claude integration response",
        ),
      "ordinary response",
    );
    mode = "question";
    await hub.interaction.sendMessage(sessionId, "Ask a test question");
    await until(
      async () =>
        JSON.stringify(await hub.sessions.messages(sessionId, {})).includes("Choose a test option"),
      "question request",
    );
    await hub.interaction.sendKeys(sessionId, ["down", "enter"]);
    await until(
      async () =>
        JSON.stringify(await hub.sessions.messages(sessionId, {})).includes('"outcome":"answered"'),
      "question answer",
    );
    mode = "hold";
    const before = requests;
    await hub.interaction.sendMessage(sessionId, "Wait until interrupted");
    await until(async () => requests > before, "in-flight response");
    await hub.interaction.sendKeys(sessionId, ["interrupt"]);
    mode = "text";
    await succeeded(hub.operations.manage("exit", sessionId).operationId);
    expect(await hub.interaction.describe(sessionId)).toMatchObject({
      supported: true,
      state: "disconnected",
    });
    const resumed = await succeeded(
      hub.operations.create({ resumeSessionId: sessionId, requestId: "claude-native-resume" })
        .operationId,
    );
    expect(resumed.sessionId).toBe(sessionId);
    expect((await hub.sessions.managementSnapshot()).byId.get(sessionId)?.sourceId).toBe(nativeId);
    const worktree = await succeeded(
      hub.operations.create({
        projectDirectory: directory,
        worktree: true,
        requestId: "claude-native-worktree",
      }).operationId,
    );
    const session = (await hub.sessions.managementSnapshot()).byId.get(worktree.sessionId!)!;
    expect(session.projectDirectory).toBe(directory);
    expect(session.workingDirectory).not.toBe(directory);
    await succeeded(hub.operations.manage("exit", session.id).operationId);
    const deleteTarget = await hub.interaction.resolveTarget(sessionId);
    expect(deleteTarget).not.toBeNull();
    await succeeded(hub.operations.manage("delete", sessionId).operationId);
    expect((await hub.sessions.managementSnapshot()).byId.has(sessionId)).toBe(false);
    expect(await new TmuxInteractionService().inspect(deleteTarget!)).toBe("exited");
    // Ctrl-C is adapter-compatible; native versions may require the shared fallback.
    const killedTargets = kill.mock.calls.map(([target]) => JSON.stringify(target));
    expect(new Set(killedTargets).size).toBe(killedTargets.length);
    expect(killedTargets.length).toBeLessThanOrEqual(3);
  } finally {
    hub.close();
    try {
      execFileSync("tmux", ["-S", socket, "kill-server"]);
    } catch {}
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
}, 180_000);

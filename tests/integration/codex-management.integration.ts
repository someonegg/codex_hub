import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createCodexSessionSource } from "../../src/server/adapters/codex/codex-session-source.js";
import { codexBindingCommand } from "../../src/server/adapters/codex/interaction-parser.js";
import { CodexSessionManager } from "../../src/server/adapters/codex/session-manager.js";
import { SessionReadService } from "../../src/server/application/session-read-service.js";
import { createAhub } from "../../src/server/create-hub.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import { PaneBindingManager } from "../../src/server/interaction/pane-binding-manager.js";
import { TmuxLauncher } from "../../src/server/interaction/tmux-launcher.js";
import { TmuxInteractionService } from "../../src/server/interaction/tmux-service.js";
import { OperationService } from "../../src/server/management/operation-service.js";
import { SessionManagerRegistry } from "../../src/server/management/session-manager.js";
import { startHttpServer } from "../helpers/http-server.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-only-not-a-real-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** No user credentials, model calls, or existing user tmux server are used. */
it("creates and binds concurrent real Codex sessions, including a native worktree, then archives and deletes by UUID", async () => {
  const root = await realpath(await createTempDirectory("codex-native-management-"));
  const directory = join(root, "project with spaces ; $literal");
  const agent = join(root, "agent");
  await mkdir(directory);
  await mkdir(agent);
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
  await writeFile(
    join(agent, "config.toml"),
    `[projects.${JSON.stringify(directory)}]\ntrust_level = "trusted"\n`,
  );
  execFileSync("codex", ["login", "--with-api-key"], {
    env: { ...process.env, CODEX_HOME: agent },
    input: "test-only-not-a-real-key",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const bindings = new PaneBindingManager();
  const source = await createCodexSessionSource(agent);
  const reader = new SessionReadService([source], {
    publishBindings: (events) => {
      for (const event of events) bindings.submit(event);
    },
  });
  const agentNickname = source.descriptor.agent;
  const interaction = new SessionInteractionService(reader, new TmuxInteractionService(), {
    enabled: true,
    bindings,
  });
  const socket = join(root, "tmux.sock");
  const manager = new CodexSessionManager(agent, new TmuxLauncher(socket));
  const operations = new OperationService(
    reader,
    interaction,
    new SessionManagerRegistry(agentNickname).register(agentNickname, manager),
    { bindings: bindings },
  );
  try {
    const first = operations.create({
      projectDirectory: directory,
      worktree: false,
      requestId: "native-first",
    });
    expect(first.attachCommand).toBeNull();
    const second = operations.create({
      projectDirectory: directory,
      worktree: true,
      requestId: "native-second",
    });
    for (const op of [first, second]) {
      await until(async () => {
        const value = await operations.get(op.operationId);
        if (value?.status === "failed") throw new Error(value.error!);
        return value?.status === "succeeded";
      });
    }
    const third = operations.create({
      projectDirectory: directory,
      worktree: false,
      requestId: "native-third",
    });
    await until(async () => {
      const value = await operations.get(third.operationId);
      if (value?.status === "failed") throw new Error(value.error!);
      return value?.status === "succeeded";
    });
    const manualId = (await operations.get(third.operationId))!.sessionId!;
    const manualTarget = (await interaction.resolveTarget(manualId))!;
    await interaction.sendMessage(manualId, codexBindingCommand());
    await until(async () => {
      await reader.managementSnapshot();
      const attempt = bindings.latest(manualId);
      return attempt?.valid === true && attempt.operationId === undefined;
    });
    await interaction.sendKeys(manualId, ["left"]);
    expect(await interaction.describe(manualId)).toMatchObject({
      state: "connected",
      attachCommand: expect.stringContaining(manualTarget.sessionName),
    });
    const a = (await operations.get(first.operationId))!;
    const b = (await operations.get(second.operationId))!;
    expect(a.sessionId).not.toBe(b.sessionId);
    const snapshot = await reader.managementSnapshot();
    const original = snapshot.sessions.find((session) => session.id === a.sessionId)!;
    const worktree = snapshot.sessions.find((session) => session.id === b.sessionId)!;
    expect(original.workingDirectory).toBe(directory);
    expect(worktree.workingDirectory).not.toBe(directory);
    expect(worktree.projectDirectory).toBe(directory);
    expect(bindings.latest(worktree.id)).toMatchObject({
      valid: true,
      projectDirectory: directory,
    });
    const empty = snapshot.sessions.find((session) => session.id === manualId)!;
    for (const [index, record] of [original, worktree, empty].entries()) {
      // Cover a multiline draft, a cursor inside the draft, and an empty composer.
      const attempt = bindings.latest(record.id)!;
      if (!attempt.valid) throw new Error("Expected a valid binding");
      if (index < 2) {
        execFileSync("tmux", ["-S", socket, "load-buffer", "-b", "archive-draft", "-"], {
          input: "UNSUBMITTED-ARCHIVE-DRAFT first line\nsecond line",
        });
        execFileSync("tmux", [
          "-S",
          socket,
          "paste-buffer",
          "-p",
          "-d",
          "-b",
          "archive-draft",
          "-t",
          attempt.sessionName,
        ]);
        if (index === 1)
          execFileSync("tmux", [
            "-S",
            socket,
            "send-keys",
            "-t",
            attempt.sessionName,
            "Up",
            "Agent",
          ]);
        await until(async () =>
          execFileSync("tmux", ["-S", socket, "capture-pane", "-p", "-t", attempt.sessionName], {
            encoding: "utf8",
          }).includes("UNSUBMITTED-ARCHIVE-DRAFT"),
        );
      }
      const activeFiles = await readdir(join(agent, "sessions"), { recursive: true });
      const activeRollout = activeFiles.find((file) => file.endsWith(`${record.sourceId}.jsonl`));
      expect(activeRollout).toBeDefined();
      const before = await readFile(join(agent, "sessions", activeRollout!), "utf8");
      const modelEvents = (log: string) =>
        log
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter(
            (item) =>
              item.type === "event_msg" &&
              ["task_started", "token_count"].includes(item.payload?.type),
          );
      if (index === 2) {
        const exit = operations.manage("exit", record.id);
        await until(async () => (await operations.get(exit.operationId))?.status !== "pending");
        expect(await operations.get(exit.operationId)).toMatchObject({
          type: "exit",
          status: "succeeded",
        });
        const afterExit = (await reader.managementSnapshot()).sessions.find(
          (session) => session.id === record.id,
        );
        expect(afterExit?.archived).toBe(false);
        expect(await interaction.resolveTarget(record.id)).toBeNull();
      }
      if (index === 1) {
        const deletion = operations.manage("delete", record.id);
        await until(
          async () => (await operations.get(deletion.operationId))?.status === "succeeded",
        );
        expect(await new TmuxInteractionService().inspect(attempt)).toBe("exited");
        expect((await reader.managementSnapshot()).byId.has(record.id)).toBe(false);
        continue;
      }
      const archive = operations.manage("archive", record.id);
      await until(async () => {
        const value = await operations.get(archive.operationId);
        if (value?.status === "failed") throw new Error(value.error!);
        return value?.status === "succeeded";
      }).catch(async (error) => {
        const state = await operations.get(archive.operationId);
        let terminal = "";
        try {
          terminal = execFileSync(
            "tmux",
            ["-S", socket, "capture-pane", "-p", "-t", attempt.valid ? attempt.sessionName : ""],
            { encoding: "utf8" },
          );
        } catch {
          /* target exited */
        }
        throw new Error(`${error.message}: ${JSON.stringify(state)}
${terminal}`);
      });
      // No draft text was recorded as submitted input, and no model turn started.
      const files = await readdir(join(agent, "archived_sessions"), { recursive: true });
      const rollout = files.find((file) => file.endsWith(`${record.sourceId}.jsonl`));
      expect(rollout).toBeDefined();
      const log = await readFile(join(agent, "archived_sessions", rollout!), "utf8");
      expect(log).not.toContain("UNSUBMITTED-ARCHIVE-DRAFT");
      expect(modelEvents(log)).toEqual(modelEvents(before));
      const deletion = operations.manage("delete", record.id);
      await until(async () => (await operations.get(deletion.operationId))?.status === "succeeded");
    }
    expect((await reader.managementSnapshot()).sessions).toHaveLength(0);
  } finally {
    operations.close();
    interaction.close();
    try {
      execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      /* already exited */
    }
  }
}, 90_000);

async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Native lifecycle observation timed out");
}

it("reports the native refusal for a running unbound session and archives it after it exits", async () => {
  const root = await realpath(await createTempDirectory("codex-unbound-management-"));
  const agent = join(root, "agent");
  const directory = join(root, "project");
  const socket = join(root, "tmux.sock");
  await mkdir(agent);
  await mkdir(directory);
  await writeFile(
    join(agent, "config.toml"),
    `[projects.${JSON.stringify(directory)}]\ntrust_level = "trusted"\n`,
  );
  execFileSync("codex", ["login", "--with-api-key"], {
    env: { ...process.env, CODEX_HOME: agent },
    input: "test-only-not-a-real-key",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const bindings = new PaneBindingManager();
  const source = await createCodexSessionSource(agent);
  const reader = new SessionReadService([source], {
    publishBindings: (events) => {
      for (const event of events) bindings.submit(event);
    },
  });
  const agentNickname = source.descriptor.agent;
  const transport = new TmuxInteractionService();
  const interaction = new SessionInteractionService(reader, transport, {
    enabled: true,
    bindings,
  });
  const operations = new OperationService(
    reader,
    interaction,
    new SessionManagerRegistry(agentNickname).register(
      agentNickname,
      new CodexSessionManager(agent, new TmuxLauncher(socket)),
    ),
    { bindings: bindings },
  );
  try {
    const binding = await new TmuxLauncher(socket).launch(randomUUID(), directory, [
      "env",
      `CODEX_HOME=${agent}`,
      "codex",
      "--no-daemon",
      "--no-alt-screen",
      "! printf 'unbound-ready'",
    ]);
    await until(
      async () =>
        (await transport.captureTerminal(binding)).content.includes("unbound-ready") &&
        (await reader.managementSnapshot()).sessions.length === 1,
    );
    const record = (await reader.managementSnapshot()).sessions[0]!;
    expect(bindings.latest(record.id)).toBeNull();
    const running = operations.manage("archive", record.id);
    await until(async () => (await operations.get(running.operationId))?.status === "failed");
    expect((await operations.get(running.operationId))?.error).toContain(
      "Error: failed to archive session",
    );
    expect(await transport.inspect(binding)).toBe("alive");
    expect((await reader.managementSnapshot()).sessions[0]?.archived).toBe(false);
    // This session intentionally has no product binding. Test setup asks it to exit;
    // bound sessions above are exited exclusively through the product archive workflow.
    await transport.sendMessage(binding, "/exit");
    await until(async () => (await transport.inspect(binding)) === "exited");
    const exited = operations.manage("archive", record.id);
    await until(async () => {
      const value = await operations.get(exited.operationId);
      if (value?.status === "failed") throw new Error(value.error!);
      return value?.status === "succeeded";
    });
    expect((await reader.managementSnapshot()).sessions[0]?.archived).toBe(true);
  } finally {
    operations.close();
    interaction.close();
    try {
      execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      /* already exited */
    }
  }
}, 60_000);

it("composes the Hub with shared adapter, interaction, and operation bindings", async () => {
  const root = await realpath(await createTempDirectory("ahub-composition-"));
  const agent = join(root, "agent");
  const directory = join(root, "project");
  const socket = join(root, "tmux.sock");
  await mkdir(agent);
  await mkdir(directory);
  await writeFile(
    join(agent, "config.toml"),
    `[projects.${JSON.stringify(directory)}]\ntrust_level = "trusted"\n`,
  );
  execFileSync("codex", ["login", "--with-api-key"], {
    env: { ...process.env, CODEX_HOME: agent },
    input: "test-only-not-a-real-key",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const emptyAgent = join(root, "empty-agent");
  await mkdir(emptyAgent);
  const hub = await createAhub({
    agents: [
      { nickname: "empty", path: emptyAgent },
      { nickname: "work", path: agent },
    ],
    socket,
  });
  const catalog = await hub.sessions.list();
  expect(catalog.agents).toHaveLength(2);
  const nickname = catalog.agents.find((entry) => entry.nickname === "work")!.nickname;
  try {
    const operation = hub.operations.create({
      projectDirectory: directory,
      worktree: false,
      requestId: "hub-composition",
      agent: nickname,
    });
    await until(async () => {
      const result = await hub.operations.get(operation.operationId);
      if (result?.status === "failed") throw new Error(result.error!);
      return result?.status === "succeeded";
    });
    const result = (await hub.operations.get(operation.operationId))!;
    expect((await hub.sessions.getSession(result.sessionId!))!.session.origin.agent).toBe(nickname);
    expect(await readdir(emptyAgent)).toEqual([]);
    expect(await hub.interaction.describe(result.sessionId!)).toMatchObject({ state: "connected" });
    const originalId = result.sessionId!;
    const original = (await hub.sessions.getSession(originalId))!.session;
    expect(original.status).toBe("live");
    const liveCatalog = await hub.sessions.list();
    expect(liveCatalog.sessions.find((item) => item.id === originalId)?.status).toBe("live");
    const oldTarget = (await hub.interaction.resolveTarget(originalId))!;
    const exit = hub.operations.manage("exit", originalId);
    await until(async () => {
      const state = await hub.operations.get(exit.operationId);
      if (state?.status === "failed" || state?.status === "unknown") throw new Error(state.error!);
      return state?.status === "succeeded";
    });
    const exited = (await hub.sessions.getSession(originalId))!.session;
    expect(exited.status).toBe("normal");
    expect(exited.resume).toEqual({ allowed: true, reason: null });
    expect((await hub.sessions.list()).revision).not.toBe(liveCatalog.revision);
    const resumed = hub.operations.create({
      resumeSessionId: originalId,
      requestId: "hub-resume-original",
    });
    await until(async () => {
      const state = await hub.operations.get(resumed.operationId);
      if (state?.status === "failed" || state?.status === "unknown") throw new Error(state.error!);
      return state?.status === "succeeded";
    });
    expect(await hub.operations.get(resumed.operationId)).toMatchObject({
      mode: "resume",
      sessionId: originalId,
    });
    const restored = (await hub.sessions.getSession(originalId))!.session;
    expect(restored).toMatchObject({
      status: "live",
      sourceId: original.sourceId,
      workingDirectory: original.workingDirectory,
    });
    const newTarget = (await hub.interaction.resolveTarget(originalId))!;
    expect(newTarget).not.toEqual(oldTarget);
    expect((await hub.sessions.list()).sessions).toHaveLength(1);
    const archive = hub.operations.manage("archive", result.sessionId!);
    await until(async () => {
      const result = await hub.operations.get(archive.operationId);
      if (result?.status === "failed") throw new Error(result.error!);
      return result?.status === "succeeded";
    });
  } finally {
    hub.close();
    try {
      execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      /* already exited */
    }
  }
}, 60_000);

it("runs the HTTP session CLI through native create, local input, observation, resume and deletion", async () => {
  const root = await realpath(await createTempDirectory("ahub-cli-native-"));
  const agent = join(root, "agent");
  const directory = join(root, "project");
  const socket = join(root, "tmux.sock");
  await mkdir(agent);
  await mkdir(directory);
  await writeFile(
    join(agent, "config.toml"),
    `[projects.${JSON.stringify(directory)}]\ntrust_level = "trusted"\n`,
  );
  execFileSync("codex", ["login", "--with-api-key"], {
    env: { ...process.env, CODEX_HOME: agent },
    input: "test-only-not-a-real-key",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const hub = await createAhub({ agents: [{ nickname: "work", path: agent }], socket: socket });
  const { base } = await startHttpServer(createApiRouter(hub), hub.close);
  const cli = async (...args: string[]) => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      resolve("src/server/cli/main.ts"),
      "session",
      ...args,
      "--url",
      base,
      "--timeout",
      "30",
      "--json",
    ]);
    expect(stderr).toBe("");
    expect(stdout).not.toContain("operationId");
    expect(stdout).not.toContain("requestId");
    return JSON.parse(stdout);
  };
  try {
    const created = await cli("create", "--project", directory, "--agent", "work");
    const id = created.sessionId;
    expect(created.status).toBe("succeeded");
    expect(
      (await cli("list", "--project", directory)).sessions.map((item: { id: string }) => item.id),
    ).toContain(id);
    expect(await cli("send", id, "--message", "! printf 'AHUB-CLI-ROUNDTRIP'")).toEqual({
      sessionId: id,
      status: "sent",
    });
    await until(async () =>
      (await hub.interaction.captureTerminal(id)).content.includes("AHUB-CLI-ROUNDTRIP"),
    );
    const inspected = await cli("inspect", id);
    expect(inspected.interaction).toMatchObject({ supported: true, state: "connected" });
    expect(inspected.session.agent).toBe("work");
    expect((await cli("terminal", id)).content).toContain("AHUB-CLI-ROUNDTRIP");
    await until(async () => {
      const state = await hub.interaction.describe(id);
      return state?.supported === true && state.activity === "idle";
    });
    await cli("keys", id, "up", "down");
    await cli("interrupt", id);
    await cli("handoff", id);
    const oldTarget = (await hub.interaction.resolveTarget(id))!;
    await cli("exit", id);
    expect(await new TmuxInteractionService().inspect(oldTarget)).toBe("exited");
    expect((await cli("resume", id)).sessionId).toBe(id);
    await cli("exit", id);
    expect((await hub.sessions.getSession(id))!.session.status).not.toBe("archived");
    await cli("delete", id);
    expect((await cli("list")).sessions).toEqual([]);
  } finally {
    hub.close();
    try {
      execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      /* already exited */
    }
  }
}, 90_000);

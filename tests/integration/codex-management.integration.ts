import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createCodexSessionSource } from "../../src/server/adapters/codex/codex-session-source.js";
import { CodexSessionManager } from "../../src/server/adapters/codex/session-manager.js";
import { SessionReadService } from "../../src/server/application/session-read-service.js";
import { createCodexHub } from "../../src/server/create-hub.js";
import { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import { LivePaneBindingManager } from "../../src/server/interaction/live-pane-binding-manager.js";
import { TmuxLauncher } from "../../src/server/interaction/tmux-launcher.js";
import { TmuxInteractionService } from "../../src/server/interaction/tmux-service.js";
import { OperationService } from "../../src/server/management/operation-service.js";
import { SessionManagerRegistry } from "../../src/server/management/session-manager.js";
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
  const home = join(root, "home");
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
  await writeFile(
    join(home, "config.toml"),
    `[projects.${JSON.stringify(directory)}]\ntrust_level = "trusted"\n`,
  );
  execFileSync("codex", ["login", "--with-api-key"], {
    env: { ...process.env, CODEX_HOME: home },
    input: "test-only-not-a-real-key",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const bindings = new LivePaneBindingManager();
  const source = await createCodexSessionSource(home, bindings);
  const reader = new SessionReadService([source]);
  const sourceId = source.descriptor.sourceInstanceId;
  const interaction = new SessionInteractionService(
    reader,
    true,
    new TmuxInteractionService(),
    bindings,
  );
  const socket = join(root, "tmux.sock");
  const manager = new CodexSessionManager(home, new TmuxLauncher(socket));
  const operations = new OperationService(
    reader,
    interaction,
    new SessionManagerRegistry(sourceId).register(sourceId, manager),
    undefined,
    undefined,
    bindings,
  );
  try {
    const first = operations.create({ directory, worktree: false, requestId: "native-first" });
    expect(first.attachCommand).toBeNull();
    const second = operations.create({ directory, worktree: true, requestId: "native-second" });
    for (const op of [first, second]) {
      await until(async () => {
        const value = await operations.get(op.operationId);
        if (value?.status === "failed") throw new Error(value.error!);
        return value?.status === "succeeded";
      });
    }
    const third = operations.create({ directory, worktree: false, requestId: "native-third" });
    await until(async () => {
      const value = await operations.get(third.operationId);
      if (value?.status === "failed") throw new Error(value.error!);
      return value?.status === "succeeded";
    });
    const manualId = (await operations.get(third.operationId))!.sessionId!;
    const manualTarget = (await interaction.archiveTarget(manualId))!;
    execFileSync("tmux", [
      "-S",
      socket,
      "rename-session",
      "-t",
      manualTarget.sessionName!,
      "manual arbitrary|session",
    ]);
    await interaction.sendMessage(
      manualId,
      `! printf 'CODEX_HUB_TMUX_BIND_V3\\n%s\\n%s\\n' "$(tmux display-message -p '#{socket_path}')" "$TMUX_PANE"`,
    );
    await until(async () => {
      await reader.managementSnapshot();
      const attempt = bindings.latest(manualId);
      return attempt?.valid === true && attempt.operationId === undefined;
    });
    await interaction.sendKeys(manualId, ["left"]);
    expect(await interaction.describe(manualId)).toMatchObject({
      state: "connected",
      attachCommand: expect.stringContaining("manual arbitrary|session"),
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
          attempt.paneId,
        ]);
        if (index === 1)
          execFileSync("tmux", ["-S", socket, "send-keys", "-t", attempt.paneId, "Up", "Home"]);
        await until(async () =>
          execFileSync("tmux", ["-S", socket, "capture-pane", "-p", "-t", attempt.paneId], {
            encoding: "utf8",
          }).includes("UNSUBMITTED-ARCHIVE-DRAFT"),
        );
      }
      const activeFiles = await readdir(join(home, "sessions"), { recursive: true });
      const activeRollout = activeFiles.find((file) => file.endsWith(`${record.sourceId}.jsonl`));
      expect(activeRollout).toBeDefined();
      const before = await readFile(join(home, "sessions", activeRollout!), "utf8");
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
            ["-S", socket, "capture-pane", "-p", "-t", attempt.valid ? attempt.paneId : ""],
            { encoding: "utf8" },
          );
        } catch {
          /* target exited */
        }
        throw new Error(`${error.message}: ${JSON.stringify(state)}
${terminal}`);
      });
      // No draft text was recorded as submitted input, and no model turn started.
      const files = await readdir(join(home, "archived_sessions"), { recursive: true });
      const rollout = files.find((file) => file.endsWith(`${record.sourceId}.jsonl`));
      expect(rollout).toBeDefined();
      const log = await readFile(join(home, "archived_sessions", rollout!), "utf8");
      expect(log).not.toContain("UNSUBMITTED-ARCHIVE-DRAFT");
      expect(modelEvents(log)).toEqual(modelEvents(before));
      const deletion = operations.manage("delete", record.id);
      await until(async () => (await operations.get(deletion.operationId))?.status === "succeeded");
    }
    expect((await reader.managementSnapshot()).sessions).toHaveLength(0);
  } finally {
    operations.close();
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
  const home = join(root, "home");
  const directory = join(root, "project");
  const socket = join(root, "tmux.sock");
  await mkdir(home);
  await mkdir(directory);
  await writeFile(
    join(home, "config.toml"),
    `[projects.${JSON.stringify(directory)}]\ntrust_level = "trusted"\n`,
  );
  execFileSync("codex", ["login", "--with-api-key"], {
    env: { ...process.env, CODEX_HOME: home },
    input: "test-only-not-a-real-key",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const bindings = new LivePaneBindingManager();
  const source = await createCodexSessionSource(home, bindings);
  const reader = new SessionReadService([source]);
  const sourceId = source.descriptor.sourceInstanceId;
  const transport = new TmuxInteractionService();
  const interaction = new SessionInteractionService(reader, true, transport, bindings);
  const operations = new OperationService(
    reader,
    interaction,
    new SessionManagerRegistry(sourceId).register(
      sourceId,
      new CodexSessionManager(home, new TmuxLauncher(socket)),
    ),
    undefined,
    undefined,
    bindings,
  );
  try {
    const binding = await new TmuxLauncher(socket).launch(randomUUID(), directory, [
      "env",
      `CODEX_HOME=${home}`,
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
    try {
      execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      /* already exited */
    }
  }
}, 60_000);

it("composes the Hub with shared adapter, interaction, and operation bindings", async () => {
  const root = await realpath(await createTempDirectory("codex-hub-composition-"));
  const home = join(root, "home");
  const directory = join(root, "project");
  const socket = join(root, "tmux.sock");
  await mkdir(home);
  await mkdir(directory);
  await writeFile(
    join(home, "config.toml"),
    `[projects.${JSON.stringify(directory)}]\ntrust_level = "trusted"\n`,
  );
  execFileSync("codex", ["login", "--with-api-key"], {
    env: { ...process.env, CODEX_HOME: home },
    input: "test-only-not-a-real-key",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const emptyHome = join(root, "empty-home");
  await mkdir(emptyHome);
  const hub = await createCodexHub(
    [
      { nickname: "empty", path: emptyHome },
      { nickname: "work", path: home },
    ],
    socket,
  );
  const catalog = await hub.sessions.list();
  expect(catalog.homes).toHaveLength(2);
  const sourceInstanceId = catalog.homes.find(
    (entry) => entry.nickname === "work",
  )!.sourceInstanceId;
  try {
    const operation = hub.operations.create({
      directory,
      worktree: false,
      requestId: "hub-composition",
      sourceInstanceId,
    });
    await until(async () => {
      const result = await hub.operations.get(operation.operationId);
      if (result?.status === "failed") throw new Error(result.error!);
      return result?.status === "succeeded";
    });
    const result = (await hub.operations.get(operation.operationId))!;
    expect(
      (await hub.sessions.getSession(result.sessionId!))!.session.origin.sourceInstanceId,
    ).toBe(sourceInstanceId);
    expect(await readdir(emptyHome)).toEqual([]);
    expect(await hub.interaction.describe(result.sessionId!)).toMatchObject({ state: "connected" });
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

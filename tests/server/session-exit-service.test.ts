import { expect, it, vi } from "vitest";

import { CodexSessionManager } from "../../src/server/adapters/codex/session-manager.js";
import { SessionExitService } from "../../src/server/management/session-exit-service.js";

const target = { socketPath: "/tmp/test.sock", paneId: "%1" };
function setup() {
  let now = 0;
  let active = true;
  const interaction = {
    inspectTarget: vi.fn(async () => "alive" as "alive" | "exited"),
    sendExitKeys: vi.fn(async (_target, _sessionId, _keys, check) => check()),
    killTarget: vi.fn(async (_target, _sessionId, check) => check()),
  };
  const service = new SessionExitService(interaction, () => now);
  const task = service.start("session", target, new CodexSessionManager("/unused"), () => {
    if (!active) throw new Error("cancelled");
  });
  return {
    interaction,
    task,
    time: (value: number) => {
      now = value;
    },
    cancel: () => {
      active = false;
    },
  };
}

it("uses adapter steps once, then EOF and one targeted kill, and requires exit confirmation", async () => {
  const { task, interaction, time } = setup();
  expect(await task.advance()).toBe(false);
  expect(interaction.sendExitKeys.mock.calls.map((call) => call[2])).toEqual([["C-c"]]);
  expect(task.phase).toBe("sending_exit");
  time(999);
  await task.advance();
  expect(interaction.sendExitKeys).toHaveBeenCalledTimes(1);
  time(1_000);
  await task.advance();
  expect(task.phase).toBe("sending_exit");
  time(1_999);
  await task.advance();
  expect(interaction.sendExitKeys).toHaveBeenCalledTimes(2);
  time(2_000);
  await task.advance();
  expect(task.phase).toBe("waiting_exit");
  time(5_999);
  await task.advance();
  expect(interaction.sendExitKeys).toHaveBeenCalledTimes(3);
  time(6_000);
  await task.advance();
  expect(interaction.sendExitKeys.mock.calls.map((call) => call[2])).toEqual([
    ["C-c"],
    ["C-c"],
    ["C-c"],
    ["C-d"],
  ]);
  time(14_999);
  await task.advance();
  expect(interaction.killTarget).not.toHaveBeenCalled();
  time(15_000);
  expect(await task.advance()).toBe(false);
  expect(interaction.killTarget).toHaveBeenCalledExactlyOnceWith(
    target,
    "session",
    expect.any(Function),
  );
  time(16_000);
  await task.advance();
  expect(interaction.killTarget).toHaveBeenCalledOnce();
  interaction.inspectTarget.mockResolvedValue("exited");
  expect(await task.advance()).toBe(true);
});

it.each([0, 4])("stops after natural exit following %i steps", async (count) => {
  const { task, interaction, time } = setup();
  for (let index = 0; index < count; index++) {
    time([0, 1_000, 2_000, 6_000][index]!);
    await task.advance();
  }
  interaction.inspectTarget.mockResolvedValue("exited");
  time(10_000);
  expect(await task.advance()).toBe(true);
  expect(interaction.sendExitKeys).toHaveBeenCalledTimes(count);
  expect(interaction.killTarget).not.toHaveBeenCalled();
});

it("does not turn an observation error into a kill", async () => {
  const { task, interaction, time } = setup();
  for (const value of [0, 1_000, 2_000, 6_000]) {
    time(value);
    await task.advance();
  }
  time(15_000);
  interaction.inspectTarget.mockRejectedValue(new Error("query failed"));
  await expect(task.advance()).rejects.toThrow("query failed");
  expect(interaction.killTarget).not.toHaveBeenCalled();
});

it("checks cancellation after an awaited observation", async () => {
  const { task, interaction, cancel } = setup();
  interaction.inspectTarget.mockImplementation(async () => {
    cancel();
    return "alive";
  });
  await expect(task.advance()).rejects.toThrow("cancelled");
  expect(interaction.sendExitKeys).not.toHaveBeenCalled();
});

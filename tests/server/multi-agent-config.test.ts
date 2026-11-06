import { mkdir, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { commandLineHelp, loadConfig } from "../../src/server/config.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const read = (...agents: string[]) =>
  loadConfig(agents.flatMap((agent) => ["--codex-agent", agent]));

it("replaces the default agent with explicit agents", () => {
  expect(commandLineHelp()).toContain("--codex-agent <nickname=path>");
  expect(commandLineHelp()).toContain("repeat for multiple agents");
  expect(read("work=./work")).toMatchObject({
    config: { agents: [{ nickname: "work", path: resolve("work") }] },
  });
});

it("preserves order, internal spaces, and equals in paths while trimming both fields", () => {
  expect(read(" Personal agent = ./one agent=a=b  ", "Personal=~/codex-work")).toMatchObject({
    kind: "run",
    config: {
      agents: [
        { nickname: "Personal agent", path: resolve("one agent=a=b") },
        { nickname: "Personal", path: join(homedir(), "codex-work") },
      ],
    },
  });
  expect(read("personal=one", "Personal=two")).toMatchObject({
    config: { agents: [{ nickname: "personal" }, { nickname: "Personal" }] },
  });
});

it.each(["./one", "=one", "a="])("rejects malformed agent %j", (agent) => {
  expect(() => read(agent)).toThrow("--codex-agent requires nickname=path");
});

it("rejects trimmed duplicate nicknames and equivalent paths", () => {
  expect(() => read(" a =one", "a=two")).toThrow("Duplicate agent nickname");
  expect(() => read("a=one", "b=./other/../one/")).toThrow("Duplicate agent path");
  expect(() => read("a=~/.codex", `b=${join(homedir(), ".codex")}`)).toThrow(
    "Duplicate agent path",
  );
});

it("rejects symlink aliases without replacing the configured source path", async () => {
  const root = await createTempDirectory("multi-agent-config-");
  const target = join(root, "one");
  const alias = join(root, "alias");
  await mkdir(target);
  await symlink(target, alias);
  expect(() => read(`a=${target}`, `b=${alias}`)).toThrow("Duplicate agent path");
  expect(read(`b=${alias}`)).toMatchObject({
    config: { agents: [{ nickname: "b", path: alias }] },
  });
});

it("uses only explicit agents and preserves global nickname uniqueness", () => {
  expect(loadConfig(["--claude-agent", "glm=~/.ccglm"])).toMatchObject({
    config: {
      agents: [{ nickname: "glm", adapter: "claude", path: join(homedir(), ".ccglm") }],
    },
  });
  expect(loadConfig(["--claude-agent", "default=~/.ccglm"])).toMatchObject({
    config: { agents: [{ nickname: "default" }] },
  });
  expect(() =>
    loadConfig(["--codex-agent", "a=/tmp/shared-agent", "--claude-agent", "b=/tmp/shared-agent"]),
  ).toThrow("Duplicate agent path");
  expect(() => loadConfig(["--claude-agent", "invalid"])).toThrow(
    "--claude-agent requires nickname=path",
  );
});

it("preserves interleaved adapter order", () => {
  expect(
    loadConfig([
      "--claude-agent=z=/tmp/z",
      "--codex-agent",
      "default=/tmp/d",
      "--claude-agent=a=/tmp/a",
    ]),
  ).toMatchObject({
    config: {
      agents: [
        { nickname: "z", adapter: "claude" },
        { nickname: "default" },
        { nickname: "a", adapter: "claude" },
      ],
    },
  });
});

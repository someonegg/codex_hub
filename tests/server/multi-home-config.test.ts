import { mkdir, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { commandLineHelp, loadConfig } from "../../src/server/config.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const read = (...homes: string[]) => loadConfig(homes.flatMap((home) => ["--codex-home", home]));

it("uses the default home only when no homes are supplied", () => {
  expect(loadConfig([])).toMatchObject({
    config: {
      codexHome: join(homedir(), ".codex"),
      homes: [{ nickname: "default", path: join(homedir(), ".codex") }],
    },
  });
  expect(read("work=./work")).toMatchObject({
    config: { codexHome: resolve("work"), homes: [{ nickname: "work", path: resolve("work") }] },
  });
});

it("preserves order, internal spaces, and equals in paths while trimming both fields", () => {
  expect(read(" Personal home = ./one home=a=b  ", "Personal=~/codex-work")).toMatchObject({
    kind: "run",
    config: {
      codexHome: resolve("one home=a=b"),
      homes: [
        { nickname: "Personal home", path: resolve("one home=a=b") },
        { nickname: "Personal", path: join(homedir(), "codex-work") },
      ],
    },
  });
  expect(read("personal=one", "Personal=two")).toMatchObject({
    config: { homes: [{ nickname: "personal" }, { nickname: "Personal" }] },
  });
});

it.each(["", " ", "./one", "nickname", "=one", " =one", "a=", "a=  "])(
  "rejects malformed home %j",
  (home) => {
    expect(() => read(home)).toThrow("--codex-home requires nickname=path");
  },
);

it("rejects trimmed duplicate nicknames and equivalent paths", () => {
  expect(() => read(" a =one", "a=two")).toThrow("Duplicate home nickname");
  expect(() => read("a=one", "b=./other/../one/")).toThrow("Duplicate home path");
  expect(() => read("a=~/.codex", `b=${join(homedir(), ".codex")}`)).toThrow("Duplicate home path");
});

it("rejects symlink aliases without replacing the configured source path", async () => {
  const root = await createTempDirectory("multi-home-config-");
  const target = join(root, "one");
  const alias = join(root, "alias");
  await mkdir(target);
  await symlink(target, alias);
  expect(() => read(`a=${target}`, `b=${alias}`)).toThrow("Duplicate home path");
  expect(read(`b=${alias}`)).toMatchObject({
    config: { codexHome: alias, homes: [{ nickname: "b", path: alias }] },
  });
});

it("rejects the removed config option and documents the repeatable replacement", () => {
  expect(() => loadConfig(["--config", "hub.json"])).toThrow();
  expect(commandLineHelp()).toContain("--codex-home <nickname=path>");
  expect(commandLineHelp()).toContain("repeat for multiple homes");
  expect(commandLineHelp()).not.toContain("--config");
});

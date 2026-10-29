import { execFileSync } from "node:child_process";

import { expect, it } from "vitest";

it("loads documentation catalogs without native Node.js type stripping", () => {
  const helperUrl = new URL("../../scripts/docs-language.mjs", import.meta.url).href;
  const source = `
    import { captureSource } from ${JSON.stringify(helperUrl)};
    const scenario = function scenario() {
      return [
        language,
        label("Settings"),
        label("Remove photo.png"),
        label("{{project}}, {{count, number}} main sessions", { project: "atlas", count: 2 }),
      ];
    };
    const capture = captureSource(scenario, "zh-CN");
    console.log(JSON.stringify(Function("return (" + capture + ")()")()));
  `;
  const output = execFileSync(
    process.execPath,
    ["--no-experimental-strip-types", "--input-type=module", "--eval", source],
    { encoding: "utf8" },
  );
  expect(JSON.parse(output)).toEqual(["zh-CN", "设置", "移除 photo.png", "atlas，2 个主会话"]);
});

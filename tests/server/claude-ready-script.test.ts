import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { checkClaudeReadyScript } from "../../src/server/adapters/claude/ready-script.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const screen = { content: "❯ ", cursorX: 2, cursorY: 0 };

async function scriptWith(body: string) {
  const script = join(await createTempDirectory("claude-ready-"), "ready");
  await writeFile(
    script,
    `#!/usr/bin/env node
let input = "";
for await (const chunk of process.stdin) input += chunk;
${body}
`,
  );
  await chmod(script, 0o755);
  return script;
}

it("sends the snapshot and text context as JSON and parses the result", async () => {
  const script = await scriptWith(
    "process.stdout.write(JSON.stringify({ ready: true, context: input }))",
  );
  const context = "下一次\n";
  const result = await checkClaudeReadyScript(script, screen, context, 5_000);
  expect(result.ready).toBe(true);
  expect(JSON.parse(result.context)).toEqual({ current: screen, context });
});

it.each([
  ['process.stdout.write("not json")', { name: "SyntaxError" }],
  [
    "process.stdout.write(JSON.stringify({ ready: true, context: 123 }))",
    { message: "Claude readiness script must return { ready: boolean, context: string }" },
  ],
  ["process.exit(2)", { code: 2 }],
])("reports the specific script failure: %s", async (body, error) => {
  const script = await scriptWith(body);
  await expect(checkClaudeReadyScript(script, screen, "", 5_000)).rejects.toMatchObject(error);
});

it("kills a script that exceeds its deadline", async () => {
  const script = await scriptWith("setInterval(() => {}, 1000)");
  await expect(checkClaudeReadyScript(script, screen, "", 200)).rejects.toMatchObject({
    killed: true,
    signal: "SIGKILL",
  });
});

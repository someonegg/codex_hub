import { execFile } from "node:child_process";

import type { TerminalCursorSnapshot } from "../../interaction/transport.js";

/** Context is opaque text scoped to a single launch attempt. */
export async function checkClaudeReadyScript(
  script: string,
  current: TerminalCursorSnapshot,
  context: string,
  timeout: number,
): Promise<{ ready: boolean; context: string }> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      script,
      [],
      { timeout: Math.max(1, timeout), maxBuffer: 1024 * 1024, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
    child.stdin?.on("error", reject);
    child.stdin?.end(JSON.stringify({ current, context }));
  });
  const result: unknown = JSON.parse(stdout);
  if (
    !result ||
    typeof result !== "object" ||
    !("ready" in result) ||
    typeof result.ready !== "boolean" ||
    !("context" in result) ||
    typeof result.context !== "string"
  ) {
    throw new Error("Claude readiness script must return { ready: boolean, context: string }");
  }
  return { ready: result.ready, context: result.context };
}

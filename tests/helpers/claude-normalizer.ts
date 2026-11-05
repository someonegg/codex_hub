import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CheckpointedJsonlDecoder } from "../../src/server/adapters/shared/jsonl-decoder.js";

import {
  appendClaudeRecords,
  type ClaudeState,
} from "../../src/server/adapters/claude/session-normalizer.js";
import { createTempDirectory } from "./temp-directories.js";

export async function appendClaudeLines(previous: ClaudeState, lines: readonly string[]) {
  const path = join(await createTempDirectory("claude-normalizer-"), "records.jsonl");
  await writeFile(path, "\n".repeat(previous.line) + (lines.length ? lines.join("\n") + "\n" : ""));
  const decoded = await new CheckpointedJsonlDecoder().decode({ path });
  const diagnostics = [
    ...previous.decoderDiagnostics,
    ...decoded.diagnostics.map((d) =>
      d.code === "malformed_json" ? { ...d, code: "invalid_jsonl" } : d,
    ),
  ].slice(0, 50);
  return {
    ...appendClaudeRecords(previous, decoded.records, diagnostics),
    line: previous.line + lines.length,
  };
}

import { appendFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { createCodexSessionSource } from "../src/server/adapters/codex/codex-session-source.js";
import { SessionReadService } from "../src/server/application/session-read-service.js";
const SESSION_COUNT = 3_000;
const FILLER_CHARS = 18_000;
const APPEND_PREFIX_ITEMS = 1_000;
interface Measurement {
  milliseconds: number;
  rssAfterBytes: number;
}
const root = await mkdtemp("/private/tmp/ahub-scale-");
try {
  const directory = join(root, "sessions");
  await mkdir(directory);
  const paths = await generateCorpus(directory);
  const source = await createCodexSessionSource(root);
  const reader = new SessionReadService([source]);
  const cold = await measure(() => reader.list());
  const noChange = await measure(() => reader.refresh());
  const selected = cold.value.sessions.find(
    (session) => session.title === "Synthetic scale session 00000",
  )!;
  const page = (await reader.messages(selected.id, { after: 0, limit: 50 }))!;
  if (page.items[0]?.kind !== "message" || page.items[0].markdown.length !== 1_000_000)
    throw new Error("Message bound was not exercised");
  const beforeSize = (await stat(paths[0]!)).size;
  await appendFile(
    paths[0]!,
    JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "incremental append" },
    }) + "\n",
  );
  const append = await measure(() => reader.refresh());
  const telemetry = source.lastRefreshTelemetry();
  if (
    telemetry.appendFiles !== 1 ||
    telemetry.fullFiles !== 0 ||
    telemetry.decodeBytes > (await stat(paths[0]!)).size - beforeSize
  )
    throw new Error("Append did not reuse its checkpoint");
  const tail = (await reader.messages(selected.id, { after: page.nextAfter }))!;
  if (tail.items.length !== 1) throw new Error("Ordinal append was not readable");
  const replacement = paths[0]! + ".replacement";
  await writeFile(replacement, (await rollout(0, "replacement", 256)) + "\n");
  await rename(replacement, paths[0]!);
  const replace = await measure(() => reader.refresh());
  console.log(
    JSON.stringify(
      {
        corpus: { sessions: SESSION_COUNT, bytes: await sumSizes(paths) },
        milliseconds: {
          cold: round(cold.measurement.milliseconds),
          noChange: round(noChange.measurement.milliseconds),
          append: round(append.measurement.milliseconds),
          replace: round(replace.measurement.milliseconds),
        },
        appendTelemetry: telemetry,
        messagePageBytes: jsonBytes(page),
        rssBytes: process.memoryUsage().rss,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

async function generateCorpus(directory: string): Promise<string[]> {
  const paths: string[] = [];
  const filler = "scale-filler ".repeat(Math.ceil(FILLER_CHARS / 13)).slice(0, FILLER_CHARS);
  for (let start = 0; start < SESSION_COUNT; start += 50) {
    const batch = Array.from({ length: Math.min(50, SESSION_COUNT - start) }, async (_, offset) => {
      const index = start + offset;
      const id = `scale-${String(index).padStart(5, "0")}`;
      const path = join(directory, `rollout-2026-07-28T12-00-00-${id}.jsonl`);
      const records = [
        await rollout(
          index,
          index === 0 ? "needle-scale" : filler,
          index === 0 ? 1_000_000 : FILLER_CHARS,
        ),
      ];
      if (index === 0) {
        records.push(
          JSON.stringify({
            timestamp: "2026-07-28T12:00:02.000Z",
            type: "response_item",
            payload: {
              type: "function_call",
              name: "large_tool",
              call_id: "large-tool",
              arguments: "I".repeat(512_000),
            },
          }),
        );
        records.push(
          JSON.stringify({
            timestamp: "2026-07-28T12:00:03.000Z",
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "large-tool",
              output: "O".repeat(512_000),
            },
          }),
        );
        for (let item = 0; item < APPEND_PREFIX_ITEMS; item += 1) {
          records.push(
            JSON.stringify({
              timestamp: "2026-07-28T12:00:03.000Z",
              type: "turn_context",
            }),
          );
        }
      }
      const tail = index === 1 ? '\n{"timestamp":"partial' : "\n";
      await writeFile(path, `${(await Promise.all(records)).join("\n")}${tail}`);
      paths[index] = path;
    });
    await Promise.all(batch);
  }
  return paths;
}

async function rollout(index: number, marker: string, messageChars: number): Promise<string> {
  const id = `scale-${String(index).padStart(5, "0")}`;
  const timestamp = new Date(Date.UTC(2026, 6, 28, 12, 0, index % 60)).toISOString();
  const message = `${marker} ${"m".repeat(Math.max(0, messageChars - marker.length - 1))}`;
  return [
    JSON.stringify({
      timestamp,
      type: "session_meta",
      payload: {
        id,
        cwd: `/synthetic/project-${index % 40}`,
        title: `Synthetic scale session ${String(index).padStart(5, "0")}`,
        timestamp,
      },
    }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: index % 2 === 0 ? "user" : "assistant",
        phase: index % 2 === 0 ? undefined : "final_answer",
        content: [{ type: index % 2 === 0 ? "input_text" : "output_text", text: message }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload:
        index % 2 === 0
          ? { type: "user_message", message }
          : { type: "agent_message", phase: "final_answer", message },
    }),
  ].join("\n");
}

async function sumSizes(paths: string[]): Promise<number> {
  let total = 0;
  for (const path of paths) total += (await stat(path)).size;
  return total;
}

async function measure<T>(action: () => Promise<T>): Promise<{
  value: T;
  measurement: Measurement;
}> {
  const startedAt = performance.now();
  const value = await action();
  const measurement = {
    milliseconds: performance.now() - startedAt,
    rssAfterBytes: process.memoryUsage().rss,
  };
  return { value, measurement };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

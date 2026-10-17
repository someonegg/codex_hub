import { appendFile, chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { createCodexSessionSource } from "../src/server/adapters/codex/codex-session-source.js";
import { SessionReadService } from "../src/server/application/session-read-service.js";
import { DEFAULT_CATALOG_FRESHNESS_MS } from "../src/server/repository/catalog-snapshot-store.js";
import {
  deriveTimelinePrefixIndex,
  extendsTimelinePrefix,
  extendTimelinePrefixIndex,
} from "../src/server/repository/timeline-prefix-index.js";
import type { TimelineCursor } from "../src/shared/api-contract.js";

const SESSION_COUNT = 3_000;
const MIN_CORPUS_BYTES = 100 * 1024 * 1024;
const FILLER_CHARS = 18_000;
const APPEND_PREFIX_ITEMS = 1_000;
const PRIOR_SINGLE_APPEND_BASELINE_MS = 266.8;

interface Measurement {
  milliseconds: number;
  rssAfterBytes: number;
}

const root = await mkdtemp("/private/tmp/codex-hub-scale-");
const sessions = join(root, "sessions", "2026", "07", "28");

try {
  await mkdir(sessions, { recursive: true });
  const paths = await generateCorpus(sessions);
  const totalBytes = await sumSizes(paths);
  if (totalBytes < MIN_CORPUS_BYTES) {
    throw new Error(`Synthetic corpus was only ${totalBytes} bytes`);
  }

  let derivationCalls = 0;
  const prefixCalls = { full: 0, append: 0 };
  const prefixMs = { full: 0, append: 0 };
  const prefixIndexBytesBySession = new Map<string, number>();
  const timelineItemsBySession = new Map<string, number>();
  const source = await createCodexSessionSource(root);
  const repository = new SessionReadService(
    [source],
    DEFAULT_CATALOG_FRESHNESS_MS,
    performance.now.bind(performance),
    {
      timelinePrefixIndexBuilder(normalized, prefixKey, previous) {
        derivationCalls += 1;
        const startedAt = performance.now();
        const append =
          previous !== undefined &&
          extendsTimelinePrefix(previous.normalized, normalized) &&
          previous.normalized.timeline.length < normalized.timeline.length;
        const mode = append ? "append" : "full";
        prefixCalls[mode] += 1;
        const result = append
          ? extendTimelinePrefixIndex(
              previous.timelinePrefixIndex,
              previous.normalized,
              normalized,
              prefixKey,
              true,
            )
          : deriveTimelinePrefixIndex(normalized, prefixKey);
        prefixMs[mode] += performance.now() - startedAt;
        const expectedPrefixBytes = (normalized.timeline.length + 1) * 24;
        if (result.byteLength !== expectedPrefixBytes) {
          throw new Error(
            `Prefix index used ${result.byteLength} bytes; ` + `expected ${expectedPrefixBytes}`,
          );
        }
        prefixIndexBytesBySession.set(normalized.session.id, result.byteLength);
        timelineItemsBySession.set(normalized.session.id, normalized.timeline.length);
        return result;
      },
    },
  );
  const coldCatalog = await measure(() => repository.list());
  const coldSourceTelemetry = source.lastRefreshTelemetry();
  assertDerivationDelta("cold catalog", 0, derivationCalls, SESSION_COUNT);
  const firstList = coldCatalog.value;
  const beforeNoChangeDerivations = derivationCalls;
  const noChangeRefresh = await measure(() => repository.refresh());
  const noChangeSourceTelemetry = source.lastRefreshTelemetry();
  if (
    noChangeSourceTelemetry.decodeBytes !== 0 ||
    noChangeSourceTelemetry.fullFiles !== 0 ||
    noChangeSourceTelemetry.appendFiles !== 0
  ) {
    throw new Error("A no-change refresh decoded rollout content");
  }
  assertDerivationDelta("no-change refresh", beforeNoChangeDerivations, derivationCalls, 0);
  const afterNoChangeList = await repository.list();
  if (afterNoChangeList.revision !== firstList.revision) {
    throw new Error("A no-change refresh changed the structural revision");
  }
  const selected = firstList.sessions.find(
    (session) => session.title === "Synthetic scale session 00000",
  );
  if (selected === undefined) {
    throw new Error(
      "Catalog did not find the special session: " +
        JSON.stringify({
          catalog: firstList,
          firstTitles: firstList.sessions.slice(0, 3).map(({ title }) => title),
          derivationCalls,
        }),
    );
  }
  const unrelated = firstList.sessions.find((session) => session.id !== selected.id);
  if (unrelated === undefined)
    throw new Error("Scale catalog did not contain an unrelated session");
  const detailFirstPage = await measure(async () => {
    const items = await repository.getItems(selected.id, {
      limit: 50,
    });
    if (items === null) throw new Error("Scale session item page disappeared");
    return items;
  });
  const unrelatedPage = await repository.getItems(unrelated.id, { limit: 1 });
  if (unrelatedPage === null) throw new Error("Unrelated scale session disappeared");
  const tool = detailFirstPage.value.items.find((item) => item.kind === "tool");
  if (tool?.kind !== "tool") throw new Error("Large tool was not normalized");
  const toolDetail = await repository.getToolDetail(selected.id, tool.id, {
    cursor: detailFirstPage.value.cursor,
  });
  if (!toolDetail?.truncated) throw new Error("Large tool detail was not truncated");
  const message = detailFirstPage.value.items.find((item) => item.kind === "message");
  if (message?.kind !== "message" || message.markdown.length !== 1_000_000) {
    throw new Error("Long message limit was not exercised");
  }

  const specialPath = paths[0]!;
  const beforeAppendBytes = (await stat(specialPath)).size;
  const beforeMutationStructureRevision = firstList.revision;
  const beforeMutatedCursor = detailFirstPage.value.cursor;
  const unrelatedCursor = unrelatedPage.cursor;
  await appendFile(
    specialPath,
    `${JSON.stringify({
      timestamp: "2026-07-28T12:00:03.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "single-session append" }],
      },
    })}\n`,
  );
  const beforeAppendDerivations = derivationCalls;
  const appendRefresh = await measure(() => repository.refresh());
  const appendSourceTelemetry = source.lastRefreshTelemetry();
  const appendedBytes = (await stat(specialPath)).size - beforeAppendBytes;
  if (appendSourceTelemetry.appendFiles !== 1 || appendSourceTelemetry.fullFiles !== 0) {
    throw new Error(
      `Append did not use one incremental decode: ${JSON.stringify(appendSourceTelemetry)}`,
    );
  }
  if (appendSourceTelemetry.decodeBytes > appendedBytes) {
    throw new Error(
      `Append decoded ${appendSourceTelemetry.decodeBytes} bytes for ${appendedBytes} appended bytes`,
    );
  }
  if (
    appendSourceTelemetry.decodeBytes + appendSourceTelemetry.probeBytes >
    appendedBytes + 2 * 4 * 1024
  ) {
    throw new Error("Append read exceeded two probes plus the appended tail");
  }
  assertDerivationDelta("single-session append", beforeAppendDerivations, derivationCalls, 1);
  const afterAppendList = await repository.list();
  await assertCursorReadable(repository, selected.id, beforeMutatedCursor);
  await assertCursorReadable(repository, unrelated.id, unrelatedCursor);

  const replacement = `${specialPath}.replacement`;
  await writeFile(replacement, `${await rollout(0, "atomic-replacement", 256)}\n`);
  await rename(replacement, specialPath);
  const beforeReplacementDerivations = derivationCalls;
  const replaceRefresh = await measure(() => repository.refresh());
  const replaceSourceTelemetry = source.lastRefreshTelemetry();
  assertDerivationDelta(
    "single-session replacement",
    beforeReplacementDerivations,
    derivationCalls,
    1,
  );
  const afterReplaceList = await repository.list();
  let replacementConflict = false;
  try {
    await repository.getItems(selected.id, { cursor: beforeMutatedCursor, limit: 1 });
  } catch (error) {
    replacementConflict =
      error instanceof Error && "code" in error && error.code === "timeline_changed";
  }
  if (!replacementConflict) throw new Error("Replacement did not reject the old timeline cursor");
  await assertCursorReadable(repository, unrelated.id, unrelatedCursor);

  let permissionProbe: "hidden" | "portable-skip" = "portable-skip";
  try {
    await chmod(specialPath, 0);
    await repository.refresh();
    const unavailable = await repository.getSession(selected.id);
    if (unavailable === null) permissionProbe = "hidden";
  } finally {
    await chmod(specialPath, 0o600);
  }

  const result = {
    corpus: {
      directory: "/private/tmp/codex-hub-scale-<random>",
      sessionCount: SESSION_COUNT,
      bytes: totalBytes,
    },
    timingMs: {
      coldCatalog: round(coldCatalog.measurement.milliseconds),
      noChangeRefresh: round(noChangeRefresh.measurement.milliseconds),
      singleSessionAppendRefresh: round(appendRefresh.measurement.milliseconds),
      singleSessionReplaceRefresh: round(replaceRefresh.measurement.milliseconds),
      detailFirstPage: round(detailFirstPage.measurement.milliseconds),
      decode: {
        cold: round(coldSourceTelemetry.decodeMs),
        append: round(appendSourceTelemetry.decodeMs),
        replace: round(replaceSourceTelemetry.decodeMs),
      },
      normalize: {
        cold: round(coldSourceTelemetry.normalizeMs),
        append: round(appendSourceTelemetry.normalizeMs),
        replace: round(replaceSourceTelemetry.normalizeMs),
      },
      prefix: { full: round(prefixMs.full), append: round(prefixMs.append) },
    },
    baselineComparison: {
      priorSingleSessionAppendMs: PRIOR_SINGLE_APPEND_BASELINE_MS,
      measuredSingleSessionAppendMs: round(appendRefresh.measurement.milliseconds),
      reductionPercent: round(
        (100 * (PRIOR_SINGLE_APPEND_BASELINE_MS - appendRefresh.measurement.milliseconds)) /
          PRIOR_SINGLE_APPEND_BASELINE_MS,
      ),
      hardTimingGate: false,
    },
    memory: {
      processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
      coldCatalogRssAfterBytes: coldCatalog.measurement.rssAfterBytes,
      noChangeRefreshRssAfterBytes: noChangeRefresh.measurement.rssAfterBytes,
      appendRefreshRssAfterBytes: appendRefresh.measurement.rssAfterBytes,
      replaceRefreshRssAfterBytes: replaceRefresh.measurement.rssAfterBytes,
      detailFirstPageRssAfterBytes: detailFirstPage.measurement.rssAfterBytes,
      timelinePrefixIndexes: {
        bytes: sum(prefixIndexBytesBySession.values()),
        sessions: prefixIndexBytesBySession.size,
        timelineItems: sum(timelineItemsBySession.values()),
        storedBoundaries: sum(timelineItemsBySession.values()) + prefixIndexBytesBySession.size,
        bytesPerStoredBoundary: round(
          sum(prefixIndexBytesBySession.values()) /
            Math.max(1, sum(timelineItemsBySession.values()) + prefixIndexBytesBySession.size),
        ),
        amortizedBytesPerTimelineItem: round(
          sum(prefixIndexBytesBySession.values()) /
            Math.max(1, sum(timelineItemsBySession.values())),
        ),
        baseBytesPerSession: 24,
        incrementalBytesPerTimelineItem: 24,
        slotBytes: 24,
      },
    },
    responseBytes: {
      firstList: jsonBytes(firstList),
      firstItemPage: jsonBytes(detailFirstPage.value),
    },
    bounds: {
      catalogTotal: firstList.sessions.length,
      toolDetailLimitExercised: toolDetail.truncated,
      longMessageLimitExercised: message.markdown.length === 1_000_000,
      partialTailExercised: true,
      permissionProbe,
      rolloutReadBytes: {
        cold: coldSourceTelemetry,
        noChange: noChangeSourceTelemetry,
        append: appendSourceTelemetry,
        replace: replaceSourceTelemetry,
      },
      appendHistoricalTimelineItems: detailFirstPage.value.session.itemCount,
    },
    mutations: {
      structuralRevision: {
        unchangedAfterContentAppend: beforeMutationStructureRevision === afterAppendList.revision,
        unchangedAfterContentReplacement: afterAppendList.revision === afterReplaceList.revision,
      },
      appendCursorReadable: true,
      replacementConflict,
      unrelatedCursorReadable: true,
    },
    derivationCalls: {
      total: derivationCalls,
      prefixByMode: prefixCalls,
      expected: {
        coldCatalog: SESSION_COUNT,
        noChangeRefresh: 0,
        singleSessionAppendRefresh: 1,
        singleSessionReplaceRefresh: 1,
      },
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function assertDerivationDelta(
  label: string,
  before: number,
  after: number,
  expected: number,
): void {
  const prefixIndex = after - before;
  if (prefixIndex !== expected) {
    throw new Error(
      `${label} derivation calls: expected ${expected}, got ` + `prefixIndex=${prefixIndex}`,
    );
  }
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
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

type Reader = SessionReadService;

async function assertCursorReadable(
  sessions: Reader,
  sessionId: string,
  cursor: TimelineCursor,
): Promise<void> {
  const page = await sessions.getItems(sessionId, {
    cursor,
    limit: 1,
  });
  if (page === null) {
    throw new Error("An unrelated session cursor was not readable");
  }
}

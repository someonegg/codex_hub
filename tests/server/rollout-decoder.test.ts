import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_JSONL_LINE_BYTES } from "../../src/server/adapters/codex/limits.js";
import { PathPolicy } from "../../src/server/adapters/codex/path-policy.js";
import { CheckpointedRolloutDecoder } from "../../src/server/adapters/codex/rollout-decoder.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

describe("CheckpointedRolloutDecoder", () => {
  it("keeps physical ordinals, continues after malformed records, and ignores a partial tail", async () => {
    const home = await createTempDirectory("codex-decode-");
    const directory = join(home, "sessions", "2026", "07", "28");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "rollout-decoder.jsonl");
    const fixture = await readFile("tests/fixtures/codex-home/partial-tail.fragment", "utf8");
    await writeFile(path, fixture.trimEnd());
    const policy = await PathPolicy.create(home);
    const descriptor = await policy.register(path);
    expect(descriptor).not.toBeNull();

    const decoded = await new CheckpointedRolloutDecoder().decode(descriptor!);
    expect(decoded.records.map((record) => [record.ordinal, record.value.type])).toEqual([
      [1, "one"],
      [3, "three"],
    ]);
    expect(decoded.diagnostics).toEqual([
      expect.objectContaining({ code: "malformed_json", ordinal: 2 }),
    ]);
  });

  it.each([
    ["ordinary", Buffer.from("ordinary tail")],
    ["whitespace", Buffer.from("   \t\r")],
    ["valid JSON", Buffer.from('{"type":"pending"}')],
    ["non-object JSON", Buffer.from("[]")],
    ["partial UTF-8", Buffer.from([0xe2, 0x82])],
  ])("silently ignores an unterminated %s tail", async (_label, tail) => {
    const { path, descriptor } = await rollout(
      "silent-tail",
      Buffer.concat([Buffer.from('{"type":"committed"}\n'), tail]),
    );
    const decoder = new CheckpointedRolloutDecoder();
    const before = await decoder.decode(descriptor);
    expect(before.records.map((record) => record.value.type)).toEqual(["committed"]);
    expect(before.diagnostics).toEqual([]);

    await appendFile(path, "\n");
    const after = await decoder.decode(descriptor, before.checkpoint);
    expect(after.mode).toBe("append");
    if (_label === "valid JSON") {
      expect(after.records.map((record) => record.value.type)).toEqual(["pending"]);
      expect(after.diagnostics).toEqual([]);
    } else if (_label === "non-object JSON") {
      expect(after.diagnostics).toEqual([
        expect.objectContaining({ code: "invalid_record", ordinal: 2 }),
      ]);
    } else {
      expect(after.diagnostics).toEqual([
        expect.objectContaining({ code: "malformed_json", ordinal: 2 }),
      ]);
    }
  });

  it("warns about an oversized line only after its terminating newline arrives", async () => {
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x78);
    const { path, descriptor } = await rollout("oversized-tail", oversized);
    const decoder = new CheckpointedRolloutDecoder();

    const before = await decoder.decode(descriptor);
    expect(before.diagnostics).toEqual([]);
    await appendFile(path, "\n");
    const after = await decoder.decode(descriptor, before.checkpoint);
    expect(after.mode).toBe("append");
    expect(after.diagnostics).toEqual([
      expect.objectContaining({ code: "line_too_large", ordinal: 1 }),
    ]);
  });

  it("accepts a JSON body exactly at the line limit with CRLF", async () => {
    const shell = Buffer.byteLength('{"value":""}');
    const valueLength = MAX_JSONL_LINE_BYTES - shell;
    const line = `{"value":"${"x".repeat(valueLength)}"}`;
    const { path, descriptor } = await rollout("crlf-limit", "");
    await appendFile(path, `${line}\r\n`);

    const decoded = await new CheckpointedRolloutDecoder().decode(descriptor);
    const value = decoded.records[0]?.value.value;

    expect(decoded.mode).toBe("full");
    expect(decoded.diagnostics).toEqual([]);
    expect(typeof value).toBe("string");
    expect((value as string).length).toBe(valueLength);
    expect((value as string).at(0)).toBe("x");
    expect((value as string).at(-1)).toBe("x");
  });

  it("accepts an appended CRLF record from a checkpoint boundary", async () => {
    const { path, descriptor } = await rollout("crlf-append", '{"type":"first"}\n');
    const decoder = new CheckpointedRolloutDecoder();
    const before = await decoder.decode(descriptor);
    await appendFile(path, '{"type":"second"}\r\n');

    const after = await decoder.decode(descriptor, before.checkpoint);

    expect(after.mode).toBe("append");
    expect(after.diagnostics).toEqual([]);
    expect(after.records).toEqual([
      expect.objectContaining({ ordinal: 2, value: { type: "second" } }),
    ]);
  });

  it("keeps only the first 50 diagnostics while preserving physical ordinals", async () => {
    const home = await createTempDirectory("codex-decode-limit-");
    const directory = join(home, "sessions", "2026", "07", "28");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "rollout-decoder-limit.jsonl");
    const malformedLines = Array.from({ length: 60 }, (_, index) => `malformed-${index + 1}`);
    await writeFile(path, `${malformedLines.join("\n")}\n{"type":"valid"}\n`);
    const policy = await PathPolicy.create(home);
    const descriptor = await policy.register(path);
    expect(descriptor).not.toBeNull();

    const decoded = await new CheckpointedRolloutDecoder().decode(descriptor!);

    expect(decoded.diagnostics).toHaveLength(50);
    expect(decoded.diagnostics.map((diagnostic) => diagnostic.ordinal)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    expect(decoded.records).toEqual([
      expect.objectContaining({ ordinal: 61, value: { type: "valid" } }),
    ]);
  });

  it("returns only newly committed records on a validated append", async () => {
    const initial = Buffer.from('{"type":"one"}\nmalformed\n{"type":"pending"}');
    const { path, descriptor } = await rollout("checkpoint-append", initial);
    const decoder = new CheckpointedRolloutDecoder();
    const before = await decoder.decode(descriptor);

    expect(before.mode).toBe("full");
    expect(before.checkpoint).toMatchObject({
      observedEof: initial.length,
      committedOffset: Buffer.byteLength('{"type":"one"}\nmalformed\n'),
      physicalLineCount: 2,
    });
    expect(before.diagnostics).toEqual([
      expect.objectContaining({ code: "malformed_json", ordinal: 2 }),
    ]);

    const appended = Buffer.from('\n{"type":"four"}\n');
    await appendFile(path, appended);
    const after = await decoder.decode(descriptor, before.checkpoint);

    expect(after.mode).toBe("append");
    expect(after.records.map(({ ordinal, value }) => [ordinal, value.type])).toEqual([
      [3, "pending"],
      [4, "four"],
    ]);
    expect(after.diagnostics).toEqual(before.diagnostics);
    expect(after.batchDiagnostics).toEqual([]);
    expect(after.checkpoint).toMatchObject({
      observedEof: initial.length + appended.length,
      committedOffset: initial.length + appended.length,
      physicalLineCount: 4,
    });
    expect(after.telemetry.decodeBytes).toBe(
      Buffer.byteLength('{"type":"pending"}') + appended.length,
    );
    expect(after.telemetry.totalBytes).toBe(
      after.telemetry.probeBytes + after.telemetry.decodeBytes,
    );
  });

  it("re-reads an unterminated tail without duplicating ordinals or diagnostics", async () => {
    const { path, descriptor } = await rollout("checkpoint-tail", '{"type":"one"}\nmalformed');
    const decoder = new CheckpointedRolloutDecoder();
    const first = await decoder.decode(descriptor);
    expect(first.records).toEqual([
      expect.objectContaining({ ordinal: 1, value: { type: "one" } }),
    ]);
    expect(first.diagnostics).toEqual([]);

    await appendFile(path, "-tail");
    const second = await decoder.decode(descriptor, first.checkpoint);
    expect(second.mode).toBe("append");
    expect(second.records).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(second.checkpoint.physicalLineCount).toBe(1);
    expect(second.checkpoint.committedOffset).toBe(first.checkpoint.committedOffset);

    await appendFile(path, "\n");
    const third = await decoder.decode(descriptor, second.checkpoint);
    expect(third.mode).toBe("append");
    expect(third.records).toEqual([]);
    expect(third.batchDiagnostics).toEqual([
      expect.objectContaining({ code: "malformed_json", ordinal: 2 }),
    ]);
    expect(third.diagnostics).toEqual(third.batchDiagnostics);
    expect(third.checkpoint.physicalLineCount).toBe(2);
  });

  it.each(["head", "old EOF"])(
    "falls back to a full decode when the %s probe changes before growth",
    async (probe) => {
      const prefix = `${'{"type":"first"}\n'}${" ".repeat(9_000)}`;
      const { path, descriptor } = await rollout("checkpoint-probe", prefix);
      const decoder = new CheckpointedRolloutDecoder();
      const first = await decoder.decode(descriptor);
      const changed = Buffer.from(prefix);
      const position = probe === "head" ? 0 : changed.length - 1;
      changed[position] = changed[position] === 0x20 ? 0x21 : 0x20;
      await writeFile(path, Buffer.concat([changed, Buffer.from('\n{"type":"appended"}\n')]));

      const next = await decoder.decode(descriptor, first.checkpoint);

      expect(next.mode).toBe("full");
      expect(next.telemetry.decodeBytes).toBe(next.checkpoint.observedEof);
      expect(next.records.at(-1)).toEqual(expect.objectContaining({ value: { type: "appended" } }));
      expect(next.diagnostics).toContainEqual(
        expect.objectContaining({ code: "malformed_json", ordinal: 2 }),
      );
    },
  );

  it("falls back on non-growth and an incompatible decoder version", async () => {
    const { path, descriptor } = await rollout("checkpoint-compatibility", '{"type":"one"}\n');
    const decoder = new CheckpointedRolloutDecoder();
    const first = await decoder.decode(descriptor);

    expect((await decoder.decode(descriptor, first.checkpoint)).mode).toBe("full");

    await appendFile(path, '{"type":"two"}\n');
    const incompatible = {
      ...first.checkpoint,
      decoderVersion: first.checkpoint.decoderVersion + 1,
    };
    const next = await decoder.decode(descriptor, incompatible);
    expect(next.mode).toBe("full");
    expect(next.records.map(({ value }) => value.type)).toEqual(["one", "two"]);
  });

  it("keeps cumulative decoder diagnostics capped across append checkpoints", async () => {
    const firstLines = Array.from({ length: 49 }, (_, index) => `bad-${index}`).join("\n");
    const { path, descriptor } = await rollout("checkpoint-diagnostics", `${firstLines}\n`);
    const decoder = new CheckpointedRolloutDecoder();
    const first = await decoder.decode(descriptor);
    expect(first.diagnostics).toHaveLength(49);

    await appendFile(path, "bad-50\nbad-51\n");
    const next = await decoder.decode(descriptor, first.checkpoint);
    expect(next.mode).toBe("append");
    expect(next.diagnostics).toHaveLength(50);
    expect(next.batchDiagnostics).toEqual([
      expect.objectContaining({ code: "malformed_json", ordinal: 50 }),
    ]);
    expect(next.checkpoint.diagnostics).toHaveLength(50);
  });
});

async function rollout(name: string, contents: string | Uint8Array) {
  const home = await createTempDirectory(`codex-${name}-`);
  const directory = join(home, "sessions");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-${name}.jsonl`);
  await writeFile(path, contents);
  const policy = await PathPolicy.create(home);
  const descriptor = await policy.register(path);
  if (descriptor === null) throw new Error("Fixture path was rejected");
  return { path, descriptor };
}

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CheckpointedJsonlDecoder } from "../../src/server/adapters/shared/jsonl-decoder.js";
import { MAX_JSONL_LINE_BYTES } from "../../src/server/adapters/shared/limits.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

describe("checkpointed JSONL decoder", () => {
  it("keeps physical ordinals, continues after malformed records, and ignores a partial tail", async () => {
    const fixture = await readFile("tests/fixtures/jsonl/partial-tail.fragment", "utf8");
    const { descriptor } = await jsonlFile("partial-tail", fixture.trimEnd());
    const decoded = await new CheckpointedJsonlDecoder().decode(descriptor);
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
  ])("silently ignores an unterminated %s tail", async (label, tail) => {
    const { path, descriptor } = await jsonlFile(
      "silent-tail",
      Buffer.concat([Buffer.from('{"type":"committed"}\n'), tail]),
    );
    const decoder = new CheckpointedJsonlDecoder();
    const before = await decoder.decode(descriptor);
    expect(before.records.map((record) => record.value.type)).toEqual(["committed"]);
    expect(before.diagnostics).toEqual([]);

    await appendFile(path, "\n");
    const after = await decoder.decode(descriptor, before.checkpoint);
    expect(after.mode).toBe("append");
    if (label === "valid JSON") {
      expect(after.records.map((record) => record.value.type)).toEqual(["pending"]);
      expect(after.diagnostics).toEqual([]);
    } else if (label === "non-object JSON") {
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
    const { path, descriptor } = await jsonlFile("oversized-tail", oversized);
    const decoder = new CheckpointedJsonlDecoder();

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
    const { path, descriptor } = await jsonlFile("crlf-limit", "");
    await appendFile(path, `${line}\r\n`);

    const decoded = await new CheckpointedJsonlDecoder().decode(descriptor);
    const value = decoded.records[0]?.value.value;

    expect(decoded.mode).toBe("full");
    expect(decoded.diagnostics).toEqual([]);
    expect(typeof value).toBe("string");
    expect((value as string).length).toBe(valueLength);
    expect((value as string).at(0)).toBe("x");
    expect((value as string).at(-1)).toBe("x");
  });

  it("accepts an appended CRLF record from a checkpoint boundary", async () => {
    const { path, descriptor } = await jsonlFile("crlf-append", '{"type":"first"}\n');
    const decoder = new CheckpointedJsonlDecoder();
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
    const malformedLines = Array.from({ length: 60 }, (_, index) => `malformed-${index + 1}`);
    const { descriptor } = await jsonlFile(
      "diagnostic-limit",
      `${malformedLines.join("\n")}\n{"type":"valid"}\n`,
    );
    const decoded = await new CheckpointedJsonlDecoder().decode(descriptor);

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
    const { path, descriptor } = await jsonlFile("checkpoint-append", initial);
    const decoder = new CheckpointedJsonlDecoder();
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
    const { path, descriptor } = await jsonlFile("checkpoint-tail", '{"type":"one"}\nmalformed');
    const decoder = new CheckpointedJsonlDecoder();
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
      const { path, descriptor } = await jsonlFile("checkpoint-probe", prefix);
      const decoder = new CheckpointedJsonlDecoder();
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

  it("falls back on non-growth", async () => {
    const { descriptor } = await jsonlFile("checkpoint-non-growth", '{"type":"one"}\n');
    const decoder = new CheckpointedJsonlDecoder();
    const first = await decoder.decode(descriptor);

    expect((await decoder.decode(descriptor, first.checkpoint)).mode).toBe("full");
  });

  it("preserves UTF-8 spanning stream chunks and CRLF physical ordinals", async () => {
    const prefix = '{"value":"';
    const padding = "x".repeat(65535 - Buffer.byteLength(prefix));
    const value = padding + "😀中文";
    const { descriptor } = await jsonlFile(
      "utf8-chunks",
      JSON.stringify({ value }) + "\r\n\r\n{}\r\n",
    );
    const result = await new CheckpointedJsonlDecoder().decode(descriptor);
    expect(result.records).toEqual([
      { ordinal: 1, value: { value } },
      { ordinal: 3, value: {} },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("rebuilds on truncation and equal-length edits", async () => {
    const { path, descriptor } = await jsonlFile("rewrites", '{"value":"one"}\n{}\n');
    const decoder = new CheckpointedJsonlDecoder();
    const first = await decoder.decode(descriptor);
    await writeFile(path, '{"value":"two"}\n{}\n');
    const edited = await decoder.decode(descriptor, first.checkpoint);
    expect(edited.mode).toBe("full");
    expect(edited.records[0]?.value.value).toBe("two");
    await writeFile(path, "{}\n");
    const truncated = await decoder.decode(descriptor, edited.checkpoint);
    expect(truncated.mode).toBe("full");
    expect(truncated.records).toEqual([{ ordinal: 1, value: {} }]);
  });

  it("keeps cumulative decoder diagnostics capped across append checkpoints", async () => {
    const firstLines = Array.from({ length: 49 }, (_, index) => `bad-${index}`).join("\n");
    const { path, descriptor } = await jsonlFile("checkpoint-diagnostics", `${firstLines}\n`);
    const decoder = new CheckpointedJsonlDecoder();
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

async function jsonlFile(name: string, contents: string | Uint8Array) {
  const directory = await createTempDirectory(`jsonl-${name}-`);
  const path = join(directory, `${name}.jsonl`);
  await writeFile(path, contents);
  return { path, descriptor: { path } };
}

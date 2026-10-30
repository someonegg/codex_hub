import { createHash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";

import type { DomainDiagnostic as Diagnostic } from "../../domain/session-domain.js";
import { DECODER_VERSION, MAX_JSONL_LINE_BYTES, MAX_SESSION_DIAGNOSTICS } from "./limits.js";
import type { RolloutDescriptor } from "./rollout-descriptor.js";

const PROBE_BYTES = 4 * 1024;

export interface DecodedRecord {
  ordinal: number;
  value: Record<string, unknown>;
}

export interface RolloutProbe {
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}

export interface RolloutCheckpoint {
  readonly decoderVersion: number;
  readonly observedEof: number;
  readonly committedOffset: number;
  readonly physicalLineCount: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly headProbe: RolloutProbe;
  readonly tailProbe: RolloutProbe;
}

export interface RolloutDecodeTelemetry {
  readonly probeBytes: number;
  readonly decodeBytes: number;
  readonly totalBytes: number;
}

export interface DecodedRollout {
  descriptor: RolloutDescriptor;
  /** Records decoded by this invocation. A full decode returns every record. */
  records: DecodedRecord[];
  /** All retained decoder diagnostics through this checkpoint. */
  diagnostics: Diagnostic[];
}

export interface IncrementalDecodedRollout extends DecodedRollout {
  /** Newly retained decoder diagnostics produced by this invocation. */
  readonly batchDiagnostics: Diagnostic[];
  readonly mode: "full" | "append";
  readonly checkpoint: RolloutCheckpoint;
  readonly telemetry: RolloutDecodeTelemetry;
}

export interface RolloutDecoder {
  decode(
    descriptor: RolloutDescriptor,
    checkpoint?: RolloutCheckpoint,
  ): Promise<IncrementalDecodedRollout>;
}

export class CheckpointedRolloutDecoder implements RolloutDecoder {
  async decode(
    descriptor: RolloutDescriptor,
    checkpoint?: RolloutCheckpoint,
  ): Promise<IncrementalDecodedRollout> {
    const handle = await open(descriptor.path, "r");
    try {
      const observedEof = (await handle.stat()).size;
      let probeBytes = 0;
      let appendCheckpoint: RolloutCheckpoint | null = null;
      let validatedWindows: readonly ByteWindow[] = [];
      if (isCompatibleCheckpoint(checkpoint, observedEof)) {
        const validation = await validateProbes(handle, checkpoint);
        probeBytes += validation.bytesRead;
        if (validation.matches) {
          appendCheckpoint = checkpoint;
          validatedWindows = validation.windows;
        }
      }

      const start = appendCheckpoint?.committedOffset ?? 0;
      const baseOrdinal = appendCheckpoint?.physicalLineCount ?? 0;
      const priorDiagnostics = appendCheckpoint?.diagnostics ?? [];
      const decoded = await decodeRange(handle, start, observedEof, baseOrdinal, priorDiagnostics);
      const probes = createProbes(observedEof, [
        ...validatedWindows,
        { offset: start, contents: decoded.headBytes },
        { offset: decoded.tailOffset, contents: decoded.tailBytes },
      ]);
      const checkpointDiagnostics = decoded.diagnostics.map(cloneDiagnostic);
      const nextCheckpoint: RolloutCheckpoint = {
        decoderVersion: DECODER_VERSION,
        observedEof,
        committedOffset: decoded.committedOffset,
        physicalLineCount: decoded.physicalLineCount,
        diagnostics: checkpointDiagnostics,
        headProbe: probes.head,
        tailProbe: probes.tail,
      };
      return {
        descriptor,
        records: decoded.records,
        diagnostics: checkpointDiagnostics.map(cloneDiagnostic),
        batchDiagnostics: decoded.batchDiagnostics.map(cloneDiagnostic),
        mode: appendCheckpoint === null ? "full" : "append",
        checkpoint: nextCheckpoint,
        telemetry: {
          probeBytes,
          decodeBytes: decoded.bytesRead,
          totalBytes: probeBytes + decoded.bytesRead,
        },
      };
    } finally {
      await handle.close();
    }
  }
}

interface RangeDecodeResult {
  readonly records: DecodedRecord[];
  readonly diagnostics: Diagnostic[];
  readonly batchDiagnostics: Diagnostic[];
  readonly committedOffset: number;
  readonly physicalLineCount: number;
  readonly bytesRead: number;
  readonly headBytes: Buffer;
  readonly tailBytes: Buffer;
  readonly tailOffset: number;
}

async function decodeRange(
  handle: FileHandle,
  start: number,
  observedEof: number,
  baseOrdinal: number,
  priorDiagnostics: readonly Diagnostic[],
): Promise<RangeDecodeResult> {
  const records: DecodedRecord[] = [];
  const diagnostics = priorDiagnostics.slice(0, MAX_SESSION_DIAGNOSTICS).map(cloneDiagnostic);
  const batchDiagnostics: Diagnostic[] = [];
  const lineChunks: Buffer[] = [];
  let lineBytes = 0;
  let ordinal = baseOrdinal;
  let committedOffset = start;
  let bytesRead = 0;
  let droppingOversizedLine = false;
  const headParts: Buffer[] = [];
  let headLength = 0;
  let tailBytes: Buffer = Buffer.alloc(0);

  if (start < observedEof) {
    const stream = handle.createReadStream({
      autoClose: false,
      start,
      end: observedEof - 1,
    });
    for await (const rawChunk of stream) {
      const chunk = rawChunk as Buffer;
      bytesRead += chunk.length;
      if (headLength < PROBE_BYTES) {
        const part = chunk.subarray(0, PROBE_BYTES - headLength);
        headParts.push(part);
        headLength += part.length;
      }
      tailBytes = tailWindow(tailBytes, chunk);
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(0x0a, cursor);
        const end = newline < 0 ? chunk.length : newline;
        if (!droppingOversizedLine && end > cursor) {
          const part = chunk.subarray(cursor, end);
          lineBytes += part.length;
          // Keep one possible trailing CR until the newline decides whether it
          // is part of a CRLF terminator. decodeLine applies the final limit
          // after stripping that CR.
          if (lineBytes > MAX_JSONL_LINE_BYTES + 1) {
            lineChunks.length = 0;
            droppingOversizedLine = true;
          } else {
            lineChunks.push(part);
          }
        }
        if (newline < 0) break;

        ordinal += 1;
        committedOffset = start + bytesRead - (chunk.length - newline - 1);
        if (droppingOversizedLine) {
          retainDiagnostic(diagnostics, batchDiagnostics, lineTooLargeDiagnostic(ordinal));
        } else {
          decodeLine(
            lineBuffer(lineChunks, lineBytes),
            ordinal,
            records,
            diagnostics,
            batchDiagnostics,
          );
        }
        lineChunks.length = 0;
        lineBytes = 0;
        droppingOversizedLine = false;
        cursor = newline + 1;
      }
    }
  }

  return {
    records,
    diagnostics,
    batchDiagnostics,
    committedOffset,
    physicalLineCount: ordinal,
    bytesRead,
    headBytes: Buffer.concat(headParts, headLength),
    tailBytes,
    tailOffset: observedEof - tailBytes.length,
  };
}

function lineBuffer(chunks: readonly Buffer[], length: number): Buffer {
  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return chunks[0]!;
  return Buffer.concat(chunks, length);
}

function decodeLine(
  rawLine: Buffer,
  ordinal: number,
  records: DecodedRecord[],
  diagnostics: Diagnostic[],
  batchDiagnostics: Diagnostic[],
): void {
  const line = rawLine.at(-1) === 0x0d ? rawLine.subarray(0, -1) : rawLine;
  if (line.length === 0) return;
  if (line.length > MAX_JSONL_LINE_BYTES) {
    retainDiagnostic(diagnostics, batchDiagnostics, lineTooLargeDiagnostic(ordinal));
    return;
  }
  try {
    const value: unknown = JSON.parse(line.toString("utf8"));
    if (!isObject(value)) {
      retainDiagnostic(diagnostics, batchDiagnostics, {
        code: "invalid_record",
        severity: "warning",
        message: "A rollout line was not a JSON object and was skipped.",
        ordinal,
      });
      return;
    }
    records.push({ ordinal, value });
  } catch {
    retainDiagnostic(diagnostics, batchDiagnostics, {
      code: "malformed_json",
      severity: "warning",
      message: "A malformed rollout line was skipped.",
      ordinal,
    });
  }
}

function lineTooLargeDiagnostic(ordinal: number): Diagnostic {
  return {
    code: "line_too_large",
    severity: "warning",
    message: "A rollout record exceeded the decode limit and was skipped.",
    ordinal,
  };
}

function retainDiagnostic(
  diagnostics: Diagnostic[],
  batchDiagnostics: Diagnostic[],
  diagnostic: Diagnostic,
): void {
  if (diagnostics.length < MAX_SESSION_DIAGNOSTICS) {
    diagnostics.push(cloneDiagnostic(diagnostic));
    batchDiagnostics.push(cloneDiagnostic(diagnostic));
  }
}

function isCompatibleCheckpoint(
  checkpoint: RolloutCheckpoint | undefined,
  observedEof: number,
): checkpoint is RolloutCheckpoint {
  return (
    checkpoint !== undefined &&
    checkpoint.decoderVersion === DECODER_VERSION &&
    Number.isSafeInteger(checkpoint.observedEof) &&
    Number.isSafeInteger(checkpoint.committedOffset) &&
    Number.isSafeInteger(checkpoint.physicalLineCount) &&
    checkpoint.observedEof >= checkpoint.committedOffset &&
    checkpoint.committedOffset >= 0 &&
    checkpoint.physicalLineCount >= 0 &&
    checkpoint.diagnostics.length <= MAX_SESSION_DIAGNOSTICS &&
    validProbeGeometry(checkpoint) &&
    observedEof > checkpoint.observedEof
  );
}

function validProbeGeometry(checkpoint: RolloutCheckpoint): boolean {
  const headLength = Math.min(PROBE_BYTES, checkpoint.observedEof);
  const tailOffset = Math.max(0, checkpoint.observedEof - PROBE_BYTES);
  return (
    checkpoint.headProbe.offset === 0 &&
    checkpoint.headProbe.length === headLength &&
    checkpoint.tailProbe.offset === tailOffset &&
    checkpoint.tailProbe.length === checkpoint.observedEof - tailOffset
  );
}

async function validateProbes(
  handle: FileHandle,
  checkpoint: RolloutCheckpoint,
): Promise<{ matches: boolean; bytesRead: number; windows: readonly ByteWindow[] }> {
  const head = await readProbe(handle, checkpoint.headProbe);
  const tail = await readProbe(handle, checkpoint.tailProbe);
  return {
    matches: head.matches && tail.matches,
    bytesRead: head.bytesRead + tail.bytesRead,
    windows: [
      { offset: checkpoint.headProbe.offset, contents: head.contents },
      { offset: checkpoint.tailProbe.offset, contents: tail.contents },
    ],
  };
}

function createProbes(
  observedEof: number,
  windows: readonly ByteWindow[],
): { head: RolloutProbe; tail: RolloutProbe } {
  const headLength = Math.min(PROBE_BYTES, observedEof);
  const tailOffset = Math.max(0, observedEof - PROBE_BYTES);
  return {
    head: probeFromWindows(0, headLength, windows),
    tail: probeFromWindows(tailOffset, observedEof - tailOffset, windows),
  };
}

async function probeAt(
  handle: FileHandle,
  offset: number,
  length: number,
): Promise<{ probe: RolloutProbe; bytesRead: number; contents: Buffer }> {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  if (length > 0) {
    ({ bytesRead } = await handle.read(buffer, 0, length, offset));
  }
  const contents = buffer.subarray(0, bytesRead);
  return {
    probe: {
      offset,
      length: bytesRead,
      sha256: sha256(contents),
    },
    bytesRead,
    contents,
  };
}

async function readProbe(
  handle: FileHandle,
  expected: RolloutProbe,
): Promise<{ matches: boolean; bytesRead: number; contents: Buffer }> {
  if (
    !Number.isSafeInteger(expected.offset) ||
    expected.offset < 0 ||
    !Number.isSafeInteger(expected.length) ||
    expected.length < 0
  )
    return { matches: false, bytesRead: 0, contents: Buffer.alloc(0) };
  const actual = await probeAt(handle, expected.offset, expected.length);
  const contents = actual.contents;
  return {
    matches: actual.probe.length === expected.length && actual.probe.sha256 === expected.sha256,
    bytesRead: actual.bytesRead,
    contents,
  };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ByteWindow {
  readonly offset: number;
  readonly contents: Buffer;
}

function tailWindow(previous: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= PROBE_BYTES) return chunk.subarray(chunk.length - PROBE_BYTES);
  const keep = Math.min(previous.length, PROBE_BYTES - chunk.length);
  return Buffer.concat([previous.subarray(previous.length - keep), chunk], keep + chunk.length);
}

function probeFromWindows(
  offset: number,
  length: number,
  windows: readonly ByteWindow[],
): RolloutProbe {
  const contents = Buffer.alloc(length);
  let cursor = offset;
  while (cursor < offset + length) {
    const window = windows.find(
      ({ offset: windowOffset, contents: value }) =>
        cursor >= windowOffset && cursor < windowOffset + value.length,
    );
    if (window === undefined) {
      throw new Error("Decoder probe bytes were not retained");
    }
    const sourceStart = cursor - window.offset;
    const copied = window.contents.copy(
      contents,
      cursor - offset,
      sourceStart,
      Math.min(window.contents.length, sourceStart + offset + length - cursor),
    );
    cursor += copied;
  }
  return { offset, length, sha256: sha256(contents) };
}

function cloneDiagnostic(value: Diagnostic): Diagnostic {
  return { ...value };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

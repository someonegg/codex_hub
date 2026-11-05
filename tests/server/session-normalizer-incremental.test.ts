import { describe, expect, it } from "vitest";

import { IdentityResolver } from "../../src/server/adapters/codex/identity-resolver.js";
import { DefaultSessionNormalizer } from "../../src/server/adapters/codex/session-normalizer.js";
import type { DecodedRecord } from "../../src/server/adapters/shared/jsonl-decoder.js";
import { sessionMetadata } from "./session-normalizer.fixtures.js";

const descriptor = {
  id: "incremental",
  path: "/synthetic/rollout-matching-thread.jsonl",
  sourceRelativePath: "sessions/rollout-matching-thread.jsonl",
  archived: false,
  size: 1,
  mtimeMs: 1,
};

describe("incremental Codex derivation", () => {
  it("updates identity copy-on-write when the first filename match arrives later", () => {
    const resolver = new IdentityResolver();
    const empty = resolver.create(descriptor);
    const before = resolver.append(empty, [
      record(1, {
        timestamp: "2026-08-08T00:00:01.000Z",
        type: "session_meta",
        payload: { id: "fallback", cwd: "/fallback" },
      }),
    ]);
    const after = resolver.append(before, [
      record(2, {
        timestamp: "2026-08-08T00:00:02.000Z",
        type: "session_meta",
        payload: {
          id: "matching-thread",
          cwd: "/matching",
          timestamp: "2026-08-07T23:59:00.000Z",
        },
      }),
    ]);

    expect(resolver.metadata(before)).toMatchObject({
      threadId: "fallback",
      workingDirectory: "/fallback",
      projectDirectory: "/fallback",
      createdAt: "2026-08-08T00:00:01.000Z",
      updatedAt: "2026-08-08T00:00:01.000Z",
    });
    expect(resolver.metadata(after)).toMatchObject({
      threadId: "matching-thread",
      workingDirectory: "/matching",
      projectDirectory: "/matching",
      createdAt: "2026-08-07T23:59:00.000Z",
      updatedAt: "2026-08-08T00:00:02.000Z",
    });
    expect(resolver.append(after, [])).toBe(after);
  });

  it("recombines cumulative decoder diagnostics ahead of retained normalizer diagnostics", () => {
    const normalizer = new DefaultSessionNormalizer();
    const first = normalizer.append(normalizer.create(descriptor), [record(1, {})], []);
    const before = normalizer.materialize(first, sessionMetadata());
    const decoderDiagnostics = Array.from({ length: 50 }, (_, index) => ({
      code: `decoder_${index}`,
      severity: "warning" as const,
      message: `Decoder warning ${index}`,
      ordinal: index + 1,
    }));
    const second = normalizer.append(first, [], decoderDiagnostics);
    const after = normalizer.materialize(second, sessionMetadata());

    expect(before.session.diagnostics.map(({ code }) => code)).toEqual(["unknown_record"]);
    expect(after.session.diagnostics).toEqual(decoderDiagnostics);
    expect(after.session.warningCount).toBe(50);
    expect(first.normalizerDiagnostics.map(({ code }) => code)).toEqual(["unknown_record"]);
    expect(normalizer.append(second, [], decoderDiagnostics)).toBe(second);
  });
});

function record(ordinal: number, value: Record<string, unknown>): DecodedRecord {
  return { ordinal, value };
}

it("correlates questions across append batches while ignoring ordinary tool events", () => {
  const normalizer = new DefaultSessionNormalizer();
  const first = normalizer.append(
    normalizer.create(descriptor),
    [
      record(2, {
        type: "response_item",
        payload: { type: "function_call", name: "exec", call_id: "ignored", arguments: "ls" },
      }),
      record(5, {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "question",
          arguments: JSON.stringify({
            questions: [{ id: "choice", header: "Choice", question: "Which?", options: [] }],
          }),
        },
      }),
      record(8, {
        type: "event_msg",
        payload: { type: "agent_message", message: "Progress", phase: "commentary" },
      }),
    ],
    [],
  );
  const second = normalizer.append(
    first,
    [
      record(12, {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "question",
          output: JSON.stringify({ answers: { choice: { answers: ["Selected"] } } }),
        },
      }),
    ],
    [],
  );
  expect(first.pendingUserInputRequests.size).toBe(1);
  expect(second.pendingUserInputRequests.size).toBe(0);
  expect(first.timeline.map((item) => item.ordinal)).toEqual([5, 8]);
  expect(second.timeline.map((item) => item.ordinal)).toEqual([5, 8, 12]);
  expect(second.timeline[0]).toBe(first.timeline[0]);
  expect(second.timeline[2]).toMatchObject({
    kind: "user_input",
    outcome: "answered",
    answers: [{ questionId: "choice", answers: ["Selected"] }],
  });
});

import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createClaudeSessionSource } from "../../src/server/adapters/claude/claude-session-source.js";
import {
  appendClaudeRecords,
  createClaudeState,
} from "../../src/server/adapters/claude/session-normalizer.js";
import { PaneBindingManager } from "../../src/server/interaction/pane-binding-manager.js";
import { opaqueIdForParts } from "../../src/server/security/opaque-id.js";
import { appendClaudeLines } from "../helpers/claude-normalizer.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const id = "11111111-2222-4333-8444-555555555555";
const fixture = join(import.meta.dirname, "../fixtures/claude-home");
const relative = `projects/project/${id}.jsonl`;
const lines = async () => (await readFile(join(fixture, relative), "utf8")).trimEnd().split("\n");

async function createSessionHome(prefix: string) {
  const home = await createTempDirectory(prefix);
  await mkdir(join(home, "projects/project"), { recursive: true });
  return { home, path: join(home, relative) };
}

describe("Claude JSONL adapter", () => {
  it("maps line evidence, preserves block order and hides native shell, API copies and subagents", async () => {
    const state = await appendClaudeLines(createClaudeState(id), await lines());
    expect(
      state.timeline.map((item) =>
        item.kind === "message" ? item.markdown : `${item.stage}:${item.callId}`,
      ),
    ).toEqual([
      "Hello",
      "First update",
      "Second part",
      "Before question",
      "request:ask",
      "After question",
      "response:ask",
      "## Native plan",
      "request:reject",
      "response:reject",
      "request:unknown",
      "response:unknown",
      expect.stringContaining("Quoted marker:"),
      "Main assistant body",
    ]);
    expect(state.timeline.slice(0, 4).map((item) => item.kind === "message" && item.phase)).toEqual(
      [null, "update", "response", "update"],
    );
    expect(state.timeline[6]).toMatchObject({
      outcome: "answered",
      answers: [{ questionId: "ask:0", answers: ["One", "Two"] }],
    });
    expect(state.timeline[7]).toMatchObject({ itemType: "plan", phase: "response" });
    expect(state.timeline[9]).toMatchObject({ outcome: "aborted" });
    expect(state.timeline[11]).toMatchObject({ outcome: "unavailable" });
  });

  it("produces identical immutable timelines for every incremental split", async () => {
    const input = await lines();
    const full = await appendClaudeLines(createClaudeState(id), input);
    for (let split = 0; split <= input.length; split++) {
      const before = await appendClaudeLines(createClaudeState(id), input.slice(0, split));
      const serialized = JSON.stringify(before.timeline);
      const after = await appendClaudeLines(before, input.slice(split));
      expect(after).toEqual(full);
      expect(JSON.stringify(before.timeline)).toBe(serialized);
      before.timeline.forEach((item, index) => expect(after.timeline[index]).toBe(item));
    }
    expect(full.timeline.map((item) => item.ordinal)).toEqual(
      full.timeline.map((_, index) => index),
    );
  });

  it.each([undefined, null, "max_tokens", "pause_turn", "stop_sequence", "unknown"])(
    "never infers a final phase for %s",
    async (stop_reason) => {
      const state = await appendClaudeLines(createClaudeState(id), [
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", stop_reason, content: [{ type: "text", text: "body" }] },
        }),
      ]);
      expect(state.timeline[0]).toMatchObject({ phase: null });
    },
  );

  it("selects native metadata and only accepts main-shell binding stdout", async () => {
    const bindings = new PaneBindingManager();
    const source = await createClaudeSessionSource(fixture, { home: "glm" });
    const snapshot = await source.refresh();
    for (const event of snapshot.bindings ?? [])
      bindings.submit({
        ...event,
        sessionId: opaqueIdForParts(source.descriptor.instanceKey, event.localId),
      });
    const entry = snapshot.sessions[0]!;
    expect(entry.normalized.session).toMatchObject({
      title: "Custom title",
      workingDirectory: "/test/latest-cwd",
      projectDirectory: "/test/original-project",
      taskName: "Task",
      parentId: null,
      agent: null,
    });
    expect(entry.origin).toMatchObject({
      home: "glm",
      agentName: "Claude Code",
      agentVersion: "2.1.318",
    });
    expect(
      bindings.latest(opaqueIdForParts(source.descriptor.instanceKey, entry.localId)),
    ).toMatchObject({ valid: true, paneId: "%9" });
  });

  it("commits complete lines, rereads tails, diagnoses malformed lines and rebuilds rewrites", async () => {
    const home = await createTempDirectory("claude-source-");
    await cp(fixture, home, { recursive: true });
    const path = join(home, relative);
    const input = await lines();
    await writeFile(path, input[0] + "\n" + input[1]!.slice(0, 30));
    const source = await createClaudeSessionSource(home);
    const first = await source.refresh();
    const before = JSON.stringify(first);
    expect(first.sessions[0]!.normalized.timeline).toHaveLength(1);
    await appendFile(path, input[1]!.slice(30) + "\n{bad\n" + input[2] + "\n");
    const appended = await source.refresh();
    expect(appended.sessions[0]!.normalized.timeline).toHaveLength(3);
    expect(appended.sessions[0]!.normalized.session.diagnostics).toMatchObject([
      { code: "invalid_jsonl" },
    ]);
    expect(JSON.stringify(first)).toBe(before);
    const fresh = await (await createClaudeSessionSource(home)).refresh();
    expect(JSON.stringify(appended)).toEqual(JSON.stringify(fresh));
    await writeFile(path, input[0] + "\n");
    expect((await source.refresh()).sessions[0]!.normalized.timeline).toHaveLength(1);
    await writeFile(path, input[0]!.replace("Hello", "Other") + "\n");
    expect((await source.refresh()).sessions[0]!.normalized.timeline[0]).toMatchObject({
      markdown: "Other",
    });
  });

  it("does not recursively discover subagents and rejects conflicting native identities", async () => {
    const home = await createTempDirectory("claude-identity-");
    await mkdir(join(home, "projects/project/subagents"), { recursive: true });
    await writeFile(
      join(home, "projects/project/subagents", `${id}.jsonl`),
      (await lines())[0] + "\n",
    );
    const source = await createClaudeSessionSource(home);
    expect((await source.refresh()).sessions).toEqual([]);
    await writeFile(
      join(home, relative),
      (await lines())[0]!.replace(id, "aaaaaaaa-2222-4333-8444-555555555555") + "\n",
    );
    const snapshot = await source.refresh();
    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.diagnostics).toMatchObject([{ code: "conflicting_native_session_id" }]);
  });
});

it("keeps Codex and Claude homes independently routed while merging project associations", async () => {
  const { createCodexHub } = await import("../../src/server/create-hub.js");
  const codex = await createTempDirectory("claude-mixed-codex-");
  await cp(join(import.meta.dirname, "../fixtures/codex-home"), codex, { recursive: true });
  const hub = await createCodexHub({
    homes: [
      { nickname: "codex", path: codex },
      { nickname: "glm", path: fixture, adapter: "claude" },
    ],
  });
  try {
    const snapshot = await hub.sessions.managementSnapshot();
    expect(snapshot.sessions.some((session) => session.origin.home === "codex")).toBe(true);
    const claude = snapshot.sessions.find((session) => session.origin.home === "glm")!;
    expect(claude.origin.agentName).toBe("Claude Code");
    expect(hub.managers.get("glm").isValidNativeId(claude.sourceId!)).toBe(true);
    expect(hub.managers.get("glm").archive).toBeUndefined();
    expect(hub.managers.get("codex").archive).toBeTypeOf("function");
    expect((await hub.sessions.list()).homes).toEqual([
      { nickname: "codex", management: { archive: true, delete: true } },
      { nickname: "glm", management: { archive: false, delete: false } },
    ]);
  } finally {
    hub.close();
  }
});

it("retains binding order when multiple native stdout blocks share one line", async () => {
  const { home, path } = await createSessionHome("claude-binding-order-");
  const content = ["%1", "%2"].map((pane) => ({
    type: "text",
    text: `<bash-stdout>AHUB_TMUX_BIND_V2\n/tmp/claude.sock\n${pane}\n\n/project\nnull</bash-stdout>`,
  }));
  await writeFile(
    path,
    JSON.stringify({
      type: "user",
      sessionId: id,
      timestamp: "2026-11-04T00:00:00Z",
      message: { role: "user", content },
    }) + "\n",
  );
  const bindings = new PaneBindingManager();
  const source = await createClaudeSessionSource(home);
  const snapshot = await source.refresh();
  for (const event of snapshot.bindings ?? [])
    bindings.submit({
      ...event,
      sessionId: opaqueIdForParts(source.descriptor.instanceKey, event.localId),
    });
  expect(
    bindings.latest(opaqueIdForParts(source.descriptor.instanceKey, snapshot.sessions[0]!.localId)),
  ).toMatchObject({ valid: true, paneId: "%2" });
  expect(snapshot.sessions[0]!.normalized.timeline).toEqual([]);
});

it("decodes only append bytes, skips unchanged files and caps resource usage", async () => {
  const { home, path } = await createSessionHome("claude-limits-");
  const row = (content: string) =>
    JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
  await writeFile(
    path,
    "bad\n".repeat(70) + "x".repeat(8 * 1024 * 1024 + 1) + "\n" + row("x".repeat(999999) + "😀end"),
  );
  const source = await createClaudeSessionSource(home);
  const first = await source.refresh();
  expect(first.sessions[0]!.normalized.session.diagnostics).toHaveLength(50);
  const item = first.sessions[0]!.normalized.timeline[0]!;
  expect(item).toMatchObject({ markdown: "x".repeat(999999) });
  expect(source.lastRefreshTelemetry().fullFiles).toBe(1);
  await source.refresh();
  expect(source.lastRefreshTelemetry()).toMatchObject({
    fullFiles: 0,
    appendFiles: 0,
    decodeBytes: 0,
    probeBytes: 0,
  });
  const append = row("next");
  await appendFile(path, append);
  const next = await source.refresh();
  expect(source.lastRefreshTelemetry()).toMatchObject({
    fullFiles: 0,
    appendFiles: 1,
    decodeBytes: Buffer.byteLength(append),
    probeBytes: 8192,
  });
  expect(next.sessions[0]!.normalized.timeline).toHaveLength(2);
  expect(next.signature).not.toBe(first.signature);
});

it("keeps the accepted duplicate path until it becomes invalid", async () => {
  const home = await createTempDirectory("claude-duplicates-");
  await mkdir(join(home, "projects/z"), { recursive: true });
  const z = join(home, "projects/z", `${id}.jsonl`);
  const a = join(home, "projects/a", `${id}.jsonl`);
  const row = (title: string) =>
    JSON.stringify({ type: "custom-title", customTitle: title }) + "\n";
  await writeFile(z, row("old"));
  const source = await createClaudeSessionSource(home);
  await source.refresh();
  await mkdir(join(home, "projects/a"));
  await writeFile(a, row("new"));
  expect((await source.refresh()).sessions[0]!.normalized.session.title).toBe("old");
  const fresh = await createClaudeSessionSource(home);
  expect((await fresh.refresh()).sessions[0]!.normalized.session.title).toBe("new");
  await writeFile(z, JSON.stringify({ type: "user", sessionId: "wrong" }) + "\n");
  expect((await source.refresh()).sessions[0]!.normalized.session.title).toBe("new");
  await rm(a);
  expect((await source.refresh()).sessions).toEqual([]);
});

it("uses bounded Unicode-safe explicit titles and Markdown user titles", async () => {
  const { home, path } = await createSessionHome("claude-titles-");
  const source = await createClaudeSessionSource(home);
  await writeFile(path, JSON.stringify({ type: "system", sessionId: id }) + "\n");
  expect((await source.refresh()).sessions[0]!.normalized.session.title).toBe("Untitled session");
  await writeFile(
    path,
    JSON.stringify({ type: "user", message: { role: "user", content: "intro\n\n# Heading" } }) +
      "\n",
  );
  expect((await source.refresh()).sessions[0]!.normalized.session.title).toBe("Heading");
  await appendFile(path, JSON.stringify({ type: "ai-title", aiTitle: "AI\nsecond" }) + "\n");
  expect((await source.refresh()).sessions[0]!.normalized.session.title).toBe("AI");
  await appendFile(
    path,
    JSON.stringify({ type: "custom-title", customTitle: "x".repeat(79) + "😀tail\nsecond" }) + "\n",
  );
  expect((await source.refresh()).sessions[0]!.normalized.session.title).toBe("x".repeat(79));
});

it("treats a missing projects root as empty without warnings", async () => {
  const home = await createTempDirectory("claude-empty-");
  expect(await (await createClaudeSessionSource(home)).refresh()).toMatchObject({
    sessions: [],
    diagnostics: [],
  });
});

it("caps scan diagnostics but continues accepting valid candidates", async () => {
  const home = await createTempDirectory("claude-scan-limit-");
  for (let index = 0; index < 55; index++) {
    const directory = join(home, "projects", String(index).padStart(2, "0"));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${id}.jsonl`),
      JSON.stringify({ type: "user", sessionId: "wrong" }) + "\n",
    );
  }
  await mkdir(join(home, "projects/z"));
  await writeFile(join(home, "projects/z", `${id}.jsonl`), (await lines())[0] + "\n");
  const snapshot = await (await createClaudeSessionSource(home)).refresh();
  expect(snapshot.diagnostics).toHaveLength(50);
  expect(snapshot.sessions).toHaveLength(1);
});

it("prioritizes decoder diagnostics without hiding identity conflicts across batches", () => {
  const records = [{ ordinal: 2, value: { type: "user", sessionId: "wrong" } }];
  const diagnostics = Array.from({ length: 50 }, (_, index) => ({
    code: "invalid_jsonl",
    severity: "warning" as const,
    message: "bad",
    ordinal: index + 3,
  }));
  const full = appendClaudeRecords(createClaudeState(id), records, diagnostics);
  const first = appendClaudeRecords(createClaudeState(id), records);
  const incremental = appendClaudeRecords(first, [], diagnostics);
  expect(incremental).toEqual(full);
  expect(full.diagnostics).toHaveLength(50);
  expect(full.diagnostics[0]).toMatchObject({ code: "invalid_jsonl", ordinal: 3 });
  expect(full.identityConflict).toBe(true);
  expect(full.normalizerDiagnostics[0]).toMatchObject({
    code: "conflicting_native_session_id",
    ordinal: 2,
  });
});

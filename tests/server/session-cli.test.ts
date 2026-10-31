import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

import { CommandError } from "../../src/server/cli/command-error.js";
import { parseSessionArguments } from "../../src/server/cli/session.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
});
async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    handler(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function cli(args: string[], stdin = "", env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/server/cli/main.ts", "session", ...args],
      { env: { ...process.env, CODEX_HUB_URL: "http://127.0.0.1:1", ...env } },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}
const reply = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};

it.each([
  ["unknown"],
  ["list", "--unknown"],
  ["inspect", "id", "--after", "-1"],
  ["list", "extra"],
  ["list", "--url", "bad-url"],
  ["send", "id", "--message", "  "],
  ["send", "id"],
  ["send", "id", "--stdin", "--message", "x"],
  ["keys", "id", "interrupt"],
  ["keys", "id", "C-c"],
  ["resume", "id", "--home", "other"],
  ["inspect", "id", "--limit", "301"],
  ["list", "--url", "https://example.com"],
  ["list", "--timeout", "0"],
])("rejects invalid session arguments: %j", (...args) => {
  expect(() => parseSessionArguments(args)).toThrow(CommandError);
  expect(() => parseSessionArguments(args)).toThrow(
    expect.objectContaining({ code: "invalid_arguments" }),
  );
});

it.each([true, false])("wires invalid arguments without requests (json=%s)", async (json) => {
  let requests = 0;
  const base = await serve((_req, res) => {
    requests++;
    res.end();
  });
  const result = await cli(["list", "extra", ...(json ? ["--json"] : [])], "", {
    CODEX_HUB_URL: base,
  });
  expect(result.code).toBe(1);
  expect(requests).toBe(0);
  if (json) {
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).error.code).toBe("invalid_arguments");
  } else {
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid session command arguments");
  }
});
it("parses valid session options and help without I/O", () => {
  const parsed = parseSessionArguments(
    ["inspect", "opaque-native-id", "--limit", "300", "--after", "0"],
    "http://localhost:4173",
  );
  expect(parsed).toMatchObject({
    help: false,
    command: "inspect",
    id: "opaque-native-id",
    seconds: 15,
    values: { limit: "300", after: "0" },
  });
  expect(parsed.help ? undefined : parsed.base.origin).toBe("http://localhost:4173");
  expect(parseSessionArguments(["--help", "unknown"]).help).toBe(true);
});

it("uses explicit URL over the environment and filters by associated project", async () => {
  const base = await serve((req, res) => {
    expect(req.url).toBe("/api/v1/sessions");
    reply(res, {
      homes: [],
      revision: "private",
      projects: [{ directory: "/project" }],
      sessions: [
        {
          id: "yes",
          projectDirectory: "/project",
          title: "Title",
          status: "normal",
          home: "work",
          updatedAt: null,
        },
        { id: "child", projectDirectory: "/project", isChild: true, parentId: "yes" },
        { id: "orphan", projectDirectory: "/project", isChild: true, parentId: null },
        { id: "no", projectDirectory: "/other-project" },
      ],
    });
  });
  const result = await cli(["list", "--project", "/project", "--url", base, "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).sessions).toEqual([
    {
      id: "yes",
      title: "Title",
      status: "normal",
      home: "work",
      projectDirectory: "/project",
      updatedAt: null,
    },
  ]);
  expect((await cli(["list", "--json"], "", { CODEX_HUB_URL: base })).code).toBe(0);
});

it("sends stdin and keys with idle requirements, but interrupt and handoff without them", async () => {
  const seen: { url: string; body: unknown }[] = [];
  const base = await serve((req, res, body) => {
    seen.push({ url: req.url!, body });
    res.writeHead(204);
    res.end();
  });
  for (const args of [
    ["send", "id", "--stdin"],
    ["keys", "id", "up", "enter"],
    ["interrupt", "id"],
    ["handoff", "id"],
  ]) {
    expect((await cli([...args, "--url", base, "--json"], "hello\n")).code).toBe(0);
  }
  expect(seen).toEqual([
    { url: "/api/v1/sessions/id/messages", body: { message: "hello\n", requireIdle: true } },
    { url: "/api/v1/sessions/id/keys", body: { keys: ["up", "enter"], requireIdle: true } },
    { url: "/api/v1/sessions/id/keys", body: { keys: ["interrupt"] } },
    { url: "/api/v1/sessions/id/handoff-pane-binding", body: {} },
  ]);
});

it("waits for lifecycle completion and launch idle, mapping only public results", async () => {
  let submits = 0,
    inspections = 0;
  const base = await serve((req, res, body) => {
    if (req.method === "POST") {
      submits++;
      expect(body).toMatchObject({
        projectDirectory: "/project",
        workingDirectory: resolve("relative-working"),
        home: "second",
        worktree: true,
        yolo: true,
      });
      expect(body.requestId).toBeTruthy();
      reply(
        res,
        {
          operationId: "secret-operation",
          target: { socketPath: "/tmp/socket", paneId: "%7", sessionName: "ahub-test" },
          status: "pending",
        },
        202,
      );
    } else if (req.url === "/api/v1/operations/secret-operation")
      reply(res, {
        status: "succeeded",
        sessionId: "session",
        operationId: "secret-operation",
        attachCommand: "secret-command",
      });
    else {
      inspections++;
      reply(res, {
        session: { id: "session" },
        live: true,
        interaction: {
          supported: true,
          state: "connected",
          activity: inspections > 1 ? "idle" : "working",
        },
      });
    }
  });
  const result = await cli([
    "create",
    "--project",
    "/project",
    "--cwd",
    "relative-working",
    "--home",
    "second",
    "--worktree",
    "--yolo",
    "--url",
    base,
    "--json",
  ]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    sessionId: "session",
    status: "succeeded",
    tmux: { socketPath: "/tmp/socket", paneId: "%7", sessionName: "ahub-test" },
  });
  expect(result.stdout + result.stderr).not.toContain("secret");
  expect(submits).toBe(1);
  expect(inspections).toBe(2);
});

it("distinguishes failures from unknown writes and never retries or cancels", async () => {
  let writes = 0;
  const base = await serve((req, _res) => {
    if (req.method === "POST") {
      writes++;
      req.socket.destroy();
    } else req.socket.destroy();
  });
  expect((await cli(["inspect", "id", "--url", base, "--json"])).code).toBe(1);
  const result = await cli(["send", "id", "--message", "hello", "--url", base, "--json"]);
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout).error.code).toBe("operation_result_unknown");
  expect(writes).toBe(1);
  const failed = await serve((_req, res) =>
    reply(res, { status: "failed", error: "secret-operation", operationId: "secret" }, 202),
  );
  const failure = await cli(["exit", "id", "--url", failed, "--json"]);
  expect(failure.code).toBe(1);
  expect(JSON.parse(failure.stdout).error.message).toBe("secret-operation");
  expect(JSON.parse(failure.stdout).error.operationId).toBeUndefined();
});

it("treats backend unknown results as query failures unless a mutation was submitted", async () => {
  const base = await serve((_req, res) =>
    reply(
      res,
      { error: { code: "operation_result_unknown", message: "The tmux operation timed out" } },
      504,
    ),
  );
  for (const command of ["terminal", "inspect"]) {
    const result = await cli([command, "id", "--url", base, "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      error: { code: "request_failed", message: "The tmux operation timed out" },
    });
  }
  const mutation = await cli(["interrupt", "id", "--url", base, "--json"]);
  expect(mutation.code).toBe(2);
  expect(JSON.parse(mutation.stdout).error.code).toBe("operation_result_unknown");

  const polling = await serve((req, res) => {
    if (req.method === "POST") reply(res, { operationId: "pending", status: "pending" }, 202);
    else
      reply(
        res,
        { error: { code: "operation_result_unknown", message: "Operation lookup timed out" } },
        504,
      );
  });
  const submitted = await cli(["archive", "id", "--url", polling, "--json"]);
  expect(submitted.code).toBe(2);
  expect(JSON.parse(submitted.stdout).error.code).toBe("operation_result_unknown");
});

it("applies one deadline to polling without resubmitting the mutation", async () => {
  const seen: string[] = [];
  const base = await serve((req, res) => {
    seen.push(req.method!);
    reply(res, { operationId: "secret", status: "pending" }, req.method === "POST" ? 202 : 200);
  });
  const result = await cli(["archive", "id", "--url", base, "--timeout", "0.7", "--json"]);
  expect(result.code).toBe(2);
  expect(seen.filter((method) => method !== "GET")).toEqual(["POST"]);
  expect(seen).toContain("GET");
});

it("renders human output and sends human diagnostics to stderr", async () => {
  const base = await serve((req, res) => {
    if (req.url?.endsWith("/terminal"))
      reply(res, {
        content: "current screen",
        capturedAt: "2026-10-29T00:00:00Z",
        truncated: true,
      });
    else
      reply(res, {
        homes: [{ nickname: "work" }],
        projects: [{ directory: "/project" }],
        sessions: [
          { id: "id", status: "live", home: "work", projectDirectory: "/project", title: "Title" },
        ],
      });
  });
  const list = await cli(["list", "--url", base]);
  expect(list.code).toBe(0);
  expect(list.stdout).toContain("id\tlive\twork\t/project\tTitle");
  expect((await cli(["terminal", "id", "--url", base])).stdout).toContain(
    "(truncated)\ncurrent screen",
  );
  const failure = await cli(["keys", "id", "unsupported"]);
  expect(failure.code).toBe(1);
  expect(failure.stdout).toBe("");
  expect(failure.stderr).toContain("Unsupported key");
});

it("uses child IDs directly for queries, input and lifecycle operations without catalog requests", async () => {
  const seen: string[] = [];
  const base = await serve((req, res, body) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url?.includes("/inspect"))
      reply(res, {
        session: {
          id: "child",
          parentId: "parent",
          childIds: [],
          title: "Child",
          status: "normal",
          origin: { sourceType: "codex", agentName: "Codex", home: "work" },
          resume: { allowed: true, reason: null },
          workingDirectory: null,
          projectDirectory: null,
          createdAt: null,
          updatedAt: null,
        },
        live: true,
        interaction: {
          supported: true,
          state: "connected",
          activity: "idle",
          supersededBySessionId: null,
          attachCommand: "private",
        },
        items: [],
        nextAfter: 0,
        hasMore: false,
      });
    else if (req.url?.endsWith("/terminal"))
      reply(res, { content: "screen", truncated: false, capturedAt: "now", private: "private" });
    else if (req.url === "/api/v1/sessions") {
      expect(body.resumeSessionId).toBe("child");
      reply(res, { status: "succeeded", sessionId: "child" });
    } else reply(res, { status: "succeeded", sessionId: "child" });
  });
  for (const args of [
    ["inspect", "child"],
    ["terminal", "child"],
    ["send", "child", "--message", "hello"],
    ["keys", "child", "enter"],
    ["interrupt", "child"],
    ["handoff", "child"],
    ["exit", "child"],
    ["archive", "child"],
    ["delete", "child"],
    ["resume", "child"],
  ]) {
    const result = await cli([...args, "--url", base, "--json"]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("private");
    expect(result.stdout).not.toContain("parent");
  }
  expect(seen).toEqual([
    "GET /api/v1/sessions/child/inspect",
    "GET /api/v1/sessions/child/terminal",
    "POST /api/v1/sessions/child/messages",
    "POST /api/v1/sessions/child/keys",
    "POST /api/v1/sessions/child/keys",
    "POST /api/v1/sessions/child/handoff-pane-binding",
    "POST /api/v1/sessions/child/exit",
    "POST /api/v1/sessions/child/archive",
    "DELETE /api/v1/sessions/child",
    "POST /api/v1/sessions",
    "GET /api/v1/sessions/child/inspect?limit=1",
  ]);
});

it("keeps connection failures classified as query_failed", async () => {
  const result = await cli(["list", "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("query_failed");
});

it.each([
  "list",
  "inspect",
  "terminal",
  "send",
  "keys",
  "interrupt",
  "handoff",
  "create",
  "resume",
  "exit",
  "archive",
  "delete",
])("sets the timeout tier for %s", (command) => {
  const extra = command === "create" ? ["--project", "/project"] : command === "list" ? [] : ["id"];
  if (command === "send") extra.push("--message", "hello");
  if (command === "keys") extra.push("enter");
  expect(parseSessionArguments([command, ...extra])).toMatchObject({
    seconds: ["create", "resume", "exit", "archive", "delete"].includes(command) ? 45 : 15,
  });
  expect(parseSessionArguments([command, ...extra, "--timeout", "2"])).toMatchObject({
    seconds: 2,
  });
});

it.each([
  ["--interval", "1"],
  ["--count", "2"],
  ["--follow", "--interval", "Infinity"],
  ["--follow", "--interval", "0"],
  ["--follow", "--count", "1.5"],
  ["--follow", "--count", "0"],
])("rejects invalid follow options %j", (...options) => {
  expect(() => parseSessionArguments(["inspect", "id", ...options])).toThrow();
});

it("drains the last follow round and suppresses position-only updates", async () => {
  const paths: string[] = [];
  const base = await serve((req, res) => {
    paths.push(req.url!);
    const page = paths.length;
    reply(res, {
      session: { id: "id", origin: {}, resume: {} },
      interaction: { supported: false },
      items: [],
      nextAfter: page,
      hasMore: page === 2,
    });
  });
  const result = await cli([
    "inspect",
    "id",
    "--follow",
    "--count",
    "2",
    "--interval",
    "0.01",
    "--url",
    base,
    "--json",
  ]);
  expect(result.code).toBe(0);
  expect(paths).toHaveLength(3);
  expect(paths[1]).toContain("after=1");
  expect(paths[2]).toContain("after=2");
  expect(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toHaveLength(1);
});

it("retains launch target on timeout without retry or cancellation", async () => {
  let writes = 0;
  const base = await serve((req, res) => {
    if (req.method === "POST") writes++;
    reply(res, {
      operationId: "private",
      status: "pending",
      target: { socketPath: "/tmp/socket", paneId: "%7", sessionName: "ahub-test" },
    });
  });
  const result = await cli([
    "create",
    "--project",
    "/project",
    "--timeout",
    "0.1",
    "--json",
    "--url",
    base,
  ]);
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout).error).toMatchObject({
    sessionId: null,
    tmux: { socketPath: "/tmp/socket", paneId: "%7", sessionName: "ahub-test" },
  });
  expect(result.stdout).not.toContain("private");
  expect(writes).toBe(1);
});

it("keeps launch diagnostics when readiness never reaches idle", async () => {
  let writes = 0;
  const base = await serve((req, res) => {
    if (req.method === "POST") {
      writes++;
      reply(res, {
        status: "succeeded",
        sessionId: "id",
        target: { socketPath: "/tmp/socket", paneId: "%7", sessionName: "ahub-test" },
        operationId: "private",
      });
    } else
      reply(res, {
        live: true,
        interaction: { supported: true, state: "connected", activity: "working" },
      });
  });
  const result = await cli(["resume", "id", "--timeout", "0.1", "--json", "--url", base]);
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout).error).toMatchObject({
    sessionId: "id",
    tmux: { socketPath: "/tmp/socket", paneId: "%7", sessionName: "ahub-test" },
  });
  expect(writes).toBe(1);
});

it("stops follow normally on SIGINT without mutating the session", async () => {
  const methods: string[] = [];
  let read!: () => void;
  const received = new Promise<void>((resolve) => {
    read = resolve;
  });
  const base = await serve((req, _res) => {
    methods.push(req.method!);
    read();
  });
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/server/cli/main.ts",
    "session",
    "inspect",
    "id",
    "--follow",
    "--url",
    base,
    "--json",
  ]);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const stopped = new Promise<number | null>((resolve) => child.on("close", resolve));
  await received;
  child.kill("SIGINT");
  expect(await stopped).toBe(0);
  expect(methods).toEqual(["GET"]);
  expect(stdout + stderr).toBe("");
});

it("prints a follow error as a separate NDJSON line without retry", async () => {
  let reads = 0;
  const base = await serve((_req, res) => {
    reads++;
    if (reads === 1)
      reply(res, {
        session: { id: "id", origin: {}, resume: {} },
        interaction: { supported: false },
        items: [],
        nextAfter: 0,
        hasMore: false,
      });
    else reply(res, { error: { message: "Backend unavailable" } }, 503);
  });
  const result = await cli([
    "inspect",
    "id",
    "--follow",
    "--interval",
    "0.01",
    "--url",
    base,
    "--json",
  ]);
  expect(result.code).toBe(1);
  const lines = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines).toHaveLength(2);
  expect(lines[1].error.message).toBe("Backend unavailable");
  expect(reads).toBe(2);
});

it.each([true, false])("follows input hints, answers and idle changes (json=%s)", async (json) => {
  let reads = 0;
  const paths: string[] = [];
  const inputEvents = [
    {
      kind: "user_input",
      stage: "request",
      callId: "private-call",
      questions: [
        {
          id: "private-question",
          header: "Implementation",
          question: "Which approach?",
          options: [{ label: "Minimal", description: "Fix the current issue" }],
        },
      ],
    },
    {
      kind: "user_input",
      stage: "response",
      callId: "private-call",
      outcome: "answered",
      answers: [{ questionId: "private-question", answers: ["Selected"] }],
    },
  ];
  const base = await serve((req, res) => {
    paths.push(req.url!);
    const page = ++reads;
    const record = { id: `record-${page}`, ordinal: page, timestamp: null };
    const event = inputEvents[page - 1];
    reply(res, {
      session: { id: "id", origin: {}, resume: {} },
      interaction: {
        supported: true,
        state: "connected",
        activity: page === 1 ? "working" : "idle",
      },
      items: event ? [{ ...record, ...event }] : [],
      nextAfter: page,
      hasMore: page === 1,
    });
  });
  const result = await cli([
    "inspect",
    "id",
    "--follow",
    "--count",
    "2",
    "--interval",
    "0.01",
    "--url",
    base,
    ...(json ? ["--json"] : []),
  ]);
  expect(result.code).toBe(0);
  expect(paths).toHaveLength(3);
  expect(paths[1]).toContain("after=1");
  expect(paths[2]).toContain("after=2");
  expect(result.stdout).toContain("session terminal id");
  expect(result.stdout).toContain("Selected");
  expect(result.stdout).toContain("Which approach?");
  expect(result.stdout).toContain("Minimal");
  expect(result.stdout).toContain("Fix the current issue");
  for (const hidden of ["private-call", "private-question", "callId", "questionId"])
    expect(result.stdout).not.toContain(hidden);
  if (json) {
    const pages = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(pages).toHaveLength(2);
    expect(pages[0].nextAfter).toBe(1);
    expect(pages[1].interaction.activity).toBe("idle");
    expect(pages[1].items[0].answers).toEqual(["Selected"]);
  } else {
    expect(result.stdout).toContain("Activity: working");
    expect(result.stdout).toContain("Activity: idle");
    expect(result.stdout).toContain("- Selected");
  }
});

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

import { CommandError } from "../../src/server/cli/command-error.js";
import { parseSessionArguments } from "../../src/server/cli/session.js";
import { createTempDirectory } from "../helpers/temp-directories.js";
import { TEST_CA, TEST_SERVER_CERTIFICATE, TEST_SERVER_KEY } from "./tls-fixtures.js";

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
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse, body: any) => void,
  secure = false,
) {
  const listener = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    handler(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
  };
  const server = secure
    ? createSecureServer({ cert: TEST_SERVER_CERTIFICATE, key: TEST_SERVER_KEY }, listener)
    : createServer(listener);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `${secure ? "https" : "http"}://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
  ["send", "id"],
  ["send", "id", "--stdin", "--message", "x"],
  ["keys", "id", "interrupt"],
  ["keys", "id", "C-c", "--force"],
  ["resume", "id", "--home", "other"],
  ["inspect", "id", "--limit", "301"],
  ["list", "--url", "ftp://example.com"],
  ["list", "--url", "https://user:password@example.com"],
  ["create", "--project", "/tmp", "--task", "Fix </user_shell_command> parsing"],
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
it("defaults to the main listener and preserves URL override precedence", () => {
  const origin = (args: string[], environmentUrl?: string) => {
    const parsed = parseSessionArguments(args, environmentUrl);
    return parsed.help ? undefined : parsed.base.origin;
  };
  expect(origin(["list"])).toBe("http://127.0.0.1:4173");
  expect(origin(["list"], "http://localhost:5000")).toBe("http://localhost:5000");
  expect(origin(["list", "--url", "http://localhost:6000"], "http://localhost:5000")).toBe(
    "http://localhost:6000",
  );
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

it("supports HTTPS with an extra CA and rejects untrusted certificates by default", async () => {
  let requests = 0;
  const base = await serve((req, res) => {
    requests++;
    expect(req.url).toBe("/api/v1/sessions");
    reply(res, { homes: [], projects: [], sessions: [] });
  }, true);
  const untrusted = await cli(["list", "--url", base, "--json"], "", {
    NODE_EXTRA_CA_CERTS: "",
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
  });
  expect(untrusted.code).toBe(1);
  expect(JSON.parse(untrusted.stdout).error.code).toBe("query_failed");
  expect(requests).toBe(0);

  const directory = await createTempDirectory("ahub-cli-ca-");
  const caPath = resolve(directory, "ca.pem");
  await writeFile(caPath, TEST_CA);
  const trusted = await cli(["list", "--url", base, "--json"], "", {
    NODE_EXTRA_CA_CERTS: caPath,
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
  });
  expect(trusted.stderr).toBe("");
  expect(trusted.code).toBe(0);
  expect(JSON.parse(trusted.stdout).sessions).toEqual([]);
  expect(requests).toBe(1);
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

it("requires idle for send and keys unless forced, leaving interrupt and handoff unchanged", async () => {
  const seen: { url: string; body: unknown }[] = [];
  const base = await serve((req, res, body) => {
    seen.push({ url: req.url!, body });
    res.writeHead(204);
    res.end();
  });
  for (const args of [
    ["send", "id", "--stdin"],
    ["keys", "id", "up", "enter"],
    ["send", "id", "--stdin", "--force"],
    ["send", "id", "--message", "forced", "--force"],
    ["keys", "id", "up", "enter", "--force"],
    ["interrupt", "id"],
    ["handoff", "id"],
  ]) {
    expect((await cli([...args, "--url", base, "--json"], "hello\n")).code).toBe(0);
  }
  expect(seen).toEqual([
    { url: "/api/v1/sessions/id/messages", body: { message: "hello\n", requireIdle: true } },
    { url: "/api/v1/sessions/id/keys", body: { keys: ["up", "enter"], requireIdle: true } },
    { url: "/api/v1/sessions/id/messages", body: { message: "hello\n", requireIdle: false } },
    { url: "/api/v1/sessions/id/messages", body: { message: "forced", requireIdle: false } },
    { url: "/api/v1/sessions/id/keys", body: { keys: ["up", "enter"], requireIdle: false } },
    { url: "/api/v1/sessions/id/keys", body: { keys: ["interrupt"] } },
    { url: "/api/v1/sessions/id/handoff-pane-binding", body: {} },
  ]);
});

it.each(["--message", "--stdin"])("guards only the start of send input via %s", async (source) => {
  const seen: unknown[] = [];
  const base = await serve((_req, res, body) => {
    seen.push(body);
    res.writeHead(204);
    res.end();
  });
  const send = (message: string, force = false) =>
    cli(
      [
        "send",
        "id",
        source,
        ...(source === "--message" ? [message] : []),
        ...(force ? ["--force"] : []),
        "--url",
        base,
        "--json",
      ],
      source === "--stdin" ? message : "",
    );
  const commands = ["/help", "/help\ntext"];
  for (const message of commands) {
    const result = await send(message);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "invalid_arguments", message: expect.stringContaining("--force") },
    });
  }
  expect(seen).toEqual([]);
  const allowed = [
    "$skill",
    "$skill\ntext",
    "text\n/help\n$skill",
    " /help",
    "\n/help",
    "\n$skill",
    "text / $",
  ];
  for (const message of allowed) expect((await send(message)).code).toBe(0);
  for (const message of commands) expect((await send(message, true)).code).toBe(0);
  expect(seen).toEqual([
    ...allowed.map((message) => ({ message, requireIdle: true })),
    ...commands.map((message) => ({ message, requireIdle: false })),
  ]);
});

it("sends 256 KiB through stdin and rejects larger messages before submission", async () => {
  const seen: unknown[] = [];
  const base = await serve((_req, res, body) => {
    seen.push(body);
    res.writeHead(204);
    res.end();
  });
  const message = "a".repeat(256 * 1024);
  const args = ["send", "id", "--stdin", "--url", base, "--json"];
  expect((await cli(args, message)).code).toBe(0);
  expect(seen).toEqual([{ message, requireIdle: true }]);
  expect((await cli(args, message + "a")).code).toBe(1);
  const oversized = await cli(args, "a".repeat(512 * 1024 + 1));
  expect(oversized.code).toBe(1);
  expect(oversized.stdout).toContain("Message exceeds 256 KiB");
  expect(seen).toHaveLength(1);
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

it("wires backend query errors to the JSON result and exit status", async () => {
  const base = await serve((_req, res) =>
    reply(
      res,
      { error: { code: "operation_result_unknown", message: "The tmux operation timed out" } },
      504,
    ),
  );
  const result = await cli(["terminal", "id", "--url", base, "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({
    error: { code: "request_failed", message: "The tmux operation timed out" },
  });
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
  expect(list.stdout).toContain("id  live    work  /project        Title");
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
    if (req.url?.includes("/messages"))
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
    "GET /api/v1/sessions/child/messages",
    "GET /api/v1/sessions/child/terminal",
    "POST /api/v1/sessions/child/messages",
    "POST /api/v1/sessions/child/keys",
    "POST /api/v1/sessions/child/keys",
    "POST /api/v1/sessions/child/handoff-pane-binding",
    "POST /api/v1/sessions/child/exit",
    "POST /api/v1/sessions/child/archive",
    "DELETE /api/v1/sessions/child",
    "POST /api/v1/sessions",
    "GET /api/v1/sessions/child/messages?limit=1",
  ]);
});

it("keeps connection failures classified as query_failed", async () => {
  const result = await cli(["list", "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("query_failed");
});

it.each(["list", "create"])("sets the timeout tier for %s", (command) => {
  const extra = command === "create" ? ["--project", "/project"] : [];
  expect(parseSessionArguments([command, ...extra])).toMatchObject({
    seconds: command === "create" ? 45 : 15,
  });
  expect(parseSessionArguments([command, ...extra, "--timeout", "2"])).toMatchObject({
    seconds: 2,
  });
  expect(() => parseSessionArguments([command, ...extra, "--timeout", "0"])).toThrow(
    "timeout must be a positive number",
  );
});

it.each([
  ["--interval", "1"],
  ["--follow", "--interval", "0"],
  ["--follow", "--count", "1.5"],
])("rejects invalid follow options %j", (...options) => {
  expect(() => parseSessionArguments(["inspect", "id", ...options])).toThrow();
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
  expect(paths).toEqual([
    "/api/v1/sessions/id/messages",
    "/api/v1/sessions/id/messages?after=1",
    "/api/v1/sessions/id/messages?after=2",
  ]);
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

it.each([false, true])("filters archived sessions with all=%s", async (include) => {
  const base = await serve((_req, res) => {
    reply(res, {
      homes: [],
      projects: [],
      sessions: [
        { id: "normal", status: "normal", projectDirectory: "/project" },
        { id: "live", status: "live", projectDirectory: "/project" },
        { id: "archived", status: "archived", projectDirectory: "/project" },
        { id: "child", status: "archived", isChild: true, projectDirectory: "/project" },
        { id: "other", status: "archived", projectDirectory: "/other" },
      ].map((session) => ({ title: session.id, home: "default", updatedAt: null, ...session })),
    });
  });
  const args = ["list", "--url", base, "--project", "/project", ...(include ? ["--all"] : [])];
  const json = await cli([...args, "--json"]);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.stdout).sessions.map((s: { id: string }) => s.id)).toEqual(
    include ? ["normal", "live", "archived"] : ["normal", "live"],
  );
  const text = await cli(args);
  expect(text.code).toBe(0);
  expect(text.stdout.includes("archived")).toBe(include);
});

it("rejects all outside list", () => {
  expect(() => parseSessionArguments(["inspect", "id", "--all"])).toThrow();
});

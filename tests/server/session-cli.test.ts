import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, expect, it } from "vitest";

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
  ["send", "id"],
  ["send", "id", "--stdin", "--message", "x"],
  ["keys", "id", "interrupt"],
  ["keys", "id", "C-c"],
  ["resume", "id", "--home", "other"],
  ["inspect", "id", "--limit", "301"],
  ["list", "--url", "https://example.com"],
  ["list", "--timeout", "0"],
])("rejects invalid arguments before submission: %j", async (...args) => {
  const result = await cli([...args, "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toBeDefined();
});

it("uses explicit URL over the environment and filters by associated project", async () => {
  const base = await serve((req, res) => {
    expect(req.url).toBe("/api/v1/sessions");
    reply(res, {
      homes: [],
      revision: "private",
      projects: [{ id: "p", directory: "/project" }],
      sessions: [
        { id: "yes", projectId: "p" },
        { id: "no", projectId: "q" },
      ],
    });
  });
  const result = await cli(["list", "--project", "/project", "--url", base, "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).sessions).toEqual([{ id: "yes", projectId: "p" }]);
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
        directory: "/project",
        home: "second",
        worktree: true,
        yolo: true,
      });
      expect(body.requestId).toBeTruthy();
      reply(
        res,
        { operationId: "secret-operation", target: { paneId: "%secret" }, status: "pending" },
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
    "--home",
    "second",
    "--worktree",
    "--yolo",
    "--url",
    base,
    "--json",
  ]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ sessionId: "session", status: "succeeded" });
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
  expect(failure.stdout).not.toContain("secret");
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
        homes: [{ sourceInstanceId: "h", nickname: "work" }],
        projects: [{ id: "p", directory: "/project" }],
        sessions: [
          { id: "id", status: "live", sourceInstanceId: "h", projectId: "p", title: "Title" },
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

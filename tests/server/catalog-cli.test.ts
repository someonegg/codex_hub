import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, expect, it } from "vitest";

import { parseCatalogArguments } from "../../src/server/cli/catalog.js";
import { CommandError } from "../../src/server/cli/command-error.js";

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
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function cli(args: string[], url = "http://127.0.0.1:1") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server/cli/main.ts", ...args], {
      env: { ...process.env, AGENT_HUB_URL: url },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end();
  });
}
const projects = [{ directory: "/a/project" }, { directory: "/z/project" }];
const agents = [
  { nickname: "alpha", runtimeName: "claude", management: { archive: false } },
  { nickname: "alpha", runtimeName: "codex", management: { archive: true } },
  { nickname: "beta", runtimeName: "codex" },
];

it.each(["project", "agent"])(
  "lists %s as sorted text and JSON through the existing API",
  async (kind) => {
    const requests: string[] = [];
    const url = await serve((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          projects: [projects[1], projects[0], projects[1]],
          agents: [...agents].reverse(),
          sessions: [],
          revision: "1",
        }),
      );
    });
    const text = await cli([kind, "list", "--url", url]);
    expect(text.code).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toBe(
      kind === "project"
        ? "DIRECTORY\n/a/project\n/z/project\n"
        : "NICKNAME  RUNTIME  ARCHIVE\nalpha     claude   false\nalpha     codex    true\nbeta      codex    -\n",
    );
    const json = await cli([kind, "list", "--json"], url);
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual(kind === "project" ? projects : agents);
    expect(requests).toEqual(["GET /api/v1/sessions", "GET /api/v1/sessions"]);
  },
);

it.each(["project", "agent"])("handles help, empty lists and errors for %s", async (kind) => {
  for (const args of [[], ["--help"], ["list", "--help"]]) {
    const result = await cli([kind, ...args]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Usage: ahub-cli ${kind} list`);
  }
  const url = await serve((_req, res) => res.end(JSON.stringify({ projects: [], agents: [] })));
  expect(JSON.parse((await cli([kind, "list", "--json"], url)).stdout)).toEqual([]);
  const invalid = await cli([kind, "list", "--project", "/tmp", "--json"]);
  expect(invalid.code).toBe(1);
  expect(JSON.parse(invalid.stdout).error.code).toBe("invalid_arguments");
  const offline = await cli([kind, "list"]);
  expect(offline.code).toBe(1);
  expect(offline.stderr).toContain("Query failed:");
  const offlineJson = await cli([kind, "list", "--json"]);
  expect(offlineJson.code).toBe(1);
  expect(JSON.parse(offlineJson.stdout).error.code).toBe("query_failed");
  const failureUrl = await serve((_req, res) => {
    res.writeHead(503);
    res.end(JSON.stringify({ error: { message: "Hub unavailable" } }));
  });
  const failure = await cli([kind, "list", "--json"], failureUrl);
  expect(failure.code).toBe(1);
  expect(JSON.parse(failure.stdout).error).toEqual({
    code: "request_failed",
    message: "Hub unavailable",
  });
  const stalledUrl = await serve(() => {});
  const timeout = await cli([kind, "list", "--timeout", "0.05", "--json"], stalledUrl);
  expect(timeout.code).toBe(1);
  expect(JSON.parse(timeout.stdout).error.code).toBe("query_failed");
});

it.each([
  ["create"],
  ["list", "extra"],
  ["list", "--unknown"],
  ["list", "--url"],
  ["list", "--timeout", "0"],
  ["list", "--timeout", "NaN"],
  ["list", "--timeout", "2147484"],
  ["list", "--url", "bad-url"],
  ["list", "--url", "ftp://example.com"],
  ["list", "--url", "http://example.com/path"],
  ["list", "--url", "http://user:password@example.com"],
  ["list", "--url", "http://example.com/?query"],
  ["list", "--url", "http://example.com/#hash"],
])("rejects invalid catalog arguments: %j", (...args) => {
  expect(() => parseCatalogArguments(args)).toThrow(CommandError);
  expect(() => parseCatalogArguments(args)).toThrow(
    expect.objectContaining({ code: "invalid_arguments" }),
  );
});

it("uses the same URL precedence and default timeout as session list", () => {
  const defaults = parseCatalogArguments(["list"]);
  expect(defaults).toMatchObject({ seconds: 15, help: false });
  expect(defaults.help ? undefined : defaults.base.origin).toBe("http://127.0.0.1:4173");
  const environment = parseCatalogArguments(["list"], "https://example.com");
  expect(environment.help ? undefined : environment.base.origin).toBe("https://example.com");
  const override = parseCatalogArguments(
    ["list", "--url", "http://localhost:5000", "--timeout", "2"],
    "https://example.com",
  );
  expect(override).toMatchObject({ seconds: 2 });
  expect(override.help ? undefined : override.base.origin).toBe("http://localhost:5000");
});

it("advertises both commands in top-level help", async () => {
  const result = await cli(["--help"]);
  expect(result.stdout).toContain("project   List known project directories");
  expect(result.stdout).toContain("agent     List known agents");
});

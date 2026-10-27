import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, expect, it, vi } from "vitest";

// Exercise the shipped entry point, including its client asset resolution.
beforeAll(() => {
  execFileSync("npm", ["run", "build"], { stdio: "pipe" });
}, 30000);

const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function home() {
  const directory = await mkdtemp(join(tmpdir(), "hub-upload-lock-"));
  directories.push(directory);
  return directory;
}
function launch(directory: string, extra: string[] = [], preload?: string) {
  const child = spawn(
    process.execPath,
    [
      ...(preload ? ["--import", preload] : []),
      "dist/server/server/main.js",
      "--home-dir",
      directory,
      "--codex-home",
      `test=${join(directory, "codex")}`,
      "--port",
      "0",
      ...extra,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  let output = "";
  child.stdout!.on("data", (data) => {
    output += data;
  });
  child.stderr!.on("data", (data) => {
    output += data;
  });
  const exited = once(child, "exit");
  return {
    child,
    exited,
    output: () => output,
    async ready() {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(output || "Startup timeout")), 10000);
        const check = () => {
          if (output.includes("Codex Hub listening")) {
            clearTimeout(timeout);
            resolve();
          }
        };
        child.stdout!.on("data", check);
        void exited.then(() => {
          clearTimeout(timeout);
          reject(new Error(output));
        });
        check();
      });
    },
  };
}
it("rejects shared uploads before recovery, preserves an in-progress file, and releases or reclaims owners", async () => {
  const directory = await home();
  const first = launch(directory);
  await first.ready();
  const folder = join(directory, "uploads", "a".repeat(64));
  await mkdir(folder);
  const pending = join(folder, "12345678-1234-1234-1234-123456789abc.png");
  await writeFile(pending, "upload in progress");
  const second = launch(directory);
  expect((await second.exited)[0]).toBe(1);
  expect(second.output()).toContain("choose another --home-dir");
  expect(await readFile(pending, "utf8")).toBe("upload in progress");
  const independent = launch(await home());
  await independent.ready();
  first.child.kill("SIGTERM");
  await first.exited;
  const restarted = launch(directory);
  await restarted.ready();
  restarted.child.kill("SIGKILL");
  await restarted.exited;
  const reclaimed = launch(directory);
  await reclaimed.ready();
}, 30000);
it("releases the lock when initialization or listening fails", async () => {
  const directory = await home();
  const preload = join(directory, "fail.mjs");
  await writeFile(
    preload,
    `import { UploadStore } from ${JSON.stringify(new URL("../../dist/server/server/uploads/store.js", import.meta.url).href)}; UploadStore.prototype.initialize = async () => { throw new Error("forced initialization failure"); }; setInterval(() => {}, 1000);`,
  );
  const failed = launch(directory, [], preload);
  await vi.waitFor(() => expect(failed.output()).toContain("forced initialization failure"));
  const afterInitializationFailure = launch(directory);
  await afterInitializationFailure.ready();
  afterInitializationFailure.child.kill("SIGTERM");
  await afterInitializationFailure.exited;
  const keepAlive = join(directory, "keep-alive.mjs");
  await writeFile(keepAlive, "setInterval(() => {}, 1000);");
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  try {
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const occupied = launch(directory, ["--port", String(address.port)], keepAlive);
    await vi.waitFor(() => expect(occupied.output()).toContain("EADDRINUSE"));
  } finally {
    listener.close();
  }
  const restarted = launch(directory);
  await restarted.ready();
}, 30000);

it("keeps a streaming upload protected while HTTP connections drain", async () => {
  const directory = await home();
  const preload = join(directory, "session.mjs");
  await writeFile(
    preload,
    `import { SessionReadService } from ${JSON.stringify(new URL("../../dist/server/server/application/session-read-service.js", import.meta.url).href)};
SessionReadService.prototype.getSession = async () => ({});
process.on("SIGTERM", () => setImmediate(() => console.log("draining")));`,
  );
  const first = launch(directory, [], preload);
  await first.ready();
  const origin = first.output().match(/http:\/\/127\.0\.0\.1:\d+/)![0];
  const upload = request(`${origin}/api/v1/uploads?sessionId=stream&filename=test.txt`, {
    method: "POST",
    agent: false,
  });
  const response = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    upload.on("error", reject);
    upload.on("response", (incoming) => {
      let body = "";
      incoming.on("data", (chunk) => {
        body += chunk;
      });
      incoming.on("end", () => resolve({ status: incoming.statusCode, body }));
      incoming.on("error", reject);
    });
  });
  upload.write("first chunk\n");
  const folder = join(directory, "uploads", createHash("sha256").update("stream").digest("hex"));
  await vi.waitFor(async () => {
    const names = await readdir(folder);
    expect(names).toHaveLength(1);
    expect(await readFile(join(folder, names[0]), "utf8")).toBe("first chunk\n");
  });
  const competing = launch(directory);
  expect((await competing.exited)[0]).toBe(1);
  first.child.kill("SIGTERM");
  await vi.waitFor(() => expect(first.output()).toContain("draining"));
  const duringDrain = launch(directory);
  expect((await duringDrain.exited)[0]).toBe(1);
  expect(duringDrain.output()).toContain("choose another --home-dir");
  upload.end("last chunk");
  const result = await response;
  expect(result.status).toBe(201);
  expect(await readFile(JSON.parse(result.body).path, "utf8")).toBe("first chunk\nlast chunk");
  await first.exited;
}, 30000);

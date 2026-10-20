import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "codex-hub-package-"));
let server;
try {
  await exec("npm", ["run", "build"], { cwd: root });
  const { stdout } = await exec(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    { cwd: root },
  );
  const result = JSON.parse(stdout);
  const [packed] = Array.isArray(result) ? result : Object.values(result);
  assert(packed.files.some((file) => file.path === "dist/client/index.html"));
  assert(!packed.files.some((file) => /^(src|tests|tools)\//.test(file.path)));
  await exec(
    "npm",
    [
      "install",
      "--prefix",
      temporary,
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(temporary, packed.filename),
    ],
    { cwd: temporary },
  );
  const binary = join(temporary, "node_modules", ".bin", "codex-hub");
  const help = await exec(binary, ["--help"], { cwd: temporary });
  assert.match(help.stdout, /Usage: codex-hub/);
  const home = join(temporary, "empty-home");
  await mkdir(home);
  await mkdir(join(home, "sessions"));
  await mkdir(join(home, "archived_sessions"));
  server = spawn(
    binary,
    ["--codex-home", `smoke=${home}`, "--port", "0", "--upload-dir", join(temporary, "uploads")],
    { cwd: temporary, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const address = await new Promise((resolveAddress, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 15000);
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited (${code}): ${output}`));
    });
    server.stderr.on("data", (chunk) => {
      output += chunk;
    });
    server.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolveAddress(match[0]);
      }
    });
  });
  const response = await fetch(address);
  assert.equal(response.status, 200);
  const html = await response.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)];
  assert(assets.length > 0);
  for (const [, asset] of assets) {
    assert.equal((await fetch(new URL(asset, address))).status, 200, asset);
  }
  const manifest = JSON.parse(
    await readFile(join(temporary, "node_modules/@someonegg/codex-hub/package.json"), "utf8"),
  );
  console.log(
    `Package smoke test passed: ${manifest.name}@${manifest.version} (${assets.length} assets)`,
  );
} finally {
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
  await rm(temporary, { recursive: true, force: true });
}

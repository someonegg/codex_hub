import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "codex-hub-package-"));
const suppliedTarball = process.argv[2];
let server;
try {
  let tarball;
  if (suppliedTarball) {
    tarball = resolve(suppliedTarball);
  } else {
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
    tarball = join(temporary, packed.filename);
  }
  await exec(
    "npm",
    [
      "install",
      "--prefix",
      temporary,
      "--omit=dev",
      "--engine-strict",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { cwd: temporary },
  );
  const binary = join(temporary, "node_modules", ".bin", "codex-hub");
  const help = await exec(binary, ["--help"], { cwd: temporary });
  assert.match(help.stdout, /Usage: codex-hub/);
  const source = join(temporary, "web-source");
  const hosting = join(temporary, "hosting");
  await mkdir(source);
  await writeFile(join(source, "index.html"), "<h1>Package hosting</h1>");
  const published = await exec(
    binary,
    ["page", "publish", source, "--project", temporary, "--home-dir", hosting, "--json"],
    { cwd: temporary },
  );
  const artifact = JSON.parse(published.stdout);
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () =>
      exec(
        binary,
        ["page", "publish", source, "--project", temporary, "--home-dir", hosting, "--json"],
        { cwd: temporary },
      ),
    ),
  );
  assert(concurrent.every(({ stdout }) => JSON.parse(stdout).id === artifact.id));
  assert.match(artifact.url, /^\/web\/[a-f0-9]{32}\/$/);
  await assert.rejects(exec(binary, ["publish", source, "--project", temporary]));
  const resource = (kind, action, ...args) =>
    exec(binary, [kind, action, ...args, "--home-dir", hosting, "--json"], { cwd: temporary });
  assert.equal(JSON.parse((await resource("page", "list")).stdout).length, 1);
  const diffFile = join(temporary, "review.diff");
  await writeFile(
    diffFile,
    "diff --git a/test b/test\n--- a/test\n+++ b/test\n@@ -1 +1 @@\n-old\n+new\n",
  );
  const plainDiff = await exec(binary, ["diff", "publish", diffFile, "--home-dir", hosting]);
  const plainUrl = plainDiff.stdout.split("\n")[0];
  assert.match(plainDiff.stdout, /\[review\.diff\]\(\/diffs\/[a-f0-9-]{36}\)/);
  await resource("diff", "delete", plainUrl.split("/").at(-1));
  assert.match((await exec(binary, ["diff", "--help"])).stdout, /diff publish/);
  const diffEntries = await Promise.all(
    Array.from({ length: 4 }, async () =>
      JSON.parse((await resource("diff", "publish", diffFile, "--title", "Review")).stdout),
    ),
  );
  assert.equal(new Set(diffEntries.map((entry) => entry.id)).size, 4);
  assert.equal(JSON.parse((await resource("diff", "list")).stdout).length, 4);
  await writeFile(diffFile, "independent source");
  for (const entry of diffEntries) {
    await resource("diff", "delete", entry.id);
    await resource("diff", "delete", entry.id);
  }
  assert.equal(JSON.parse((await resource("diff", "list")).stdout).length, 0);
  const home = join(temporary, "empty-home");
  await mkdir(home);
  await mkdir(join(home, "sessions"));
  await mkdir(join(home, "archived_sessions"));
  server = spawn(
    binary,
    ["--codex-home", `smoke=${home}`, "--port", "0", "--hosting", "--home-dir", hosting],
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
  assert.equal(
    await (await fetch(new URL(artifact.url, address))).text(),
    "<h1>Package hosting</h1>",
  );
  await resource("page", "delete", artifact.id);
  await resource("page", "delete", artifact.id);
  assert.equal((await fetch(new URL(artifact.url, address))).status, 404);
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
    `Package smoke test passed: ${manifest.name}@${manifest.version} Node ${process.version}, ${assets.length} assets`,
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

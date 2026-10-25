import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/server/config.js";
import { hostingRoutes } from "../../src/server/hosting/routes.js";
import { HostingStore } from "../../src/server/hosting/store.js";
import { createServer, listenServer } from "../../src/server/http/create-server.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hosting-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "页面 demo");
  const project = join(root, "项目", ".hub", "100% space");
  await mkdir(source);
  await mkdir(project, { recursive: true });
  await writeFile(join(source, "index.html"), '<script type="module" src="./main.js"></script>');
  await writeFile(join(source, "main.js"), 'document.body.dataset.loaded = "yes"');
  const store = new HostingStore(join(root, "storage"));
  return { root, source, project, store };
}
it("requires explicit hosting and never initializes disabled storage", async () => {
  expect(() => loadConfig(["--hosting-dir", "/tmp/hosting"])).toThrow(/requires/);
  const disabled = loadConfig([]);
  expect(disabled.kind === "run" && disabled.config.hostingDirectory).toBeUndefined();
  expect(hostingRoutes()).toBeTypeOf("function");
});
it("canonicalizes project aliases, updates stable identities and retains snapshots", async () => {
  const { root, source, project, store } = await fixture();
  await symlink(project, join(root, "alias"));
  const first = await store.publish(source, join(root, "alias"), undefined, "演示");
  await writeFile(join(source, "main.js"), "updated");
  const second = await store.publish(source, project);
  expect(second.id).toBe(first.id);
  expect(second.title).toBe("演示");
  expect(second.snapshotId).not.toBe(first.snapshotId);
  const [entry] = await store.entries();
  expect(entry.directory).toContain("%2Ehub");
  expect(entry.directory).toContain("100%25 space");
  expect(
    await readFile(join(entry.directory, "snapshots", first.snapshotId, "main.js"), "utf8"),
  ).toContain("dataset.loaded");
  expect((await store.publish(source, project, "another")).id).not.toBe(first.id);
  await rm(source, { recursive: true });
  expect(await new HostingStore(store.root).entries()).toHaveLength(2);
  await rm(entry.directory, { recursive: true });
  expect(await store.entries()).toHaveLength(1);
});
it("rejects nested symlinks and overlapping sources while preserving committed metadata", async () => {
  const { root, source, project, store } = await fixture();
  const first = await store.publish(source, project);
  await symlink(join(source, "main.js"), join(source, "alias.js"));
  await expect(store.publish(source, project)).rejects.toThrow(/regular/);
  expect((await store.entries())[0].artifact).toEqual(first);
  await expect(store.publish(root, project)).rejects.toThrow(/overlap/);
});
it("serializes concurrent publishes and deletes and recovers a dead writer", async () => {
  const { source, project, store } = await fixture();
  await mkdir(store.root);
  await mkdir(join(store.root, ".write-lock"));
  await writeFile(
    join(store.root, ".write-lock", "owner.json"),
    JSON.stringify({ pid: 2147483647, token: "00000000-0000-0000-0000-000000000000" }),
  );
  const entries = await Promise.all(
    Array.from({ length: 6 }, () => store.publish(source, project)),
  );
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(1);
  const id = entries[0].id;
  await Promise.all([store.delete(id), store.publish(source, project)]);
  expect((await store.entries()).length).toBeLessThanOrEqual(1);
});
it("serves immutable snapshot paths, MIME and HEAD with independent headers and deletion", async () => {
  const { root, source, project, store } = await fixture();
  await mkdir(join(source, "nested"));
  await writeFile(join(source, "nested", "index.html"), "nested page");
  const artifact = await store.publish(source, project);
  const client = join(root, "client");
  await mkdir(client);
  await writeFile(join(client, "index.html"), "hub");
  const server = createServer({
    homes: [],
    host: "127.0.0.1",
    port: 0,
    clientDirectory: client,
    tls: { enabled: false },
    interactionEnabled: false,
    hostingDirectory: store.root,
  });
  await listenServer(server, 0, "127.0.0.1");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const base = `http://127.0.0.1:${address.port}`;
  expect(await (await fetch(base + "/api/v1/capabilities")).json()).toEqual({ hosting: true });
  const stable = await fetch(base + artifact.url, { redirect: "manual" });
  expect(stable.status).toBe(302);
  const snapshot = stable.headers.get("location")!;
  const search = "?mode=preview&tag=a%2Fb&tag=c+d&empty=";
  for (const method of ["GET", "HEAD"]) {
    for (const [path, expected] of [
      [artifact.url, snapshot],
      [snapshot + "nested", snapshot + "nested/"],
    ]) {
      const redirect = await fetch(base + path + search, { method, redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe(expected + search);
      const followed = await fetch(base + path + search, { method });
      expect(followed.status).toBe(200);
      expect(followed.url).toBe(base + expected + search);
    }
  }

  await rm(source, { recursive: true });
  const html = await fetch(base + snapshot);
  expect(html.status).toBe(200);
  expect(html.headers.get("content-security-policy")).toBeNull();
  expect(html.headers.get("cache-control")).toBe("private, no-store");
  const js = await fetch(base + snapshot + "main.js", { method: "HEAD" });
  expect(js.headers.get("content-type")).toContain("javascript");
  expect(await js.text()).toBe("");
  expect((await fetch(base + snapshot + "%2e%2e%2fartifact.json")).status).toBe(404);
  expect((await fetch(base + "/")).headers.get("content-security-policy")).toContain(
    "script-src 'self'",
  );
  expect(
    (await fetch(base + "/api/v1/artifacts/" + artifact.id, { method: "DELETE" })).status,
  ).toBe(204);
  expect((await fetch(base + snapshot)).status).toBe(404);
});

it("separates same-named projects, resolves relative paths and encodes arbitrary names", async () => {
  const { root, source, project, store } = await fixture();
  const other = join(root, "other", "100% space");
  await mkdir(other, { recursive: true });
  const { relative } = await import("node:path");
  const first = await store.publish(
    relative(process.cwd(), source),
    relative(process.cwd(), project),
    "../中文 %/name",
  );
  const second = await store.publish(source, other, "../中文 %/name");
  expect(first.id).not.toBe(second.id);
  expect((await store.entries()).map(({ artifact }) => artifact.project)).toContain(
    await realpath(other),
  );
  expect((await store.entries()).every(({ directory }) => directory.includes("%2E%2E%2F"))).toBe(
    true,
  );
});
it("ignores interrupted temporary snapshots and damaged entries on restart", async () => {
  const { source, project, store } = await fixture();
  const artifact = await store.publish(source, project);
  const [entry] = await store.entries();
  await mkdir(join(entry.directory, "snapshots", ".tmp-interrupted"));
  await writeFile(join(entry.directory, ".artifact-interrupted.json"), "incomplete");
  const restarted = new HostingStore(store.root);
  expect((await restarted.entries())[0].artifact.id).toBe(artifact.id);
  const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => {});
  await writeFile(join(entry.directory, "artifact.json"), "broken metadata");
  expect(await restarted.entries()).toHaveLength(0);
  expect(diagnostics).toHaveBeenCalled();
  diagnostics.mockRestore();
});
it("refuses a second service and releases its lock when closed", async () => {
  const { root, store } = await fixture();
  const client = join(root, "client");
  await mkdir(client);
  await writeFile(join(client, "index.html"), "hub");
  const config = {
    homes: [],
    host: "127.0.0.1",
    port: 0,
    clientDirectory: client,
    tls: { enabled: false } as const,
    interactionEnabled: false,
    hostingDirectory: store.root,
  };
  const first = createServer(config);
  await listenServer(first, 0, config.host);
  expect(() => createServer(config)).toThrow(/already used/);
  await new Promise<void>((resolve) => first.close(() => resolve()));
  const second = createServer(config);
  await listenServer(second, 0, config.host);
  await new Promise<void>((resolve) => second.close(() => resolve()));
});
it("keeps all hosting routes disabled without touching existing snapshots", async () => {
  const { root, source, project, store } = await fixture();
  const artifact = await store.publish(source, project);
  const client = join(root, "client");
  await mkdir(client);
  await writeFile(join(client, "index.html"), "hub");
  const server = createServer({
    homes: [],
    host: "127.0.0.1",
    port: 0,
    clientDirectory: client,
    tls: { enabled: false },
    interactionEnabled: false,
  });
  await listenServer(server, 0, "127.0.0.1");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const base = `http://127.0.0.1:${address.port}`;
  expect(await (await fetch(base + "/api/v1/capabilities")).json()).toEqual({ hosting: false });
  for (const path of ["/artifacts", "/api/v1/artifacts", artifact.url])
    expect((await fetch(base + path)).status).toBe(404);
  expect((await store.entries())[0].artifact.id).toBe(artifact.id);
});

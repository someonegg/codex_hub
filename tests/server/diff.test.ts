import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { DiffStore } from "../../src/server/hosting/diff-store.js";
import { createServer, listenServer } from "../../src/server/http/create-server.js";
import { parseDiff } from "../../src/shared/diff.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hub-diffs-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "test.diff");
  await writeFile(
    source,
    "diff --git a/test b/test\n--- a/test\n+++ b/test\n@@ -1 +1 @@\n-before\n+<script>after</script>\n\\ No newline at end of file\n",
  );
  return { root, source, store: new DiffStore(join(root, "hosting")) };
}
it("publishes independent snapshots offline and serializes concurrent writes and idempotent deletion", async () => {
  const { source, store } = await fixture();
  const entries = await Promise.all(
    Array.from({ length: 3 }, () => store.publish(source, "Review")),
  );
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(3);
  await writeFile(source, "changed");
  expect((await store.get(entries[0].id))?.raw).toContain("<script>");
  await Promise.all(entries.map((entry) => store.delete(entry.id)));
  await store.delete(entries[0].id);
  expect(await store.list()).toEqual([]);
  expect(await readFile(source, "utf8")).toBe("changed");
  expect(await store.get("../../test")).toBeNull();
  await expect(store.delete("../test")).rejects.toThrow(/UUID/);
});
it("parses hunks, counts, C-quoted UTF-8 paths, spaces, and no-newline markers", () => {
  const parsed = parseDiff(
    'diff --git "a/\\344\\270\\255 file" "b/\\344\\270\\255 file"\n--- "a/\\344\\270\\255 file"\n+++ "b/\\344\\270\\255 file"\n@@ -2,2 +2,3 @@\n keep\n-old\n+new\n+extra\n\\ No newline at end of file\n@@ -8 +9 @@\n-x\n+y\n',
  );
  expect(parsed.warning).toBe(false);
  expect(parsed.files[0]).toMatchObject({ path: "中 file", additions: 3, deletions: 2 });
  expect(parsed.files[0].lines.find((line) => line.text === "extra")).toMatchObject({
    next: 4,
  });
  expect(parsed.files[0].lines.at(-1)).toMatchObject({ text: "y", next: 9 });
});
it("supports added, deleted, renamed, mode-only and binary files, and warns on partial formats", () => {
  const parsed = parseDiff(`diff --git a/new file b/new file
new file mode 100644
--- /dev/null
+++ b/new file
@@ -0,0 +1 @@
+new
 diff invalid
`);
  expect(parsed.warning).toBe(true);
  expect(parsed.files[0]).toMatchObject({ path: "new file", additions: 1 });
  for (const body of [
    "deleted file mode 100644\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-old",
    "similarity index 100%\nrename from gone\nrename to next",
    "old mode 100644\nnew mode 100755",
    "Binary files a/gone and b/next differ",
  ]) {
    expect(parseDiff(`diff --git a/gone b/gone\n${body}\n`).warning).toBe(false);
  }
  expect(parseDiff("garbage").warning).toBe(true);
  expect(parseDiff("diff --git a/x b/x\n@@ -1,2 +1 @@\n-a\n+b").warning).toBe(true);
});
it("gates routes, preserves CSP and no-store, and returns 404 after deletion", async () => {
  const { root, source, store } = await fixture();
  const entry = await store.publish(source);
  const client = join(root, "client");
  await mkdir(client);
  await writeFile(join(client, "index.html"), "hub");
  for (const enabled of [false, true]) {
    const server = createServer({
      homes: [],
      host: "127.0.0.1",
      port: 0,
      clientDirectory: client,
      tls: { enabled: false },
      interactionEnabled: false,
      ...(enabled ? { hostingDirectory: join(root, "hosting") } : {}),
    });
    await listenServer(server, 0, "127.0.0.1");
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const origin = `http://127.0.0.1:${address.port}`;
    for (const path of [entry.url, `/api/v1/diffs/${entry.id}`]) {
      const response = await fetch(origin + path);
      expect(response.status).toBe(enabled ? 200 : 404);
      expect(response.headers.get("content-security-policy")).toBeTruthy();
      if (enabled) expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    if (enabled) {
      expect((await fetch(origin + `/api/v1/diffs/${entry.id}`, { method: "DELETE" })).status).toBe(
        204,
      );
      for (const path of [entry.url, `/api/v1/diffs/${entry.id}`, "/api/v1/diffs"])
        expect((await fetch(origin + path)).status).toBe(404);
    }
  }
});

it("removes Git's separator tab without trimming spaces in a filename", () => {
  const parsed = parseDiff(
    "diff --git a/a b  b/a b \n--- a/a b \t\n+++ b/a b \t\n@@ -1 +1 @@\n-a\n+b\n",
  );
  expect(parsed.files[0].path).toBe("a b ");
  expect(parsed.warning).toBe(false);
});

it("lists metadata without opening diff bodies", async () => {
  const { root, source, store } = await fixture();
  const entry = await store.publish(source, "Metadata only");
  const rawPath = join(root, "hosting", "diffs", entry.id, "raw.diff");
  // A directory makes any attempt to read the body fail without allocating a large fixture.
  await rm(rawPath);
  await mkdir(rawPath);
  expect(await store.list()).toEqual([entry]);
});

it.each([
  ["a", "\x07"],
  ["b", "\b"],
  ["f", "\f"],
  ["v", "\v"],
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["\\", "\\"],
  ['"', '"'],
])("decodes Git's C escape %s in file headers and patch paths", (escape, decoded) => {
  const path = `name\\${escape}end`;
  const header = `diff --git "a/${path}" "b/${path}"\n`;
  const modeOnly = parseDiff(header + "old mode 100644\nnew mode 100755\n");
  const patch = parseDiff(header + `--- "a/${path}"\n+++ "b/${path}"\n@@ -1 +1 @@\n-old\n+new\n`);
  for (const parsed of [modeOnly, patch]) {
    expect(parsed.warning).toBe(false);
    expect(parsed.files[0].path).toBe(`name${decoded}end`);
  }
});

it.each(["foo b/bar", "foo b/bar b/baz", "a/ b/ b/", " leading b/trailing "])(
  "resolves repeated paths containing spaces and b/ without patch headers: %s",
  (path) => {
    for (const body of [
      "old mode 100644\nnew mode 100755",
      "new file mode 100644",
      "deleted file mode 100644",
    ]) {
      const parsed = parseDiff(`diff --git a/${path} b/${path}\n${body}\n`);
      expect(parsed.warning).toBe(false);
      expect(parsed.files[0].path).toBe(path);
    }
  },
);

it.each(["rename", "copy"])(
  "uses explicit %s paths without stripping real a/ or b/ directories",
  (operation) => {
    const parsed = parseDiff(`diff --git a/old b/name b/b/new b/name
similarity index 100%
${operation} from old b/name
${operation} to b/new b/name
`);
    expect(parsed.warning).toBe(false);
    expect(parsed.files[0].path).toBe("b/new b/name");
  },
);

it.each(['"a/foo b/bar" b/foo b/bar', 'a/foo b/bar "b/foo b/bar"', '"a/foo b/bar" "b/foo b/bar"'])(
  "resolves quoted header paths: %s",
  (header) => {
    const parsed = parseDiff(`diff --git ${header}\nold mode 100644\nnew mode 100755\n`);
    expect(parsed.warning).toBe(false);
    expect(parsed.files[0].path).toBe("foo b/bar");
  },
);

it("warns on unequal header paths unless subsequent headers resolve the name", () => {
  const header = "diff --git a/old b/path b/new b/path\n";
  expect(parseDiff(header + "old mode 100644\nnew mode 100755\n").warning).toBe(true);
  const parsed = parseDiff(
    header + "--- a/old b/path\n+++ b/new b/path\n@@ -1 +1 @@\n-old\n+new\n",
  );
  expect(parsed.warning).toBe(false);
  expect(parsed.files[0].path).toBe("new b/path");
});

it("serves pages and deletes resources without loading diff bodies", async () => {
  const { root, source, store } = await fixture();
  const entry = await store.publish(source);
  const readBody = vi
    .spyOn(DiffStore.prototype, "get")
    .mockRejectedValue(new Error("Unexpected body read"));
  cleanup.push(async () => readBody.mockRestore());
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
    hostingDirectory: join(root, "hosting"),
  });
  await listenServer(server, 0, "127.0.0.1");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const url = `http://127.0.0.1:${address.port}${entry.url}`;
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(url, { method });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(method === "GET" ? "hub" : "");
  }
  const removable = await store.publish(source);
  const deleteUrl = new URL(`/api/v1/diffs/${removable.id}`, url);
  expect((await fetch(deleteUrl, { method: "DELETE" })).status).toBe(204);
  expect((await fetch(deleteUrl, { method: "DELETE" })).status).toBe(404);
  expect(readBody).not.toHaveBeenCalled();
  const raw = join(root, "hosting", "diffs", entry.id, "raw.diff");
  await rm(raw);
  for (const method of ["GET", "HEAD"]) expect((await fetch(url, { method })).status).toBe(404);
  await mkdir(raw);
  expect(await store.exists(entry.id)).toBe(false);
  expect(await store.exists("../invalid")).toBe(false);
});

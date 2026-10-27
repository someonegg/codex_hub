import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RequestBodyError } from "../../src/server/http/request-body.js";
import { sendJson } from "../../src/server/http/router.js";
import { createUploadRoutes, uploadDirectory } from "../../src/server/http/upload-routes.js";
import { UploadStore } from "../../src/server/uploads/store.js";
import type { UploadAttachment } from "../../src/shared/uploads.js";
import { MAX_UPLOAD_BYTES } from "../../src/shared/uploads.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), "hub-upload-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "space ' quote", "uploads");
  const store = new UploadStore(directory);
  return { store, directory };
}
async function fixture() {
  const { store, directory } = await storeFixture();
  const route = createUploadRoutes(store, {
    getSession: vi.fn().mockImplementation(async (id: string) => (id === "missing" ? null : {})),
  });
  const server = createServer(async (request, response) => {
    try {
      await route.handle(request, response, new URL(request.url!, "http://localhost"));
    } catch (error) {
      sendJson(response, error instanceof RequestBodyError ? error.status : 500, {
        error: { code: error instanceof RequestBodyError ? error.code : "internal_error" },
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address() as { port: number };
  return { store, directory, origin: `http://127.0.0.1:${address.port}` };
}
describe("uploads", () => {
  it("creates unique absolute paths, preserves content and safe extensions", async () => {
    const { origin, store } = await fixture();
    const results = await Promise.all(
      [
        "../../sample.txt",
        "sample.txt",
        "no-extension",
        "bad.sh!",
        "data.json",
        "data.pending",
        "data.deleting",
      ].map(async (filename) => {
        const response = await fetch(
          `${origin}/api/v1/uploads?sessionId=session-one&filename=${encodeURIComponent(filename)}`,
          { method: "POST", body: "hello\u0000world" },
        );
        expect(response.status).toBe(201);
        const body = (await response.json()) as UploadAttachment;
        expect(body).not.toHaveProperty("attachment");
        const { path } = body;
        expect(isAbsolute(path)).toBe(true);
        expect(await readFile(path, "utf8")).toBe("hello\u0000world");
        return path;
      }),
    );
    expect(new Set(results).size).toBe(7);
    expect(results[0]).toMatch(/[0-9a-f-]{36}\.txt$/);
    expect(results[2]).toMatch(/[0-9a-f-]{36}$/);
    expect(await store.list("session-one")).toHaveLength(7);
  });

  it("rejects declared oversize and cross-origin requests", async () => {
    const { origin } = await fixture();
    const forbidden = await fetch(`${origin}/api/v1/uploads?sessionId=session-one`, {
      method: "POST",
      headers: { Origin: "https://example.com" },
      body: "data",
    });
    expect(forbidden.status).toBe(403);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${origin}/api/v1/uploads?sessionId=session-one`,
        { method: "POST", headers: { "Content-Length": MAX_UPLOAD_BYTES + 1 } },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(413);
  });
  it("rejects actual chunked oversize and removes partial files", async () => {
    const { origin, store } = await fixture();
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${origin}/api/v1/uploads?sessionId=session-one`,
        { method: "POST" },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.on("error", reject);
      request.write(Buffer.alloc(MAX_UPLOAD_BYTES));
      request.end(Buffer.alloc(1));
    });
    expect(status).toBe(413);
    expect(await store.list("session-one")).toEqual([]);
  });
  it("removes files when the sender disconnects", async () => {
    const { origin, directory } = await fixture();
    const request = httpRequest(`${origin}/api/v1/uploads?sessionId=session-one`, {
      method: "POST",
    });
    request.on("error", () => undefined);
    request.write("partial");
    try {
      // Do not disconnect until the server has actually opened a partial file.
      await vi.waitFor(async () =>
        expect(
          (await readdir(directory, { recursive: true })).some((name) =>
            /(^|\/)[a-f0-9-]{36}$/.test(name),
          ),
        ).toBe(true),
      );
      request.destroy();
      await vi.waitFor(async () =>
        expect(
          (await readdir(directory, { recursive: true })).filter((name) =>
            /(^|\/)[a-f0-9-]{36}$/.test(name),
          ),
        ).toEqual([]),
      );
    } finally {
      request.destroy();
    }
  });
});

it("returns a storage error without creating an upload when its directory is a file", async () => {
  const { origin, directory } = await fixture();
  // A successful request creates the configured nested directory.
  await fetch(`${origin}/api/v1/uploads?sessionId=session-one`, { method: "POST", body: "first" });
  const { writeFile } = await import("node:fs/promises");
  await rm(directory, { recursive: true });
  await writeFile(directory, "not a directory");
  const response = await fetch(`${origin}/api/v1/uploads?sessionId=session-one`, {
    method: "POST",
    body: "second",
  });
  expect(response.status).toBe(500);
  expect(await readFile(directory, "utf8")).toBe("not a directory");
});

it("removes the partial file when a disk write fails", async () => {
  const { origin, directory, store } = await fixture();
  await uploadDirectory(directory);
  const { open } = await import("node:fs/promises");
  const probe = await open(join(directory, "probe"), "wx");
  const prototype = Object.getPrototypeOf(probe) as { writeFile: typeof probe.writeFile };
  await probe.close();
  await rm(join(directory, "probe"));
  const write = vi.spyOn(prototype, "writeFile").mockRejectedValueOnce(new Error("Disk full"));
  try {
    const response = await fetch(`${origin}/api/v1/uploads?sessionId=session-one`, {
      method: "POST",
      body: "payload",
    });
    expect(response.status).toBe(500);
    expect(write).toHaveBeenCalledOnce();
    expect(await store.list("session-one")).toEqual([]);
  } finally {
    write.mockRestore();
  }
});

it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
  "rejects an unwritable upload directory",
  async () => {
    const { origin, directory, store } = await fixture();
    await uploadDirectory(directory);
    const { chmod } = await import("node:fs/promises");
    await chmod(directory, 0o500);
    try {
      const response = await fetch(`${origin}/api/v1/uploads?sessionId=session-one`, {
        method: "POST",
        body: "payload",
      });
      expect(response.status).toBe(500);
      expect(await store.list("session-one")).toEqual([]);
    } finally {
      await chmod(directory, 0o700);
    }
  },
);

it("requires a known session and isolates content, deletion, and active file types", async () => {
  const { origin, store } = await fixture();
  expect((await fetch(`${origin}/api/v1/uploads`, { method: "POST", body: "x" })).status).toBe(400);
  expect(
    (await fetch(`${origin}/api/v1/uploads?sessionId=missing`, { method: "POST", body: "x" }))
      .status,
  ).toBe(404);
  const response = await fetch(`${origin}/api/v1/uploads?sessionId=one&filename=active.svg`, {
    method: "POST",
    headers: { "Content-Type": "image/svg+xml" },
    body: "<svg/>",
  });
  const attachment = (await response.json()) as UploadAttachment;
  const content = `/api/v1/sessions/one/uploads/${attachment.id}/content`;
  expect((await fetch(origin + content.replace("/one/", "/two/"))).status).toBe(404);
  expect((await fetch(origin + content)).headers.get("content-type")).toBe(
    "application/octet-stream",
  );
  expect((await fetch(origin + content)).headers.get("content-disposition")).toMatch(/^attachment/);
  expect((await fetch(origin + content.replace(attachment.id, "..%2F..%2Fsecret"))).status).toBe(
    404,
  );
  const target = `${origin}/api/v1/sessions/one/uploads/${attachment.id}`;
  expect(
    (await fetch(target, { method: "DELETE", headers: { Origin: "https://evil.example" } })).status,
  ).toBe(403);
  await fetch(target.replace("/one/", "/two/"), { method: "DELETE" });
  expect(await store.get("one", attachment.id)).not.toBeNull();
  for (let i = 0; i < 2; i++) expect((await fetch(target, { method: "DELETE" })).status).toBe(200);
  expect(await store.list("one")).toEqual([]);
  expect((await fetch(origin + content)).status).toBe(404);
});

it.each([
  ["/api/v1/uploads?sessionId=one", "GET", "POST"],
  ["/api/v1/sessions/one/uploads", "POST", "GET"],
  ["/api/v1/sessions/one/uploads/attachment", "GET", "DELETE"],
  ["/api/v1/sessions/one/uploads/attachment/content", "DELETE", "GET"],
])("restricts %s to its supported method", async (path, method, allowed) => {
  const { origin } = await fixture();
  const response = await fetch(origin + path, { method });
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe(allowed);
  expect(await response.json()).toEqual({
    error: { code: "method_not_allowed", message: "Method not allowed" },
  });
});

it("returns all uploads newest first and persists metadata across restarts", async () => {
  const { origin, directory, store } = await fixture();
  // Seed persisted history; the final upload still exercises the HTTP write path.
  const folder = join(directory, createHash("sha256").update("one").digest("hex"));
  await fs.mkdir(folder, { recursive: true });
  await Promise.all(
    Array.from({ length: 51 }, async (_, i) => {
      const id = randomUUID();
      const attachment: UploadAttachment = {
        id,
        sessionId: "one",
        filename: "same.png",
        size: 3,
        type: "image/png",
        uploadedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 2))).toISOString(),
        path: join(folder, `${id}.png`),
      };
      await fs.writeFile(attachment.path, "png");
      await fs.writeFile(join(folder, `${id}.meta.json`), JSON.stringify(attachment));
    }),
  );
  expect(
    (
      await fetch(`${origin}/api/v1/uploads?sessionId=one&filename=same.png`, {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: "png",
      })
    ).status,
  ).toBe(201);
  const response = await fetch(`${origin}/api/v1/sessions/one/uploads`);
  const history = (await response.json()) as { items: UploadAttachment[] };
  expect(Object.keys(history)).toEqual(["items"]);
  expect(history.items).toHaveLength(52);
  expect(history.items).toEqual(
    [...history.items].sort(
      (a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || b.id.localeCompare(a.id),
    ),
  );
  await store.delete("one", history.items[0]!.id);
  const restarted = new UploadStore(directory);
  await restarted.initialize();
  expect(await restarted.list("one")).toEqual(history.items.slice(1));
  expect(await restarted.list("two")).toEqual([]);
});

it("preserves the registration when marking a deletion fails", async () => {
  const { store } = await storeFixture();
  const attachment = await store.upload(
    "one",
    "",
    "",
    (async function* () {
      yield Buffer.from("data");
    })(),
  );
  const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("Disk unavailable"));
  await expect(store.delete("one", attachment.id)).rejects.toThrow("Disk unavailable");
  rename.mockRestore();
  expect(await store.get("one", attachment.id)).toEqual(attachment);
  expect(await readFile(attachment.path, "utf8")).toBe("data");
  await store.delete("one", attachment.id);
  expect(await store.list("one")).toEqual([]);
});

it.each([
  ["content", "retry"],
  ["content", "restart"],
  ["tombstone", "retry"],
  ["tombstone", "restart"],
])("recovers deletion interrupted at %s using %s", async (step, recovery) => {
  const { origin, directory, store } = await fixture();
  const attachment = (await (
    await fetch(`${origin}/api/v1/uploads?sessionId=one&filename=a.txt`, {
      method: "POST",
      body: "data",
    })
  ).json()) as UploadAttachment;
  const folder = join(attachment.path, "..");
  const tombstone = join(folder, attachment.id + ".meta.deleting");
  const remove = fs.rm;
  const failure = vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
    if (path === (step === "content" ? attachment.path : tombstone))
      throw new Error("Simulated interruption");
    return remove(path, options);
  });
  const target = `${origin}/api/v1/sessions/one/uploads/${attachment.id}`;
  expect((await fetch(target, { method: "DELETE" })).status).toBe(500);
  failure.mockRestore();
  expect(await store.list("one")).toEqual([]);
  expect(await store.get("one", attachment.id)).toBeNull();
  expect((await fetch(target + "/content")).status).toBe(404);
  expect(JSON.parse(await readFile(tombstone, "utf8"))).toEqual(attachment);
  if (step === "content") expect(await readFile(attachment.path, "utf8")).toBe("data");
  else await expect(readFile(attachment.path)).rejects.toMatchObject({ code: "ENOENT" });
  if (recovery === "retry") {
    expect((await fetch(target, { method: "DELETE" })).status).toBe(200);
  } else {
    await new UploadStore(directory).initialize();
  }
  expect(await readdir(folder)).toEqual([]);
  expect((await fetch(target, { method: "DELETE" })).status).toBe(200);
});

it("accepts byte streams and recovers interrupted writes without HTTP dependencies", async () => {
  const { store, directory } = await storeFixture();
  async function* chunks() {
    yield new Uint8Array([0, 1]);
    yield new Uint8Array([2, 3]);
  }
  const attachment = await store.upload("one", "bytes.bin", "application/octet-stream", chunks());
  expect(attachment.size).toBe(4);
  expect(await readFile(attachment.path)).toEqual(Buffer.from([0, 1, 2, 3]));
  async function* broken() {
    yield new Uint8Array([4]);
    throw new Error("Stream interrupted");
  }
  await expect(
    store.upload("one", "partial.bin", "application/octet-stream", broken()),
  ).rejects.toThrow("Stream interrupted");
  expect(await readdir(join(attachment.path, ".."))).toHaveLength(2);
  const folder = join(attachment.path, "..");
  const orphan = "11111111-1111-4111-8111-111111111111";
  await fs.writeFile(join(folder, orphan + ".txt"), "partial");
  await fs.writeFile(join(folder, orphan + ".meta.pending"), "partial");
  await new UploadStore(directory).initialize();
  expect(await readdir(folder)).toHaveLength(2);
  expect(await store.list("one")).toEqual([attachment]);
});

it("deletes an attachment and accepts new uploads while another upload is unfinished", async () => {
  const { origin, directory, store } = await fixture();
  const attachment = (await (
    await fetch(`${origin}/api/v1/uploads?sessionId=one&filename=old.txt`, {
      method: "POST",
      body: "old",
    })
  ).json()) as UploadAttachment;
  const request = httpRequest(`${origin}/api/v1/uploads?sessionId=one`, { method: "POST" });
  request.on("error", () => undefined);
  const completed = new Promise<number>((resolve) =>
    request.on("response", (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode!));
    }),
  );
  request.write("partial");
  try {
    await vi.waitFor(async () =>
      expect(
        (await readdir(directory, { recursive: true })).some((name) =>
          /(^|\/)[a-f0-9-]{36}$/.test(name),
        ),
      ).toBe(true),
    );
    let deleted = false;
    const deletion = store.delete("one", attachment.id).then(() => {
      deleted = true;
    });
    await vi.waitFor(() => expect(deleted).toBe(true));
    await deletion;
    expect(
      (await fetch(`${origin}/api/v1/uploads?sessionId=one`, { method: "POST", body: "new" }))
        .status,
    ).toBe(201);
    request.end("finished");
    expect(await completed).toBe(201);
    expect(await store.list("one")).toHaveLength(2);
  } finally {
    request.destroy();
  }
});

it("accepts uploads while a single-file deletion is stalled", async () => {
  const { origin, store } = await fixture();
  const attachment = (await (
    await fetch(`${origin}/api/v1/uploads?sessionId=one`, { method: "POST", body: "old" })
  ).json()) as UploadAttachment;
  const remove = fs.rm;
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const deleting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const lookup = vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
    if (path === attachment.path) {
      started();
      await stalled;
    }
    return remove(path, options);
  });
  const deletion = store.delete("one", attachment.id);
  try {
    await deleting;
    expect(
      (await fetch(`${origin}/api/v1/uploads?sessionId=one`, { method: "POST", body: "new" }))
        .status,
    ).toBe(201);
  } finally {
    release();
    await deletion;
    lookup.mockRestore();
  }
  expect(await store.list("one")).toHaveLength(1);
});

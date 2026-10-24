import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RequestBodyError } from "../../src/server/http/request-body.js";
import { sendJson } from "../../src/server/http/router.js";
import { createUploadRoutes, uploadDirectory } from "../../src/server/http/upload-routes.js";
import { MAX_UPLOAD_BYTES } from "../../src/shared/uploads.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hub-upload-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "space ' quote", "uploads");
  const route = createUploadRoutes(directory);
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
  return { directory, origin: `http://127.0.0.1:${address.port}` };
}
describe("uploads", () => {
  it("creates unique absolute paths, preserves content and safe extensions", async () => {
    const { origin, directory } = await fixture();
    const results = await Promise.all(
      ["../../sample.txt", "sample.txt", "no-extension", "bad.sh!"].map(async (filename) => {
        const response = await fetch(
          `${origin}/api/v1/uploads?filename=${encodeURIComponent(filename)}`,
          { method: "POST", body: "hello\u0000world" },
        );
        expect(response.status).toBe(201);
        const { path } = (await response.json()) as { path: string };
        expect(isAbsolute(path)).toBe(true);
        expect(await readFile(path, "utf8")).toBe("hello\u0000world");
        return path;
      }),
    );
    expect(new Set(results).size).toBe(4);
    expect(results[0]).toMatch(/[0-9a-f-]{36}\.txt$/);
    expect(results[2]).toMatch(/[0-9a-f-]{36}$/);
    expect(await readdir(directory)).toHaveLength(4);
  });

  it("rejects declared oversize and cross-origin requests", async () => {
    const { origin } = await fixture();
    const forbidden = await fetch(`${origin}/api/v1/uploads`, {
      method: "POST",
      headers: { Origin: "https://example.com" },
      body: "data",
    });
    expect(forbidden.status).toBe(403);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${origin}/api/v1/uploads`,
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
    const { origin, directory } = await fixture();
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${origin}/api/v1/uploads`, { method: "POST" }, (response) => {
        response.resume();
        resolve(response.statusCode!);
      });
      request.on("error", reject);
      request.write(Buffer.alloc(MAX_UPLOAD_BYTES));
      request.end(Buffer.alloc(1));
    });
    expect(status).toBe(413);
    expect(await readdir(directory)).toEqual([]);
  });
  it("removes files when the sender disconnects", async () => {
    const { origin, directory } = await fixture();
    const request = httpRequest(`${origin}/api/v1/uploads`, { method: "POST" });
    request.on("error", () => undefined);
    request.write("partial");
    try {
      // Do not disconnect until the server has actually opened a partial file.
      await vi.waitFor(async () => expect(await readdir(directory)).toHaveLength(1));
      request.destroy();
      await vi.waitFor(async () => expect(await readdir(directory)).toEqual([]));
    } finally {
      request.destroy();
    }
  });
});

it("returns a storage error without creating an upload when its directory is a file", async () => {
  const { origin, directory } = await fixture();
  // A successful request creates the configured nested directory.
  await fetch(`${origin}/api/v1/uploads`, { method: "POST", body: "first" });
  const { writeFile } = await import("node:fs/promises");
  await rm(directory, { recursive: true });
  await writeFile(directory, "not a directory");
  const response = await fetch(`${origin}/api/v1/uploads`, { method: "POST", body: "second" });
  expect(response.status).toBe(500);
  expect(await readFile(directory, "utf8")).toBe("not a directory");
});

it("removes the partial file when a disk write fails", async () => {
  const { origin, directory } = await fixture();
  await uploadDirectory(directory);
  const { open } = await import("node:fs/promises");
  const probe = await open(join(directory, "probe"), "wx");
  const prototype = Object.getPrototypeOf(probe) as { writeFile: typeof probe.writeFile };
  await probe.close();
  await rm(join(directory, "probe"));
  const write = vi.spyOn(prototype, "writeFile").mockRejectedValueOnce(new Error("Disk full"));
  try {
    const response = await fetch(`${origin}/api/v1/uploads`, { method: "POST", body: "payload" });
    expect(response.status).toBe(500);
    expect(write).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
  } finally {
    write.mockRestore();
  }
});

it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
  "rejects an unwritable upload directory",
  async () => {
    const { origin, directory } = await fixture();
    await uploadDirectory(directory);
    const { chmod } = await import("node:fs/promises");
    await chmod(directory, 0o500);
    try {
      const response = await fetch(`${origin}/api/v1/uploads`, { method: "POST", body: "payload" });
      expect(response.status).toBe(500);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await chmod(directory, 0o700);
    }
  },
);

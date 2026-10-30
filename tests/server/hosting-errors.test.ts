import type * as NodeFs from "node:fs";
import { createReadStream } from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { expect, it, vi } from "vitest";

import { hostingRoutes } from "../../src/server/hosting/routes.js";
import { HostingStore } from "../../src/server/hosting/store.js";
import { reportRequestError } from "../../src/server/http/request-errors.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof NodeFs>();
  return { ...fs, createReadStream: vi.fn(fs.createReadStream) };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof NodeFsPromises>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});
async function publishedArtifact() {
  const root = await createTempDirectory("hosting-errors-");
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "index.html"), "page");
  const store = new HostingStore(join(root, "hosting"));
  const artifact = await store.publish(source, root);
  return { store, artifact };
}

it("propagates artifact storage permission failures", async () => {
  const { store, artifact } = await publishedArtifact();
  const denied = Object.assign(new Error("storage denied"), { code: "EACCES" });
  vi.mocked(readFile).mockRejectedValueOnce(denied);
  await expect(store.get(artifact.id)).rejects.toBe(denied);
});

it("logs stream errors and destroys the response without writing JSON", async () => {
  const { store, artifact } = await publishedArtifact();
  const stream = new PassThrough();
  vi.mocked(createReadStream).mockReturnValueOnce(
    stream as unknown as ReturnType<typeof createReadStream>,
  );
  const response = new PassThrough() as unknown as ServerResponse;
  response.setHeader = vi.fn();
  response.removeHeader = vi.fn();
  const end = vi.spyOn(response, "end");
  const logger = { error: vi.fn() };
  const router = hostingRoutes(store.root, { logger, requestId: () => "stream-request" });
  const request = {
    method: "GET",
    url: `/web/${artifact.id}/${artifact.snapshotId}/`,
  } as IncomingMessage;
  expect(await router(request, response)).toBe(true);
  const error = new Error("stream failure");
  stream.emit("error", error);
  expect(response.destroyed).toBe(true);
  expect(end).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledExactlyOnceWith("HTTP request failed", {
    requestId: "stream-request",
    method: "GET",
    path: request.url,
    error,
  });
});

it("logs failures after headers and never sends a second response", () => {
  const response = {
    headersSent: true,
    destroy: vi.fn(),
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
  const logger = { error: vi.fn() };
  reportRequestError(
    { method: "GET", url: "/web/test/" } as IncomingMessage,
    response,
    new Error("late failure"),
    { logger },
  );
  expect(logger.error).toHaveBeenCalledTimes(1);
  expect(response.destroy).toHaveBeenCalledTimes(1);
  expect(response.setHeader).not.toHaveBeenCalled();
  expect(response.end).not.toHaveBeenCalled();
});

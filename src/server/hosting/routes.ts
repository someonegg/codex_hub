import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

import { type ApiRouter, sendJson } from "../http/router.js";
import { DiffStore } from "./diff-store.js";
import { HostingStore } from "./store.js";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".webmanifest": "application/manifest+json",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
};
export function hostingRoutes(directory?: string): ApiRouter {
  const store = directory === undefined ? undefined : new HostingStore(directory);
  const diffs = directory === undefined ? undefined : new DiffStore(directory);
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const head = request.method === "HEAD";
    if (path === "/api/v1/capabilities" && request.method === "GET") {
      sendJson(response, 200, { hosting: !!store });
      return true;
    }
    if (path.startsWith("/api/v1/diffs")) {
      response.setHeader("Cache-Control", "private, no-store");
      const match = /^\/api\/v1\/diffs\/([^/]+)$/.exec(path);
      const entry = diffs && match && request.method === "GET" ? await diffs.get(match[1]) : null;
      if (entry) {
        sendJson(response, 200, entry);
      } else if (diffs && match && request.method === "DELETE" && (await diffs.exists(match[1]))) {
        await diffs.delete(match[1]);
        response.statusCode = 204;
        response.end();
      } else {
        sendJson(response, 404, {
          error: { code: "not_found", message: "Diff not found or already cleaned up" },
        });
      }
      return true;
    }
    if (!path.startsWith("/web/") && !path.startsWith("/api/v1/artifacts")) return false;
    const missing = () =>
      sendJson(
        response,
        404,
        { error: { code: "not_found", message: "Artifact not found" } },
        head,
      );
    if (!store) {
      missing();
      return true;
    }
    if (path === "/api/v1/artifacts" && request.method === "GET") {
      const groups = new Map<string, object[]>();
      for (const { artifact } of await store.entries()) {
        const list = groups.get(artifact.project) ?? [];
        list.push(artifact);
        groups.set(artifact.project, list);
      }
      sendJson(response, 200, {
        projects: [...groups].map(([directory, artifacts]) => ({ directory, artifacts })),
      });
      return true;
    }
    const deletion = /^\/api\/v1\/artifacts\/([a-f0-9]{32})$/.exec(path);
    if (deletion && request.method === "DELETE") {
      if (await store.delete(deletion[1])) {
        response.statusCode = 204;
        response.end();
      } else missing();
      return true;
    }
    const match = /^\/web\/([a-f0-9]{32})\/(?:([a-f0-9]{32})\/(.*))?$/.exec(path);
    if (!match || (request.method !== "GET" && !head)) {
      missing();
      return true;
    }
    response.removeHeader("Content-Security-Policy");
    response.setHeader("Cache-Control", "private, no-store");
    const entry = await store.get(match[1]);
    if (!entry) {
      missing();
      return true;
    }
    if (!match[2]) {
      response.statusCode = 302;
      response.setHeader(
        "Location",
        `/web/${entry.artifact.id}/${entry.artifact.snapshotId}/${url.search}`,
      );
      response.end();
      return true;
    }
    try {
      const relative = decodeURIComponent(match[3]);
      if (relative.split(/[\\/]/).some((part) => part === "..") || relative.includes("\0"))
        throw new Error("Invalid path");
      const snapshotRoot = resolve(entry.directory, "snapshots", match[2]);
      const root = await realpath(snapshotRoot);
      if (root !== snapshotRoot) throw new Error("Snapshot aliases are not allowed");
      let file = await realpath(resolve(root, relative || "index.html"));
      if (!file.startsWith(root + sep)) throw new Error("Invalid path");
      if ((await stat(file)).isDirectory()) {
        if (!path.endsWith("/")) {
          response.statusCode = 302;
          response.setHeader("Location", path + "/" + url.search);
          response.end();
          return true;
        }
        file = await realpath(join(file, "index.html"));
      }
      if (!file.startsWith(root + sep)) throw new Error("Invalid path");
      const info = await stat(file);
      if (!info.isFile()) throw new Error("Not a file");
      response.setHeader(
        "Content-Type",
        types[extname(file).toLowerCase()] ?? "application/octet-stream",
      );
      response.setHeader("Content-Length", info.size);
      if (head) response.end();
      else
        createReadStream(file)
          .on("error", () => response.destroy())
          .pipe(response);
    } catch {
      missing();
    }
    return true;
  };
}

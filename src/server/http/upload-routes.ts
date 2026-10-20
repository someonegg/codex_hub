import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { MAX_UPLOAD_BYTES } from "../../shared/uploads.js";
import type { ApiRouteHandler } from "./api-route-handler.js";
import { RequestBodyError } from "./request-body.js";
import { sendJson } from "./router.js";

let defaultDirectory: Promise<string> | undefined;
export async function uploadDirectory(configured?: string): Promise<string> {
  if (configured !== undefined) {
    await mkdir(configured, { recursive: true });
    return realpath(configured);
  }
  defaultDirectory ??= mkdtemp(join(tmpdir(), "codex-hub-uploads-")).then((directory) =>
    realpath(directory),
  );
  return defaultDirectory;
}

export function createUploadRoutes(directory?: string): ApiRouteHandler {
  return {
    matches: (url) => url.pathname === "/api/v1/uploads",
    async handle(request, response, url) {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendJson(response, 405, {
          error: { code: "method_not_allowed", message: "Use POST to upload files" },
        });
        return true;
      }
      const protocol = "encrypted" in request.socket && request.socket.encrypted ? "https" : "http";
      if (
        request.headers.origin &&
        request.headers.origin !== `${protocol}://${request.headers.host}`
      ) {
        sendJson(response, 403, {
          error: { code: "forbidden", message: "Cross-origin uploads are not allowed" },
        });
        return true;
      }
      const tooLarge = () =>
        new RequestBodyError(413, "body_too_large", "Files must be at most 20 MiB");
      if (Number(request.headers["content-length"]) > MAX_UPLOAD_BYTES) {
        request.resume();
        throw tooLarge();
      }
      const extension = extname(url.searchParams.get("filename") ?? "");
      const safeExtension = /^\.[a-zA-Z0-9]{1,16}$/.test(extension) ? extension : "";
      const path = join(await uploadDirectory(directory), `${randomUUID()}${safeExtension}`);
      const file = await open(path, "wx", 0o600);
      let complete = false;
      try {
        let bytes = 0;
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_UPLOAD_BYTES) {
            request.resume();
            throw tooLarge();
          }
          await file.writeFile(buffer);
        }
        if (!request.complete || request.aborted) throw new Error("Upload interrupted");
        await file.close();
        complete = true;
        sendJson(response, 201, { path });
      } finally {
        if (!complete) {
          await file.close().catch(() => undefined);
          await unlink(path);
        }
      }
      return true;
    },
    mapError: () => false,
  };
}

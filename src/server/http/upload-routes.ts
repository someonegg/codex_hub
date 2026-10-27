import { mkdir, readFile, realpath } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

import { isPreviewableUploadType, MAX_UPLOAD_BYTES } from "../../shared/uploads.js";
import type { SessionReader } from "../application/session-reader.js";
import { resolveHomeDirectory } from "../config.js";
import type { UploadStore } from "../uploads/store.js";
import type { ApiRouteHandler } from "./api-route-handler.js";
import { RequestBodyError } from "./request-body.js";
import { sendJson } from "./router.js";

const SESSION_UPLOAD_PATH = /^\/api\/v1\/sessions\/([^/]+)\/uploads(?:\/([^/]+)(\/content)?)?$/;

async function* uploadChunks(request: IncomingMessage): AsyncIterable<Uint8Array> {
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_UPLOAD_BYTES) {
      request.resume();
      throw new RequestBodyError(413, "body_too_large", "Files must be at most 20 MiB");
    }
    yield buffer;
  }
  if (!request.complete || request.aborted) throw new Error("Upload interrupted");
}

export async function uploadDirectory(
  configured = join(resolveHomeDirectory(), "uploads"),
): Promise<string> {
  await mkdir(configured, { recursive: true });
  return realpath(configured);
}
export function createUploadRoutes(
  store: UploadStore,
  sessions: Pick<SessionReader, "getSession">,
): ApiRouteHandler {
  return {
    matches: (url) => url.pathname === "/api/v1/uploads" || SESSION_UPLOAD_PATH.test(url.pathname),
    async handle(request, response, url) {
      const match = SESSION_UPLOAD_PATH.exec(url.pathname);
      const [, encodedSessionId, attachmentId, contentPath] = match ?? [];
      const id = match ? decodeURIComponent(encodedSessionId!) : url.searchParams.get("sessionId");
      if (!id) throw new RequestBodyError(400, "invalid_session", "sessionId is required");
      const method = request.method;
      if (method === "POST" || method === "DELETE") {
        const protocol =
          "encrypted" in request.socket && request.socket.encrypted ? "https" : "http";
        if (
          request.headers.origin &&
          request.headers.origin !== `${protocol}://${request.headers.host}`
        )
          throw new RequestBodyError(403, "forbidden", "Cross-origin uploads are not allowed");
      }
      let allowedMethod = "GET";
      if (!match) allowedMethod = "POST";
      else if (attachmentId && !contentPath) allowedMethod = "DELETE";
      if (method !== allowedMethod) {
        response.setHeader("Allow", allowedMethod);
        sendJson(response, 405, {
          error: { code: "method_not_allowed", message: "Method not allowed" },
        });
        return true;
      }
      if (!match) {
        if (Number(request.headers["content-length"]) > MAX_UPLOAD_BYTES) {
          request.resume();
          throw new RequestBodyError(413, "body_too_large", "Files must be at most 20 MiB");
        }
        if (!(await sessions.getSession(id)))
          throw new RequestBodyError(404, "not_found", "Session not found");
        const attachment = await store.upload(
          id,
          url.searchParams.get("filename") ?? "file",
          request.headers["content-type"] ?? "application/octet-stream",
          uploadChunks(request),
        );
        sendJson(response, 201, { ...attachment, attachment });
      } else if (!attachmentId) {
        if (!(await sessions.getSession(id)))
          throw new RequestBodyError(404, "not_found", "Session not found");
        sendJson(response, 200, { items: await store.list(id) });
      } else if (!contentPath) {
        await store.delete(id, attachmentId);
        sendJson(response, 200, { deleted: true });
      } else {
        const content = await (async () => {
          const attachment = await store.get(id, attachmentId);
          if (!attachment) return null;
          try {
            return { attachment, data: await readFile(attachment.path) };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        })();
        if (!content) throw new RequestBodyError(404, "not_found", "Attachment not found");
        const { attachment, data } = content;
        const preview =
          isPreviewableUploadType(attachment.type) && !url.searchParams.has("download");
        response.setHeader("Content-Type", preview ? attachment.type : "application/octet-stream");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader(
          "Content-Disposition",
          `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
        );
        response.end(data);
      }
      return true;
    },
    mapError: () => false,
  };
}

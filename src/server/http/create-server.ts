import { createReadStream, readFileSync, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server as NetServer } from "node:net";
import { extname, resolve, sep } from "node:path";

import type { ServerConfig } from "../config.js";
import { type ApiRouter, emptyApiRouter, sendJson } from "./router.js";
import { applySecurityHeaders } from "./security.js";
import type { ServerUpgradeHandler } from "./terminal-preview-websocket.js";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/vnd.microsoft.icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function sendText(
  response: ServerResponse,
  status: number,
  message: string,
  headOnly: boolean,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(message));
  response.end(headOnly ? undefined : message);
}

async function serveFile(
  response: ServerResponse,
  filePath: string,
  headOnly: boolean,
): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    response.statusCode = 200;
    response.setHeader(
      "Content-Type",
      CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
    );
    response.setHeader("Content-Length", info.size);
    if (headOnly) {
      response.end();
    } else {
      createReadStream(filePath)
        .on("error", () => response.destroy())
        .pipe(response);
    }
    return true;
  } catch {
    return false;
  }
}

export function createServer(
  config: ServerConfig,
  apiRouter: ApiRouter = emptyApiRouter,
  closeServices: () => void = () => {},
  upgrades?: ServerUpgradeHandler,
) {
  const clientRoot = realpathSync(config.clientDirectory);
  const clientRootPrefix = `${clientRoot}${sep}`;
  const requestListener: RequestListener = async (request, response) => {
    applySecurityHeaders(response, request);
    const headOnly = request.method === "HEAD";

    try {
      if (await apiRouter(request, response)) return;
      if (request.method !== "GET" && !headOnly) {
        response.setHeader("Allow", "GET, HEAD");
        sendJson(response, 405, {
          error: { code: "method_not_allowed", message: "Method is not allowed for this resource" },
        });
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const decodedPath = decodeURIComponent(url.pathname);
      const sessionPage = /^\/sessions\/[A-Za-z0-9_-]{20,100}\/?$/.test(decodedPath);
      const relativePath =
        decodedPath === "/" ? "index.html" : sessionPage ? "index.html" : decodedPath.slice(1);
      const requestedPath = resolve(clientRoot, relativePath);
      let canonicalPath: string;
      try {
        canonicalPath = await realpath(requestedPath);
      } catch {
        sendText(response, 404, "Not found", headOnly);
        return;
      }

      if (
        canonicalPath.startsWith(clientRootPrefix) &&
        (await serveFile(response, canonicalPath, headOnly))
      ) {
        return;
      }
      sendText(response, 404, "Not found", headOnly);
    } catch {
      sendJson(
        response,
        400,
        { error: { code: "bad_request", message: "Malformed request" } },
        headOnly,
      );
    }
  };

  if (!config.tls.enabled) {
    const server = createHttpServer(requestListener);
    return attachLifecycle(server, closeServices, upgrades);
  }

  const requireClientCertificate = config.tls.certificateAuthorityPath !== undefined;
  const server = createHttpsServer(
    {
      cert: readFileSync(config.tls.certificatePath),
      key: readFileSync(config.tls.privateKeyPath),
      ...(config.tls.certificateAuthorityPath
        ? { ca: readFileSync(config.tls.certificateAuthorityPath) }
        : {}),
      minVersion: "TLSv1.2",
      requestCert: requireClientCertificate,
      rejectUnauthorized: requireClientCertificate,
    },
    requestListener,
  );
  return attachLifecycle(server, closeServices, upgrades);
}

/** Own startup cleanup as well as the server's pre-drain shutdown hook. */
export async function startServer(
  config: ServerConfig,
  apiRouter: ApiRouter,
  closeServices: () => void,
  upgrades?: ServerUpgradeHandler,
) {
  try {
    const server = createServer(config, apiRouter, closeServices, upgrades);
    await listenServer(server, config.port, config.host);
    return server;
  } catch (error) {
    upgrades?.close();
    closeServices();
    throw error;
  }
}

export function listenServer(server: NetServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function attachLifecycle<T extends ReturnType<typeof createHttpServer>>(
  server: T,
  closeServices: () => void,
  upgrades?: ServerUpgradeHandler,
): T {
  server.on("upgrade", (request, socket, head) => {
    if (upgrades) upgrades.handle(request, socket, head);
    else socket.destroy();
  });
  const close = server.close.bind(server);
  const mutable = server as unknown as {
    close(callback?: (error?: Error) => void): T;
  };
  mutable.close = (callback?: (error?: Error) => void) => {
    upgrades?.close();
    closeServices();
    close(callback);
    return server;
  };
  return server;
}

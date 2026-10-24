import { writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  SessionInteractionError,
  type SessionInteractionService,
} from "../../src/server/interaction/interaction-service.js";
import { PREVIEW_SESSION_ID, startPreviewServer } from "../helpers/preview-websocket.js";
import { createTempDirectory } from "../helpers/temp-directories.js";
import {
  TEST_CA,
  TEST_CLIENT_CERTIFICATE,
  TEST_CLIENT_KEY,
  TEST_SERVER_CERTIFICATE,
  TEST_SERVER_KEY,
} from "./tls-fixtures.js";

const servers: Awaited<ReturnType<typeof startPreviewServer>>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
const snapshot = {
  type: "snapshot" as const,
  content: "pane",
  revision: "one",
  capturedAt: "now",
  truncated: false,
};
async function start(implementation?: SessionInteractionService["subscribePreview"]) {
  const release = vi.fn();
  const subscribePreview = vi.fn<SessionInteractionService["subscribePreview"]>(
    implementation ??
      (async (_session, frame) => {
        frame(snapshot);
        return release;
      }),
  );
  const server = await startPreviewServer({ subscribePreview });
  servers.push(server);
  return { ...server, subscribePreview, release };
}
function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}
function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

it("streams updates and cancels the subscription when the client leaves", async () => {
  const server = await start();
  const client = server.connect();
  await opened(client.socket);
  await vi.waitFor(() => expect(client.messages).toEqual([snapshot]));
  const [session, frame, , signal] = server.subscribePreview.mock.calls[0]!;
  expect(session).toBe(PREVIEW_SESSION_ID);
  expect(signal.aborted).toBe(false);
  const delta = {
    type: "delta" as const,
    baseRevision: "one",
    revision: "two",
    operations: [],
    truncated: true,
    capturedAt: "next",
  };
  frame(delta);
  await vi.waitFor(() => expect(client.messages).toEqual([snapshot, delta]));
  const close = closed(client.socket);
  client.socket.close();
  await close;
  await vi.waitFor(() => expect(server.release).toHaveBeenCalledOnce());
  expect(signal.aborted).toBe(true);
});

it.each([
  ["session_not_found", false],
  ["interaction_not_supported", false],
  ["interaction_not_connected", false],
  ["interaction_failed", true],
  ["operation_result_unknown", true],
] as const)("sends structured %s errors with retryable=%s", async (code, retryable) => {
  const server = await start(async () => {
    throw new SessionInteractionError(code, "failure");
  });
  const client = server.connect();
  const close = closed(client.socket);
  expect(await close).toBe(retryable ? 1013 : 1008);
  expect(client.messages).toEqual([{ type: "error", code, message: "failure", retryable }]);
});

it("reports unavailable interaction after upgrading", async () => {
  const server = await startPreviewServer();
  servers.push(server);
  const client = server.connect();
  const close = closed(client.socket);
  expect(await close).toBe(1008);
  expect(client.messages).toEqual([
    expect.objectContaining({ type: "error", code: "interaction_not_supported", retryable: false }),
  ]);
});

it.each([
  ["/api/v1/sessions/invalid/terminal-preview", undefined, 404],
  [`/api/v1/sessions/${PREVIEW_SESSION_ID}/terminal-preview?after=old`, undefined, 400],
  [`/api/v1/sessions/${PREVIEW_SESSION_ID}/terminal-preview?unexpected=1`, undefined, 400],
  [`/api/v1/sessions/${PREVIEW_SESSION_ID}/terminal-preview`, "https://other.example", 403],
] as const)("rejects invalid upgrade %s (%s)", async (path, origin, status) => {
  const server = await start();
  const socket = new WebSocket(`${server.base}${path}`, { origin });
  socket.on("error", () => {});
  const response = await new Promise<number>((resolve) => {
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode!);
    });
  });
  expect(response).toBe(status);
  expect(server.subscribePreview).not.toHaveBeenCalled();
});

it("accepts same-origin upgrades and advertises the exact WebSocket CSP source", async () => {
  const server = await start();
  const client = server.connect(undefined, { origin: server.origin });
  await opened(client.socket);
  await vi.waitFor(() => expect(client.messages).toHaveLength(1));
  const response = await fetch(server.origin);
  await response.arrayBuffer();
  expect(response.headers.get("content-security-policy")).toContain(
    `connect-src 'self' ${server.base}`,
  );
});

it("counts initializing subscriptions toward per-session limits and releases capacity", async () => {
  const server = await start(async () => new Promise(() => {}));
  const clients = Array.from({ length: 10 }, () => server.connect());
  await Promise.all(clients.map((client) => opened(client.socket)));
  const excess = server.connect();
  const close = closed(excess.socket);
  expect(await close).toBe(1013);
  expect(excess.messages).toEqual([
    expect.objectContaining({ code: "preview_capacity_exceeded", retryable: true }),
  ]);
  expect(server.subscribePreview).toHaveBeenCalledTimes(10);
  const released = closed(clients[0]!.socket);
  clients[0]!.socket.close();
  await released;
  const next = server.connect();
  await opened(next.socket);
  await vi.waitFor(() => expect(server.subscribePreview).toHaveBeenCalledTimes(11));
});

it("limits total connections across sessions, including initialization", async () => {
  const server = await start(async () => new Promise(() => {}));
  const clients = Array.from({ length: 100 }, (_, i) =>
    server.connect(`session-${String(i).padStart(20, "0")}`),
  );
  await Promise.all(clients.map((client) => opened(client.socket)));
  const excess = server.connect("session-excess-global-limit");
  expect(await closed(excess.socket)).toBe(1013);
  expect(excess.messages[0]).toMatchObject({ code: "preview_capacity_exceeded" });
  expect(server.subscribePreview).toHaveBeenCalledTimes(100);
});

it("cancels initialization and disposes a subscription that resolves after disconnect", async () => {
  let complete!: (close: () => void) => void;
  const server = await start(
    async () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const client = server.connect();
  await opened(client.socket);
  const close = closed(client.socket);
  client.socket.close();
  await close;
  const signal = server.subscribePreview.mock.calls[0]![3];
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  const release = vi.fn();
  complete(release);
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
});

it("closes slow consumers without queuing another frame", async () => {
  const server = await start();
  const client = server.connect();
  await opened(client.socket);
  await vi.waitFor(() => expect(client.messages).toHaveLength(1));
  const buffered = vi
    .spyOn(WebSocket.prototype, "bufferedAmount", "get")
    .mockReturnValue(2 * 1024 * 1024 + 1);
  const close = closed(client.socket);
  server.subscribePreview.mock.calls[0]![1]({ ...snapshot, revision: "two" });
  expect(await close).toBe(1013);
  expect(client.messages).toHaveLength(1);
  expect(server.subscribePreview.mock.calls[0]![3].aborted).toBe(true);
  buffered.mockRestore();
});

it("rejects application messages", async () => {
  const server = await start();
  const client = server.connect();
  await opened(client.socket);
  const close = closed(client.socket);
  client.socket.send("unexpected");
  expect(await close).toBe(1008);
  expect(server.subscribePreview.mock.calls[0]![3].aborted).toBe(true);
});

it("terminates heartbeat failures and cancels their subscriptions", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const server = await start();
  const client = server.connect(undefined, { autoPong: false });
  await opened(client.socket);
  const ping = new Promise<void>((resolve) => client.socket.once("ping", () => resolve()));
  await vi.advanceTimersByTimeAsync(30_000);
  await ping;
  const close = closed(client.socket);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await close).toBe(1006);
  expect(server.subscribePreview.mock.calls[0]![3].aborted).toBe(true);
});

it("keeps responsive idle connections alive", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const server = await start();
  const client = server.connect();
  await opened(client.socket);
  for (let i = 0; i < 3; i++) {
    const ping = new Promise<void>((resolve) => client.socket.once("ping", () => resolve()));
    await vi.advanceTimersByTimeAsync(30_000);
    await ping;
    // Let the automatically generated pong reach the server.
    for (let j = 0; j < 4; j++) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(client.socket.readyState).toBe(WebSocket.OPEN);
});

it("closes live WebSockets before completing HTTP shutdown", async () => {
  const server = await start();
  const client = server.connect();
  await opened(client.socket);
  const close = closed(client.socket);
  servers.pop();
  await server.close();
  expect(await close).toBe(1001);
  expect(server.subscribePreview.mock.calls[0]![3].aborted).toBe(true);
  expect(server.release).toHaveBeenCalledOnce();
});

it("forces unresponsive close handshakes to terminate after one second", async () => {
  const server = await start();
  const url = new URL(server.origin);
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  try {
    const upgraded = new Promise<void>((resolve) => {
      let headers = "";
      socket.on("data", (data) => {
        headers += data.toString();
        if (headers.includes("HTTP/1.1 101")) resolve();
      });
    });
    socket.write(
      [
        `GET /api/v1/sessions/${PREVIEW_SESSION_ID}/terminal-preview HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"),
    );
    await upgraded;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    servers.pop();
    let done = false;
    const stopped = server.close().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    expect(server.subscribePreview.mock.calls[0]![3].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(done).toBe(true);
  } finally {
    socket.destroy();
  }
});

it.each([false, true])(
  "serves WSS through the configured TLS server (mTLS: %s)",
  async (mutual) => {
    const directory = await createTempDirectory("codex-preview-tls-");
    const certificatePath = join(directory, "server.pem"),
      privateKeyPath = join(directory, "server.key"),
      certificateAuthorityPath = join(directory, "ca.pem");
    await Promise.all([
      writeFile(certificatePath, TEST_SERVER_CERTIFICATE),
      writeFile(privateKeyPath, TEST_SERVER_KEY),
      writeFile(certificateAuthorityPath, TEST_CA),
    ]);
    const server = await startPreviewServer(
      {
        subscribePreview: async (_id, frame) => {
          frame(snapshot);
          return () => {};
        },
      },
      {
        enabled: true,
        certificatePath,
        privateKeyPath,
        ...(mutual ? { certificateAuthorityPath } : {}),
      },
    );
    servers.push(server);
    const client = server.connect(undefined, {
      ca: TEST_CA,
      origin: server.origin,
      ...(mutual ? { cert: TEST_CLIENT_CERTIFICATE, key: TEST_CLIENT_KEY } : {}),
    });
    await opened(client.socket);
    await vi.waitFor(() => expect(client.messages).toEqual([snapshot]));
    if (mutual) {
      const unauthenticated = server.connect(undefined, { ca: TEST_CA });
      await expect(opened(unauthenticated.socket)).rejects.toThrow();
    }
  },
);

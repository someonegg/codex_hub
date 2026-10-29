import { expect, it } from "vitest";

import { commandFailure } from "../../src/server/cli/command-error.js";
import { SessionClient } from "../../src/server/cli/session-client.js";
import { startHttpServer } from "../helpers/http-server.js";

it("sends JSON with a byte-accurate length and tracks writes across later queries", async () => {
  const { base } = await startHttpServer(
    async (req, res) => {
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        expect(req.headers["content-type"]).toBe("application/json");
        expect(Number(req.headers["content-length"])).toBe(body.length);
        expect(JSON.parse(body.toString())).toEqual({ message: "你好" });
        res.writeHead(204).end();
      } else {
        res.writeHead(404).end(JSON.stringify({ error: { code: "session_not_found" } }));
      }
      return true;
    },
    () => {},
  );
  const client = new SessionClient(new URL(base), new AbortController().signal);
  expect(client.mutationSubmitted).toBe(false);
  await expect(client.request("/api/write", "POST", { message: "你好" })).resolves.toBeUndefined();
  expect(client.mutationSubmitted).toBe(true);
  await expect(client.request("/api/read")).rejects.toMatchObject({
    code: "operation_result_unknown",
    exitCode: 2,
  });
});

it("keeps backend unknown errors on read-only requests as definite query failures", async () => {
  const { base } = await startHttpServer(
    async (_req, res) => {
      res.writeHead(504).end(
        JSON.stringify({
          error: { code: "operation_result_unknown", message: "capture timed out" },
        }),
      );
      return true;
    },
    () => {},
  );
  const client = new SessionClient(new URL(base), new AbortController().signal);
  await expect(client.request("/api/terminal")).rejects.toMatchObject({
    code: "request_failed",
    message: "capture timed out",
    exitCode: 1,
  });
  expect(client.mutationSubmitted).toBe(false);
});

it("does not mark a write submitted when the shared signal is already aborted", async () => {
  const client = new SessionClient(new URL("http://127.0.0.1:1"), AbortSignal.abort());
  const error = await client.request("/api/write", "POST", {}).catch((error: unknown) => error);
  expect(client.mutationSubmitted).toBe(false);
  expect(commandFailure(error, client.mutationSubmitted)).toMatchObject({ exitCode: 1 });
});

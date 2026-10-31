import { request } from "node:http";
import { request as secureRequest } from "node:https";

import { httpFailure } from "./command-error.js";

/** Invocation-scoped HTTP state; submitted writes are never retried. */
export class SessionClient {
  mutationSubmitted = false;

  constructor(
    private readonly base: URL,
    private readonly signal: AbortSignal,
  ) {}

  readonly request = async <T>(path: string, method = "GET", body?: object): Promise<T> => {
    if (this.signal.aborted) throw new Error("Command interrupted or timed out");
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((accept, reject) => {
      const sendRequest = this.base.protocol === "https:" ? secureRequest : request;
      const req = sendRequest(
        new URL(path, this.base),
        {
          method,
          signal: this.signal,
          headers:
            payload === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(payload),
                },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            try {
              const text = Buffer.concat(chunks).toString("utf8");
              const data = text ? JSON.parse(text) : undefined;
              const status = res.statusCode ?? 500;
              if (status >= 400) {
                reject(httpFailure(status, method, data?.error, this.mutationSubmitted));
              } else accept(data as T);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      if (method !== "GET") this.mutationSubmitted = true;
      req.end(payload);
    });
  };
}

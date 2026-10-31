import { homedir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/server/config.js";

function runnable(args: readonly string[]) {
  const result = loadConfig(args);
  if (result.kind !== "run") throw new Error("Expected runnable configuration");
  return result.config;
}

describe("server command line", () => {
  it("uses local, non-TLS defaults", () => {
    expect(runnable([])).toMatchObject({
      host: "127.0.0.1",
      port: 4173,
      homes: [{ nickname: "default", path: resolve(homedir(), ".codex") }],
      tls: { enabled: false },
      interactionEnabled: true,
      uploadDirectory: resolve(homedir(), ".codex-hub/uploads"),
    });
  });

  it("parses all server and mutual TLS options", () => {
    expect(
      runnable([
        "--codex-home",
        "personal=fixtures/codex",
        "--host",
        "0.0.0.0",
        "--port",
        "0",
        "--ssl",
        "--ssl-cert",
        "certs/server.pem",
        "--ssl-key",
        "certs/server-key.pem",
        "--ssl-ca",
        "certs/ca.pem",
      ]),
    ).toMatchObject({
      host: "0.0.0.0",
      port: 0,
      homes: [{ nickname: "personal", path: resolve("fixtures/codex") }],
      tls: {
        enabled: true,
        certificatePath: resolve("certs/server.pem"),
        privateKeyPath: resolve("certs/server-key.pem"),
        certificateAuthorityPath: resolve("certs/ca.pem"),
      },
    });
  });

  it("rejects incomplete and unused TLS options", () => {
    expect(() => loadConfig(["--ssl"])).toThrow("--ssl requires both --ssl-cert and --ssl-key");
    expect(() => loadConfig(["--ssl-cert", "server.pem"])).toThrow("require --ssl");
    expect(() => loadConfig(["--ssl-ca", "ca.pem"])).toThrow("require --ssl");
  });

  it("rejects malformed general options", () => {
    expect(() => loadConfig(["--port", "65536"])).toThrow("--port must be an integer");
    expect(() => loadConfig(["--unknown"])).toThrow();
    expect(() => loadConfig(["--tmux-socket", " "])).toThrow("--tmux-socket must not be empty");
    expect(() => loadConfig(["positional"])).toThrow();
  });
});

it("resolves upload directories and rejects empty configuration", () => {
  const config = runnable(["--home-dir", "uploads with spaces"]);
  expect(config.uploadDirectory).toBe(resolve("uploads with spaces", "uploads"));
  expect(() => loadConfig(["--home-dir", " "])).toThrow("--home-dir must not be empty");
});

it("resolves hosting directories and reports their own option name for empty values", () => {
  expect(runnable(["--hosting", "--home-dir", "web pages"]).hostingDirectory).toBe(
    resolve("web pages", "hosting"),
  );
  expect(() => loadConfig(["--hosting", "--home-dir", " "])).toThrow(
    "--home-dir must not be empty",
  );
});

it("shares the Hub root for uploads and hosting, expanding home-relative paths", () => {
  expect(runnable(["--hosting"])).toMatchObject({
    uploadDirectory: resolve(homedir(), ".codex-hub/uploads"),
    hostingDirectory: resolve(homedir(), ".codex-hub/hosting"),
  });
  expect(runnable(["--hosting", "--home-dir", "~/hub-data"])).toMatchObject({
    uploadDirectory: resolve(homedir(), "hub-data/uploads"),
    hostingDirectory: resolve(homedir(), "hub-data/hosting"),
  });
});

it.each(["-1", "65536", "1.5", "invalid"])(
  "names --local-port in invalid port errors (%s)",
  (value) => {
    expect(() => loadConfig([`--local-port=${value}`])).toThrow(
      "--local-port must be an integer between 0 and 65535",
    );
  },
);

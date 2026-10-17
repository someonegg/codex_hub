import { homedir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { commandLineHelp, loadConfig } from "../../src/server/config.js";

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
      codexHome: resolve(homedir(), ".codex"),
      tls: { enabled: false },
      interactionEnabled: true,
    });
  });

  it("resolves an explicit tmux socket", () => {
    expect(runnable(["--tmux-socket", "./tmux.sock"]).tmuxSocket).toBe(resolve("tmux.sock"));
    expect(commandLineHelp()).toContain("--tmux-socket");
  });

  it("parses all server and mutual TLS options", () => {
    expect(
      runnable([
        "--codex-home",
        "fixtures/codex",
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
      codexHome: resolve("fixtures/codex"),
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
    expect(() => loadConfig(["--codex-home", " "])).toThrow("--codex-home must not be empty");
    expect(() => loadConfig(["--unknown"])).toThrow();
    expect(() => loadConfig(["--tmux-socket", " "])).toThrow("--tmux-socket must not be empty");
    expect(() => loadConfig(["positional"])).toThrow();
  });

  it("returns help without requiring runtime options", () => {
    expect(loadConfig(["--help"])).toEqual({ kind: "help" });
    expect(commandLineHelp()).toContain("--ssl-ca <path>");
    expect(commandLineHelp()).toContain("npm start -- --ssl");
  });
});

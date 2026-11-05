import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export function resolveHomeDirectory(value?: string): string {
  return value === undefined
    ? resolve(homedir(), ".codex-hub")
    : resolveDirectoryOption("home-dir", value);
}

export const LOOPBACK_HOST = "127.0.0.1" as const;

export type ServerTlsConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly certificatePath: string;
      readonly privateKeyPath: string;
      readonly certificateAuthorityPath?: string;
    };

export interface SessionHomeConfig {
  nickname: string;
  path: string;
  adapter?: "codex" | "claude";
}

/** Backwards-compatible name for callers configuring Codex-only homes. */
export type CodexHomeConfig = SessionHomeConfig;

export interface ServerConfig {
  homes: SessionHomeConfig[];
  host: string;
  port: number;
  localPort?: number;
  clientDirectory: string;
  tls: ServerTlsConfig;
  interactionEnabled: boolean;
  tmuxSocket?: string;
  uploadDirectory?: string;
  hostingDirectory?: string;
}

export type CommandLineResult =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "run"; readonly config: ServerConfig };

function nonEmptyOption(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`--${name} must not be empty`);
  }
  return normalized;
}

function parsePort(value: string | undefined, option = "port"): number {
  if (value === undefined) return 4173;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`--${option} must be an integer between 0 and 65535`);
  }
  return port;
}

export function loadConfig(args: readonly string[] = process.argv.slice(2)): CommandLineResult {
  const { values, tokens } = parseArgs({
    tokens: true,
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      "codex-home": { type: "string", multiple: true },
      "claude-home": { type: "string", multiple: true },
      host: { type: "string" },
      port: { type: "string" },
      "local-port": { type: "string" },
      ssl: { type: "boolean" },
      "ssl-cert": { type: "string" },
      "ssl-key": { type: "string" },
      "ssl-ca": { type: "string" },
      help: { type: "boolean" },
      version: { type: "boolean" },
      "tmux-socket": { type: "string" },
      "home-dir": { type: "string" },
      hosting: { type: "boolean" },
    },
  });

  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };

  const host = nonEmptyOption("host", values.host) ?? LOOPBACK_HOST;
  const names = new Set<string>();
  const paths = new Set<string>();
  let entries = tokens.flatMap((token) =>
    token.kind === "option" && (token.name === "codex-home" || token.name === "claude-home")
      ? [{ option: token.name, value: token.value! }]
      : [],
  );
  if (entries.length === 0) {
    entries = [
      { option: "codex-home", value: "codex=~/.codex" },
      { option: "claude-home", value: "claude=~/.claude" },
    ];
    try {
      statSync(resolve(homedir(), ".codex"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries.reverse();
    }
  }
  const homes = entries.map(({ option, value }) => ({
    ...parseHome(value, option, names, paths),
    ...(option === "claude-home" ? { adapter: "claude" as const } : {}),
  }));
  const certificatePath = nonEmptyOption("ssl-cert", values["ssl-cert"]);
  const privateKeyPath = nonEmptyOption("ssl-key", values["ssl-key"]);
  const certificateAuthorityPath = nonEmptyOption("ssl-ca", values["ssl-ca"]);

  let tls: ServerTlsConfig;
  if (values.ssl) {
    if (!certificatePath || !privateKeyPath) {
      throw new Error("--ssl requires both --ssl-cert and --ssl-key");
    }
    tls = {
      enabled: true,
      certificatePath: resolve(certificatePath),
      privateKeyPath: resolve(privateKeyPath),
      ...(certificateAuthorityPath
        ? { certificateAuthorityPath: resolve(certificateAuthorityPath) }
        : {}),
    };
  } else {
    if (certificatePath || privateKeyPath || certificateAuthorityPath) {
      throw new Error("--ssl-cert, --ssl-key, and --ssl-ca require --ssl");
    }
    tls = { enabled: false };
  }

  return {
    kind: "run",
    config: {
      host,
      port: parsePort(values.port),
      ...(values["local-port"] !== undefined
        ? { localPort: parsePort(values["local-port"], "local-port") }
        : {}),
      homes,
      clientDirectory: fileURLToPath(new URL("../../client/", import.meta.url)),
      tls,
      interactionEnabled: true,
      uploadDirectory: resolve(resolveHomeDirectory(values["home-dir"]), "uploads"),
      ...(values.hosting
        ? { hostingDirectory: resolve(resolveHomeDirectory(values["home-dir"]), "hosting") }
        : {}),
      ...(values["tmux-socket"] !== undefined
        ? { tmuxSocket: resolve(nonEmptyOption("tmux-socket", values["tmux-socket"])!) }
        : {}),
    },
  };
}

export function commandLineHelp(): string {
  return `Usage: codex-hub [options]

Options:
  --hosting            Enable trusted same-origin static web hosting
  --home-dir <path>    Hub data root (default: ~/.codex-hub; uploads/ and hosting/)
  --codex-home <nickname=path>
                       Codex home; repeat for multiple homes
  --claude-home <nickname=path>
                       Claude Code home; repeat for multiple homes
  Default homes: codex=~/.codex, claude=~/.claude (Claude first if ~/.codex is absent).
  Any explicit home replaces both defaults; argument order determines the default home.
  --host <host>        Listen host (default: 127.0.0.1)
  --port <port>        Listen port, or 0 for a free port (default: 4173)
  --local-port <port>  Additional HTTP listener on 127.0.0.1 (disabled by default)
  --ssl                Enable TLS; the port will accept HTTPS only
  --ssl-cert <path>    PEM server certificate or certificate chain
  --ssl-key <path>     PEM server private key
  --ssl-ca <path>      PEM CA bundle; enables mandatory client certificates
  --tmux-socket <path> tmux socket (default: tmux default selection)
  --help               Show this help
  --version            Show the current version

TLS example:
  codex-hub --ssl --ssl-cert server.crt --ssl-key server.key

mTLS example:
  codex-hub --ssl --ssl-cert server.crt --ssl-key server.key --ssl-ca ca.crt`;
}

function parseHome(
  value: string,
  option: string,
  names: Set<string>,
  paths: Set<string>,
): SessionHomeConfig {
  const separator = value.indexOf("=");
  const nickname = value.slice(0, separator).trim();
  const homePath = value.slice(separator + 1).trim();
  if (separator < 0 || !nickname || !homePath) {
    throw new Error(`--${option} requires nickname=path with a non-empty nickname and path`);
  }
  const path = resolve(
    homePath.startsWith("~/") ? resolve(homedir(), homePath.slice(2)) : homePath,
  );
  let canonical = path;
  try {
    canonical = realpathSync(path);
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        ["ENOENT", "EACCES", "EPERM"].includes(String(error.code))
      )
    )
      throw error;
  }
  if (names.has(nickname)) throw new Error(`Duplicate home nickname: ${nickname}`);
  if (paths.has(canonical)) throw new Error("Duplicate home path");
  names.add(nickname);
  paths.add(canonical);
  return { nickname, path };
}

function resolveDirectoryOption(name: string, value: string): string {
  const path = nonEmptyOption(name, value)!;
  return resolve(path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
}

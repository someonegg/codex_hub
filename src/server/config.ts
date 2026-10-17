import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

export const LOOPBACK_HOST = "127.0.0.1" as const;

export type ServerTlsConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly certificatePath: string;
      readonly privateKeyPath: string;
      readonly certificateAuthorityPath?: string;
    };

export interface ServerConfig {
  host: string;
  port: number;
  codexHome: string;
  clientDirectory: string;
  tls: ServerTlsConfig;
  interactionEnabled: boolean;
  tmuxSocket?: string;
}

export type CommandLineResult =
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly config: ServerConfig };

function nonEmptyOption(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`--${name} must not be empty`);
  }
  return normalized;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 4173;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  return port;
}

export function loadConfig(args: readonly string[] = process.argv.slice(2)): CommandLineResult {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      "codex-home": { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      ssl: { type: "boolean" },
      "ssl-cert": { type: "string" },
      "ssl-key": { type: "string" },
      "ssl-ca": { type: "string" },
      help: { type: "boolean" },
      "tmux-socket": { type: "string" },
    },
  });

  if (values.help) return { kind: "help" };

  const host = nonEmptyOption("host", values.host) ?? LOOPBACK_HOST;
  const codexHome = nonEmptyOption("codex-home", values["codex-home"]);
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
      codexHome: codexHome ? resolve(codexHome) : resolve(homedir(), ".codex"),
      clientDirectory: resolve(process.cwd(), "dist/client"),
      tls,
      interactionEnabled: true,
      ...(values["tmux-socket"] !== undefined
        ? { tmuxSocket: resolve(nonEmptyOption("tmux-socket", values["tmux-socket"])!) }
        : {}),
    },
  };
}

export function commandLineHelp(): string {
  return `Usage: npm start -- [options]

Options:
  --codex-home <path>  Codex home directory (default: ~/.codex)
  --host <host>        Listen host (default: 127.0.0.1)
  --port <port>        Listen port, or 0 for a free port (default: 4173)
  --ssl                Enable TLS; the port will accept HTTPS only
  --ssl-cert <path>    PEM server certificate or certificate chain
  --ssl-key <path>     PEM server private key
  --ssl-ca <path>      PEM CA bundle; enables mandatory client certificates
  --tmux-socket <path> tmux socket (default: tmux default selection)
  --help               Show this help

TLS example:
  npm start -- --ssl --ssl-cert server.crt --ssl-key server.key

mTLS example:
  npm start -- --ssl --ssl-cert server.crt --ssl-key server.key --ssl-ca ca.crt`;
}

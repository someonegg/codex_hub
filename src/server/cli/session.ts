import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  type HubOperation,
  type InspectResponse,
  INTERACTION_KEYS,
  MAX_INTERACTION_KEY_SEQUENCE_LENGTH,
  MAX_INTERACTION_MESSAGE_BYTES,
  type SessionListResponse,
  type TerminalResponse,
  type TmuxTarget,
} from "../../shared/api-contract.js";
import { normalizeMessage } from "../interaction/message.js";
import { CommandError, commandFailure } from "./command-error.js";
import { output, outputFailure } from "./output.js";
import { SessionClient } from "./session-client.js";
import { followInspect } from "./session-follow.js";
import {
  type CliResult,
  formatResult,
  mapInspect,
  mapList,
  mapTerminal,
} from "./session-output.js";
import { waitForLaunch, waitForOperation } from "./session-wait.js";

export const sessionHelp = `Usage: ahub-cli session <command> [options]
  list [--project <directory>]
  create --project <directory> [--cwd <directory>] [--home <nickname>] [--worktree] [--yolo]
  resume <id> [--yolo]
  send <id> (--message <text> | --stdin)
  inspect <id> [--limit 1-300] [--after <number>] [--follow [--interval <seconds>] [--count <N>]]
  terminal <id>
  keys <id> <key...>
  interrupt <id>
  handoff <id>
  exit <id> | archive <id> | delete <id>
Options: --url <http-url> --json --timeout <seconds> (default 15; create/resume/exit/archive/delete: 45)
Follow: timeout applies to each HTTP request; observation continues until stopped.
Address: --url, CODEX_HUB_URL, http://127.0.0.1:4173
Messages: update indicates progress; response indicates a reply, not verified task completion.
Input: send/keys require connected and idle; while working, observe or interrupt first.
Keys: ${INTERACTION_KEYS.filter((key) => key !== "interrupt").join(", ")}
Completion: idle/response do not end --follow; verify results before exit/archive/delete.`;

export function parseSessionArguments(args: string[], environmentUrl?: string) {
  const { values, positionals } = validateArguments(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: {
        url: { type: "string" },
        json: { type: "boolean" },
        timeout: { type: "string" },
        project: { type: "string" },
        cwd: { type: "string" },
        home: { type: "string" },
        worktree: { type: "boolean" },
        yolo: { type: "boolean" },
        message: { type: "string" },
        stdin: { type: "boolean" },
        limit: { type: "string" },
        after: { type: "string" },
        follow: { type: "boolean" },
        interval: { type: "string" },
        count: { type: "string" },
        help: { type: "boolean" },
      },
    }),
  );
  if (values.help || positionals.length === 0) {
    return { values, positionals, help: true as const };
  }
  const [command, id, ...keys] = positionals;
  const allowed: Record<string, string[]> = {
    list: ["project"],
    create: ["cwd", "project", "home", "worktree", "yolo"],
    resume: ["yolo"],
    send: ["message", "stdin"],
    inspect: ["limit", "after", "follow", "interval", "count"],
    terminal: [],
    keys: [],
    interrupt: [],
    handoff: [],
    exit: [],
    archive: [],
    delete: [],
  };
  if (!Object.hasOwn(allowed, command))
    throw new CommandError("invalid_arguments", "Unknown session command");
  for (const key of Object.keys(values)) {
    if (!["url", "json", "timeout", "help", ...allowed[command]!].includes(key))
      throw new CommandError("invalid_arguments", `--${key} is not supported by ${command}`);
  }
  const acceptsSessionId = command !== "list" && command !== "create";
  const invalidPositionals = acceptsSessionId
    ? !id || (command !== "keys" && positionals.length !== 2)
    : positionals.length !== 1;
  if (invalidPositionals)
    throw new CommandError("invalid_arguments", "Invalid session command arguments");
  if (command === "create" && !values.project)
    throw new CommandError("invalid_arguments", "create requires --project");
  if (
    command === "send" &&
    Number(values.message !== undefined) + Number(values.stdin === true) !== 1
  )
    throw new CommandError(
      "invalid_arguments",
      "send requires exactly one of --message and --stdin",
    );
  if (
    command === "keys" &&
    (keys.length === 0 ||
      keys.length > MAX_INTERACTION_KEY_SEQUENCE_LENGTH ||
      keys.some(
        (key) => key === "interrupt" || !(INTERACTION_KEYS as readonly string[]).includes(key),
      ))
  )
    throw new CommandError(
      "invalid_arguments",
      "Unsupported key sequence; use session interrupt for interruption",
    );
  const defaultSeconds = ["create", "resume", "exit", "archive", "delete"].includes(command)
    ? 45
    : 15;
  const seconds = values.timeout === undefined ? defaultSeconds : Number(values.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647)
    throw new CommandError(
      "invalid_arguments",
      "timeout must be a positive number of seconds within the supported range",
    );
  const base = validateArguments(
    () => new URL(values.url ?? environmentUrl ?? "http://127.0.0.1:4173"),
  );
  if (base.protocol !== "http:")
    throw new CommandError(
      "invalid_arguments",
      "Only HTTP URLs are supported; HTTPS is not supported yet",
    );
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/")
    throw new CommandError("invalid_arguments", "URL must contain only an HTTP origin");

  if ((values.interval !== undefined || values.count !== undefined) && !values.follow)
    throw new CommandError("invalid_arguments", "--interval and --count require --follow");
  if (
    values.interval !== undefined &&
    (!Number.isFinite(Number(values.interval)) || Number(values.interval) <= 0)
  )
    throw new CommandError("invalid_arguments", "interval must be a finite positive number");
  if (
    values.count !== undefined &&
    (!/^\d+$/.test(values.count) ||
      !Number.isSafeInteger(Number(values.count)) ||
      Number(values.count) < 1)
  )
    throw new CommandError("invalid_arguments", "count must be a positive safe integer");
  if (command === "inspect") {
    for (const name of ["limit", "after"] as const) {
      const value = values[name];
      if (value === undefined) continue;
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        (name === "limit" && (Number(value) < 1 || Number(value) > 300))
      )
        throw new CommandError("invalid_arguments", `Invalid ${name}`);
    }
  }
  if (command === "send" && values.message !== undefined)
    validateArguments(() => normalizeMessage(values.message!));
  return { values, positionals, command, id, keys, seconds, base, help: false as const };
}

/** One invocation owns one deadline and never retries a submitted mutation. */
export async function runSessionCommand(args: string[]): Promise<void> {
  let json = args.includes("--json");
  let client: SessionClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let following = false;
  let launchDiagnostics: { sessionId: string | null; tmux: TmuxTarget | null } | undefined;
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const parsed = parseSessionArguments(args, process.env.CODEX_HUB_URL);
    const { values } = parsed;
    json = values.json ?? false;
    if (parsed.help) {
      console.log(sessionHelp);
      return;
    }
    const { command, id, keys, seconds, base } = parsed;
    following = values.follow === true;
    if (!following) timer = setTimeout(() => abort.abort(), seconds * 1000);
    client = new SessionClient(base, abort.signal);
    const api = client.request;
    const path = `/api/v1/sessions/${encodeURIComponent(id ?? "")}`;
    let result: CliResult;
    if (command === "list") {
      const list = await api<SessionListResponse>("/api/v1/sessions");
      const project = values.project === undefined ? undefined : resolve(values.project);
      result = mapList(list, project);
    } else if (command === "inspect") {
      const query = new URLSearchParams();
      for (const name of ["limit", "after"] as const) {
        if (values[name] !== undefined) query.set(name, values[name]);
      }
      if (following) {
        await followInspect({
          path,
          query,
          base,
          signal: abort.signal,
          timeoutMs: seconds * 1000,
          intervalMs: Number(values.interval ?? 3) * 1000,
          count: values.count === undefined ? undefined : Number(values.count),
          json,
        });
        return;
      }
      result = mapInspect(await api<InspectResponse>(`${path}/inspect?${query}`));
    } else if (command === "terminal")
      result = mapTerminal(await api<TerminalResponse>(`${path}/terminal`));
    else if (["send", "keys", "interrupt", "handoff"].includes(command)) {
      if (command === "send") {
        const input = values.stdin ? await readStdin(abort.signal) : values.message!;
        const message = validateArguments(() => normalizeMessage(input));
        await api(`${path}/messages`, "POST", { message, requireIdle: true });
      } else if (command === "handoff") await api(`${path}/handoff-pane-binding`, "POST", {});
      else
        await api(
          `${path}/keys`,
          "POST",
          command === "interrupt" ? { keys: ["interrupt"] } : { keys, requireIdle: true },
        );
      result = { sessionId: id!, status: "sent" };
    } else {
      const launch = command === "create" || command === "resume";
      let operationPath = command === "delete" ? path : `${path}/${command}`;
      let body: object = {};
      if (command === "create") {
        operationPath = "/api/v1/sessions";
        body = {
          projectDirectory: resolve(values.project!),
          ...(values.cwd === undefined ? {} : { workingDirectory: resolve(values.cwd) }),
          worktree: values.worktree ?? false,
          yolo: values.yolo ?? false,
          ...(values.home === undefined ? {} : { home: values.home }),
          requestId: randomUUID(),
        };
      } else if (command === "resume") {
        operationPath = "/api/v1/sessions";
        body = { resumeSessionId: id, yolo: values.yolo ?? false, requestId: randomUUID() };
      }
      if (launch) launchDiagnostics = { sessionId: command === "resume" ? id! : null, tmux: null };
      let operation = await api<HubOperation>(
        operationPath,
        command === "delete" ? "DELETE" : "POST",
        body,
      );
      operation = await waitForOperation(operation, api, abort.signal, (current) => {
        if (launchDiagnostics) {
          launchDiagnostics.sessionId = current.sessionId ?? launchDiagnostics.sessionId;
          if (current.target)
            launchDiagnostics.tmux = {
              socketPath: current.target.socketPath,
              paneId: current.target.paneId,
              sessionName: current.target.sessionName ?? null,
            };
        }
      });
      if (launch) await waitForLaunch(operation.sessionId, api, abort.signal);
      result = {
        sessionId: operation.sessionId,
        status: "succeeded",
        ...(launch ? { tmux: launchDiagnostics?.tmux ?? null } : {}),
      };
    }
    output(result, json, json ? "" : formatResult(command, result));
  } catch (error) {
    if (following && abort.signal.aborted) return;
    const failure = commandFailure(error, client?.mutationSubmitted ?? false);
    if (launchDiagnostics) failure.diagnostics = launchDiagnostics;
    outputFailure(failure, json);
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

async function readStdin(signal: AbortSignal): Promise<string> {
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      process.stdin.removeListener("data", data);
      process.stdin.removeListener("end", end);
      process.stdin.removeListener("error", fail);
      signal.removeEventListener("abort", stop);
      process.stdin.pause();
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const stop = () => fail(new Error("Command interrupted or timed out"));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_INTERACTION_MESSAGE_BYTES * 2)
        fail(
          new CommandError(
            "invalid_arguments",
            `Message exceeds ${MAX_INTERACTION_MESSAGE_BYTES / 1024} KiB`,
          ),
        );
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      accept(Buffer.concat(chunks).toString("utf8"));
    };
    if (signal.aborted) {
      stop();
      return;
    }
    process.stdin.on("data", data).once("end", end).once("error", fail);
    signal.addEventListener("abort", stop, { once: true });
  });
}

function validateArguments<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw new CommandError(
      "invalid_arguments",
      error instanceof Error ? error.message : String(error),
    );
  }
}

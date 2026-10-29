import { randomUUID } from "node:crypto";
import { request } from "node:http";
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
} from "../../shared/api-contract.js";
import type { TimelineItem } from "../../shared/domain.js";
import { normalizeMessage } from "../interaction/message.js";

export const sessionHelp = `Usage: codex-hub session <command> [options]
  list [--project <directory>]
  create --project <directory> [--home <nickname>] [--worktree] [--yolo]
  resume <id> [--yolo]
  send <id> (--message <text> | --stdin)
  inspect <id> [--limit 1-300] [--after <number>]
  terminal <id>
  keys <id> <key...>
  interrupt <id>
  handoff <id>
  exit <id> | archive <id> | delete <id>
Options: --url <http-url> --json --timeout <seconds> (default 360)
Address: --url, CODEX_HUB_URL, http://127.0.0.1:4173
Keys: ${INTERACTION_KEYS.filter((key) => key !== "interrupt").join(", ")}`;

class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

/** One invocation owns one deadline and never retries a submitted mutation. */
export async function runSessionCommand(args: string[]): Promise<void> {
  let json = args.includes("--json");
  let mutationSubmitted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        url: { type: "string" },
        json: { type: "boolean" },
        timeout: { type: "string" },
        project: { type: "string" },
        home: { type: "string" },
        worktree: { type: "boolean" },
        yolo: { type: "boolean" },
        message: { type: "string" },
        stdin: { type: "boolean" },
        limit: { type: "string" },
        after: { type: "string" },
        help: { type: "boolean" },
      },
    });
    json = values.json ?? false;
    if (values.help || positionals.length === 0) {
      console.log(sessionHelp);
      return;
    }
    const [command, id, ...keys] = positionals;
    const allowed: Record<string, string[]> = {
      list: ["project"],
      create: ["project", "home", "worktree", "yolo"],
      resume: ["yolo"],
      send: ["message", "stdin"],
      inspect: ["limit", "after"],
      terminal: [],
      keys: [],
      interrupt: [],
      handoff: [],
      exit: [],
      archive: [],
      delete: [],
    };
    if (!Object.hasOwn(allowed, command)) throw new Error("Unknown session command");
    for (const key of Object.keys(values)) {
      if (!["url", "json", "timeout", "help", ...allowed[command]!].includes(key))
        throw new Error(`--${key} is not supported by ${command}`);
    }
    const acceptsSessionId = command !== "list" && command !== "create";
    const invalidPositionals = acceptsSessionId
      ? !id || (command !== "keys" && positionals.length !== 2)
      : positionals.length !== 1;
    if (invalidPositionals) throw new Error("Invalid session command arguments");
    if (command === "create" && !values.project) throw new Error("create requires --project");
    if (
      command === "send" &&
      Number(values.message !== undefined) + Number(values.stdin === true) !== 1
    )
      throw new Error("send requires exactly one of --message and --stdin");
    if (
      command === "keys" &&
      (keys.length === 0 ||
        keys.length > MAX_INTERACTION_KEY_SEQUENCE_LENGTH ||
        keys.some(
          (key) => key === "interrupt" || !(INTERACTION_KEYS as readonly string[]).includes(key),
        ))
    )
      throw new Error("Unsupported key sequence; use session interrupt for interruption");
    const seconds = values.timeout === undefined ? 360 : Number(values.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647)
      throw new Error("timeout must be a positive number of seconds within the supported range");
    const base = new URL(values.url ?? process.env.CODEX_HUB_URL ?? "http://127.0.0.1:4173");
    if (base.protocol !== "http:")
      throw new Error("Only HTTP URLs are supported; HTTPS is not supported yet");
    if (base.username || base.password || base.search || base.hash || base.pathname !== "/")
      throw new Error("URL must contain only an HTTP origin");
    timer = setTimeout(() => abort.abort(), seconds * 1000);
    const api = async <T>(path: string, method = "GET", body?: object): Promise<T> => {
      if (abort.signal.aborted) throw new Error("Command interrupted or timed out");
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise<T>((accept, reject) => {
        const req = request(
          new URL(path, base),
          {
            method,
            signal: abort.signal,
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
                if ((res.statusCode ?? 500) >= 400) {
                  const unknown =
                    (method === "GET" && mutationSubmitted) ||
                    data?.error?.code === "operation_result_unknown" ||
                    ((res.statusCode ?? 500) >= 500 &&
                      method !== "GET" &&
                      data?.error?.code !== "interaction_failed");
                  reject(
                    new CommandError(
                      unknown ? "operation_result_unknown" : "request_failed",
                      unknown
                        ? "操作结果未知；请通过 list、inspect 或 terminal 检查实际状态。"
                        : (data?.error?.message ?? `HTTP ${res.statusCode}`),
                      unknown ? 2 : 1,
                    ),
                  );
                } else accept(data as T);
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        req.on("error", reject);
        if (method !== "GET") mutationSubmitted = true;
        req.end(payload);
      });
    };
    const pause = () =>
      new Promise<void>((accept, reject) => {
        if (abort.signal.aborted) {
          reject(new Error("Command interrupted or timed out"));
          return;
        }
        const stop = () => {
          clearTimeout(wait);
          reject(new Error("Command interrupted or timed out"));
        };
        const wait = setTimeout(() => {
          abort.signal.removeEventListener("abort", stop);
          accept();
        }, 500);
        abort.signal.addEventListener("abort", stop, { once: true });
      });
    const path = `/api/v1/sessions/${encodeURIComponent(id ?? "")}`;
    let result: unknown;
    if (command === "list") {
      const list = await api<SessionListResponse>("/api/v1/sessions");
      const project = values.project === undefined ? undefined : resolve(values.project);
      const projectIds = new Set(
        list.projects.filter((entry) => entry.directory === project).map((entry) => entry.id),
      );
      result = {
        sessions: list.sessions.filter(
          (entry) => project === undefined || projectIds.has(entry.projectId!),
        ),
        projects: list.projects,
        homes: list.homes,
      };
    } else if (command === "inspect") {
      const query = new URLSearchParams();
      for (const name of ["limit", "after"] as const) {
        const value = values[name];
        if (value === undefined) continue;
        if (
          !/^\d+$/.test(value) ||
          !Number.isSafeInteger(Number(value)) ||
          (name === "limit" && (Number(value) < 1 || Number(value) > 300))
        )
          throw new Error(`Invalid ${name}`);
        query.set(name, value);
      }
      result = await api<InspectResponse>(`${path}/inspect?${query}`);
    } else if (command === "terminal") result = await api(`${path}/terminal`);
    else if (["send", "keys", "interrupt", "handoff"].includes(command)) {
      if (command === "send") {
        const message = normalizeMessage(
          values.stdin ? await readStdin(abort.signal) : values.message!,
        );
        await api(`${path}/messages`, "POST", { message, requireIdle: true });
      } else if (command === "handoff") await api(`${path}/handoff-pane-binding`, "POST", {});
      else
        await api(
          `${path}/keys`,
          "POST",
          command === "interrupt" ? { keys: ["interrupt"] } : { keys, requireIdle: true },
        );
      result = { sessionId: id, status: "sent" };
    } else {
      const launch = command === "create" || command === "resume";
      let operationPath = command === "delete" ? path : `${path}/${command}`;
      let body: object = {};
      if (command === "create") {
        operationPath = "/api/v1/sessions";
        body = {
          directory: resolve(values.project!),
          worktree: values.worktree ?? false,
          yolo: values.yolo ?? false,
          ...(values.home === undefined ? {} : { home: values.home }),
          requestId: randomUUID(),
        };
      } else if (command === "resume") {
        operationPath = "/api/v1/sessions";
        body = { resumeSessionId: id, yolo: values.yolo ?? false, requestId: randomUUID() };
      }
      let operation = await api<HubOperation>(
        operationPath,
        command === "delete" ? "DELETE" : "POST",
        body,
      );
      while (operation.status === "pending") {
        await pause();
        operation = await api<HubOperation>(
          `/api/v1/operations/${encodeURIComponent(operation.operationId)}`,
        );
      }
      if (operation.status !== "succeeded")
        throw new CommandError(
          operation.status === "unknown" ? "operation_result_unknown" : "operation_failed",
          operation.status === "unknown"
            ? "操作结果未知；请检查会话实际状态。"
            : "操作失败；请检查服务端诊断。",
          operation.status === "unknown" ? 2 : 1,
        );
      if (launch) {
        if (!operation.sessionId) throw new Error("Launch response has no session");
        for (;;) {
          const observed = await api<InspectResponse>(
            `/api/v1/sessions/${encodeURIComponent(operation.sessionId)}/inspect?limit=1`,
          );
          if (
            observed.live &&
            observed.interaction.supported &&
            observed.interaction.state === "connected" &&
            observed.interaction.activity === "idle"
          )
            break;
          await pause();
        }
      }
      result = { sessionId: operation.sessionId, status: "succeeded" };
    }
    console.log(json ? JSON.stringify(result) : formatResult(command, result));
  } catch (error) {
    const failure =
      error instanceof CommandError
        ? error
        : new CommandError(
            mutationSubmitted ? "operation_result_unknown" : "query_failed",
            mutationSubmitted
              ? "操作结果未知；未重试或取消后端操作，请通过 list、inspect 或 terminal 检查实际状态。"
              : `查询失败：${error instanceof Error ? error.message : String(error)}`,
            mutationSubmitted ? 2 : 1,
          );
    if (json)
      console.log(JSON.stringify({ error: { code: failure.code, message: failure.message } }));
    else console.error(failure.message);
    process.exitCode = failure.exitCode;
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
      if (size > MAX_INTERACTION_MESSAGE_BYTES * 2) fail(new Error("Message exceeds 64 KiB"));
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

function formatResult(command: string, result: unknown): string {
  if (command === "terminal") {
    const screen = result as TerminalResponse;
    return `${screen.capturedAt}${screen.truncated ? " (truncated)" : ""}\n${screen.content}`;
  }
  if (command === "list") {
    const list = result as SessionListResponse;
    return [
      "ID\tSTATUS\tHOME\tPROJECT\tTITLE",
      ...list.sessions.map((session) =>
        [
          session.id,
          session.status,
          list.homes.find((home) => home.sourceInstanceId === session.sourceInstanceId)?.nickname ??
            "",
          list.projects.find((project) => project.id === session.projectId)?.directory ?? "",
          session.title.replace(/[\r\n\t]/g, " "),
        ].join("\t"),
      ),
    ].join("\n");
  }
  if (command === "inspect") {
    const inspected = result as InspectResponse;
    const state = inspected.interaction.supported
      ? `${inspected.interaction.state} ${inspected.interaction.activity ?? ""}`
      : "unsupported";
    const header = `${inspected.session.id} ${inspected.session.status} ${state}`;
    const items = inspected.items.map(formatTimelineItem).join("\n\n");
    const pagination = `nextAfter=${inspected.nextAfter} hasMore=${inspected.hasMore} latestNumber=${inspected.latestNumber}`;
    return `${header}\n${items}\n${pagination}`;
  }
  return JSON.stringify(result, null, 2);
}

function formatTimelineItem(item: TimelineItem): string {
  if (item.kind !== "message") return `#${item.ordinal} ${JSON.stringify(item)}`;
  const phase = item.itemType ?? item.phase ?? "";
  return `#${item.ordinal} ${item.role} ${phase}\n${item.markdown}`;
}

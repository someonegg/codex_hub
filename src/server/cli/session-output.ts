import type {
  SessionListResponse,
  SessionMessagesResponse,
  TerminalResponse,
  TmuxTarget,
} from "../../shared/api-contract.js";
import { formatTable, formatTmux, singleLine } from "./output.js";

export interface CliSessionList {
  sessions: {
    id: string;
    title: string;
    status: string;
    home: string;
    projectDirectory: string | null;
    taskName?: string | null;
    updatedAt: string | null;
  }[];
}
export interface CliSession {
  id: string;
  title: string;
  status: string;
  home: string;
  agentName: string;
  workingDirectory: string | null;
  projectDirectory: string | null;
  taskName?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  resume: { allowed: boolean; reason: string | null };
}
export type CliInteraction =
  | { supported: false; tmux: TmuxTarget | null }
  | {
      supported: true;
      tmux: TmuxTarget | null;
      state: string;
      activity: string | null;
      supersededBySessionId: string | null;
    };
interface CliRecord {
  id: string;
  ordinal: number;
  timestamp: string | null;
}
export interface CliMessage extends CliRecord {
  kind: "message";
  role: "user" | "assistant";
  phase: string | null;
  itemType: string | null;
  markdown: string;
  inputHint?: string;
}
export interface CliQuestion extends CliRecord {
  kind: "user_input";
  stage: "request";
  questions: {
    header: string;
    question: string;
    options: { label: string; description: string }[];
  }[];
  inputHint: string;
}
export type CliAnswer = CliRecord & { kind: "user_input"; stage: "response" } & (
    | { outcome: "answered"; answers: string[] }
    | { outcome: "aborted" }
    | { outcome: "unavailable"; summary: string }
  );
export interface CliInspect {
  session: CliSession;
  interaction: CliInteraction;
  items: (CliMessage | CliQuestion | CliAnswer)[];
  nextAfter: number;
  hasMore: boolean;
}
export interface CliTerminal {
  content: string;
  truncated: boolean;
  capturedAt: string;
}
export interface CliOperation {
  sessionId: string | null;
  status: "sent" | "succeeded";
  tmux?: TmuxTarget | null;
}
export type CliResult = CliSessionList | CliInspect | CliTerminal | CliOperation;

export function mapList(
  list: SessionListResponse,
  project?: string,
  includeArchived = false,
): CliSessionList {
  return {
    sessions: list.sessions
      .filter((s) => !s.isChild && (includeArchived || s.status !== "archived"))
      .map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        home: s.home,
        projectDirectory: s.projectDirectory,
        ...(s.taskName ? { taskName: s.taskName } : {}),
        updatedAt: s.updatedAt,
      }))
      .filter((s) => project === undefined || s.projectDirectory === project),
  };
}
function inputHint(sessionId: string): string {
  return `Wait for connected and idle, then run session terminal ${sessionId} to check the current prompt and session keys ${sessionId} <key...> to select.`;
}

export function mapInspect(value: SessionMessagesResponse): CliInspect {
  const s = value.session;
  const i = value.interaction;
  return {
    session: {
      id: s.id,
      title: s.title,
      status: s.status,
      home: s.origin.home,
      agentName: s.origin.agentName,
      workingDirectory: s.workingDirectory,
      projectDirectory: s.projectDirectory,
      ...(s.taskName ? { taskName: s.taskName } : {}),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      resume: { allowed: s.resume.allowed, reason: s.resume.reason },
    },
    interaction: i.supported
      ? {
          supported: true,
          tmux: i.tmux
            ? {
                socketPath: i.tmux.socketPath,
                paneId: i.tmux.paneId,
                sessionName: i.tmux.sessionName ?? null,
              }
            : null,
          state: i.state,
          activity: i.activity,
          supersededBySessionId: i.supersededBySessionId,
        }
      : { supported: false, tmux: null },
    items: value.items.flatMap((item): CliInspect["items"] => {
      const base = { id: item.id, ordinal: item.ordinal, timestamp: item.timestamp };
      if (item.kind === "message")
        return [
          {
            ...base,
            kind: "message",
            role: item.role,
            phase: item.phase,
            itemType: item.itemType,
            markdown: item.markdown,
            ...(item.role === "assistant" && item.phase === "response" && item.itemType === "Plan"
              ? { inputHint: inputHint(s.id) }
              : {}),
          },
        ];
      if (item.kind !== "user_input") return [];
      const input = { ...base, kind: "user_input" as const };
      if (item.stage === "request")
        return [
          {
            ...input,
            stage: "request",
            questions: item.questions.map((question) => ({
              header: question.header,
              question: question.question,
              options: question.options.map((option) => ({
                label: option.label,
                description: option.description,
              })),
            })),
            inputHint: inputHint(s.id),
          },
        ];
      if (item.outcome === "answered")
        return [
          {
            ...input,
            stage: "response",
            outcome: "answered",
            answers: item.answers.flatMap((a) => a.answers),
          },
        ];
      if (item.outcome === "unavailable")
        return [{ ...input, stage: "response", outcome: "unavailable", summary: item.summary }];
      if (item.outcome === "aborted") return [{ ...input, stage: "response", outcome: "aborted" }];
      return [];
    }),
    nextAfter: value.nextAfter,
    hasMore: value.hasMore,
  };
}
export function mapTerminal(s: TerminalResponse): CliTerminal {
  return { content: s.content, truncated: s.truncated, capturedAt: s.capturedAt };
}
export function formatResult(
  command: string,
  result: CliResult,
  options: { emptyItemsText?: string } = {},
): string {
  if ("content" in result)
    return `${singleLine(result.capturedAt)}${result.truncated ? " (truncated)" : ""}\n${result.content}`;
  if ("sessions" in result) {
    const showTask = result.sessions.some((s) => Boolean(s.taskName));
    return (
      formatTable(
        ["ID", "STATUS", "HOME", "PROJECT", ...(showTask ? ["TASK"] : []), "TITLE"],
        result.sessions.map((s) => [
          s.id,
          s.status,
          s.home ?? "",
          s.projectDirectory ?? "",
          ...(showTask ? [s.taskName ?? ""] : []),
          s.title,
        ]),
      ) + (result.sessions.length ? "" : "\nNo sessions.")
    );
  }
  if (!("session" in result)) {
    const lines = [`${command} ${singleLine(String(result.sessionId))}: ${result.status}`];
    if (result.tmux) lines.push(`Tmux: ${formatTmux(result.tmux)}`);
    return lines.join("\n");
  }
  return formatInspect(result, options.emptyItemsText ?? "No visible items.");
}

function formatInspect(result: CliInspect, emptyItemsText: string): string {
  const { session, interaction } = result;
  const summary = [
    `Session: ${session.id}`,
    `Title: ${session.title}`,
    `Status: ${session.status}`,
    `Interaction: ${interaction.supported ? interaction.state : "unsupported"}`,
  ];
  if (interaction.supported) {
    if (interaction.tmux) summary.push(`Tmux: ${formatTmux(interaction.tmux)}`);
    summary.push(`Activity: ${interaction.activity ?? "unknown"}`);
    if (interaction.supersededBySessionId)
      summary.push(`Superseded by: ${interaction.supersededBySessionId}`);
  }
  summary.push(
    `Home: ${session.home ?? ""}`,
    `Project: ${session.projectDirectory ?? ""}`,
    ...(session.taskName ? [`Task: ${session.taskName}`] : []),
    `Working directory: ${session.workingDirectory ?? ""}`,
  );
  const header = summary.map(singleLine).join("\n");
  const items = result.items.map(formatHistoryItem).join("\n\n");
  return `${header}\n\n${items || emptyItemsText}\n\nNext after: ${result.nextAfter}\nHas more: ${result.hasMore ? "yes" : "no"}`;
}

function formatHistoryItem(item: CliInspect["items"][number]): string {
  if (item.kind === "message") {
    const phase = [item.phase, item.itemType].filter(Boolean).join(" · ");
    const title = `--- #${item.ordinal} ${item.role === "assistant" ? "Assistant" : "User"}${phase ? ` · ${singleLine(phase)}` : ""} ---`;
    const body = item.inputHint ? `${item.markdown}\n\n${item.inputHint}` : item.markdown;
    return `${title}\n${body}`;
  }
  if (item.stage === "request") {
    const questions = item.questions
      .map((question) =>
        [
          question.header,
          question.question,
          ...question.options.map(
            (option, index) => `${index + 1}. ${option.label}\n   ${option.description}`,
          ),
        ].join("\n"),
      )
      .join("\n\n");
    return [`--- #${item.ordinal} Question ---`, questions, item.inputHint]
      .filter(Boolean)
      .join("\n\n");
  }

  let body: string;
  switch (item.outcome) {
    case "answered":
      body = item.answers.map((answer) => `- ${answer}`).join("\n");
      break;
    case "aborted":
      body = "Cancelled.";
      break;
    case "unavailable":
      body = `Unavailable: ${item.summary}`;
      break;
  }
  return `--- #${item.ordinal} Answer ---\n${body}`;
}

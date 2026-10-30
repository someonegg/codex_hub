import type {
  TmuxTarget,
  InspectResponse,
  SessionListResponse,
  TerminalResponse,
} from "../../shared/api-contract.js";
import { formatTmux, singleLine } from "./output.js";

export interface CliSessionList {
  sessions: {
    id: string;
    title: string;
    status: string;
    home: string;
    projectDirectory: string | null;
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
}
export interface CliQuestion extends CliRecord {
  kind: "user_input";
  stage: "request";
  callId: string;
  questions: {
    id: string;
    header: string;
    question: string;
    options: { label: string; description: string }[];
  }[];
}
export type CliAnswer = CliRecord & { kind: "user_input"; stage: "response"; callId: string } & (
    | { outcome: "answered"; answers: { questionId: string; answers: string[] }[] }
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

export function mapList(list: SessionListResponse, project?: string): CliSessionList {
  const projects = new Map(list.projects.map((project) => [project.id, project.directory]));
  return {
    sessions: list.sessions
      .filter((s) => !s.isChild)
      .map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        home: s.home,
        projectDirectory: projects.get(s.projectId ?? "") ?? null,
        updatedAt: s.updatedAt,
      }))
      .filter((s) => project === undefined || s.projectDirectory === project),
  };
}
export function mapInspect(value: InspectResponse): CliInspect {
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
          },
        ];
      if (item.kind !== "user_input") return [];
      const input = { ...base, kind: "user_input" as const, callId: item.callId };
      if (item.stage === "request")
        return [
          {
            ...input,
            stage: "request",
            questions: item.questions.map((q) => ({
              id: q.id,
              header: q.header,
              question: q.question,
              options: q.options.map((o) => ({ label: o.label, description: o.description })),
            })),
          },
        ];
      if (item.outcome === "answered")
        return [
          {
            ...input,
            stage: "response",
            outcome: "answered",
            answers: item.answers.map((a) => ({
              questionId: a.questionId,
              answers: [...a.answers],
            })),
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
  if ("sessions" in result)
    return [
      "ID\tSTATUS\tHOME\tPROJECT\tTITLE",
      ...(result.sessions.length ? [] : ["No sessions."]),
      ...result.sessions.map((s) =>
        [s.id, s.status, s.home ?? "", s.projectDirectory ?? "", s.title]
          .map(singleLine)
          .join("\t"),
      ),
    ].join("\n");
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
    `Working directory: ${session.workingDirectory ?? ""}`,
  );
  const header = summary.map(singleLine).join("\n");
  const titles = new Map<string, Map<string, string>>();
  for (const item of result.items)
    if (item.kind === "user_input" && item.stage === "request") {
      const questions = titles.get(item.callId) ?? new Map<string, string>();
      for (const q of item.questions) questions.set(q.id, q.header || q.id);
      titles.set(item.callId, questions);
    }
  const items = result.items
    .map((item) =>
      formatHistoryItem(item, item.kind === "user_input" ? titles.get(item.callId) : undefined),
    )
    .join("\n\n");
  return `${header}\n\n${items || emptyItemsText}\n\nNext after: ${result.nextAfter}\nHas more: ${result.hasMore ? "yes" : "no"}`;
}

function formatHistoryItem(
  item: CliInspect["items"][number],
  questionTitles?: ReadonlyMap<string, string>,
): string {
  if (item.kind === "message") {
    const phase = [item.phase, item.itemType].filter(Boolean).join(" · ");
    return `--- #${item.ordinal} ${item.role === "assistant" ? "Assistant" : "User"}${phase ? ` · ${singleLine(phase)}` : ""} ---\n${item.markdown}`;
  }
  if (item.stage === "request") {
    const questions = item.questions.map((question) =>
      [
        singleLine(question.header),
        question.question,
        ...question.options.map(
          (option, index) =>
            `${index + 1}. ${singleLine(option.label)}${option.description ? ` — ${singleLine(option.description)}` : ""}`,
        ),
      ].join("\n"),
    );
    return `--- #${item.ordinal} Question ---\n${questions.join("\n\n")}`;
  }

  let body: string;
  switch (item.outcome) {
    case "answered":
      body = item.answers
        .map(
          (answer) =>
            `${singleLine(questionTitles?.get(answer.questionId) ?? answer.questionId)}: ${answer.answers.join(", ")}`,
        )
        .join("\n");
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

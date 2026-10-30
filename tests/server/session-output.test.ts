import { expect, it } from "vitest";

import {
  formatResult,
  mapInspect,
  mapList,
  mapTerminal,
} from "../../src/server/cli/session-output.js";
import type { InspectResponse, SessionListResponse } from "../../src/shared/api-contract.js";

const base = {
  session: {
    id: "child",
    title: "修复\n登录\t问题",
    status: "live",
    origin: {
      sourceType: "codex",
      agentName: "Codex",
      home: "work",
      agentVersion: "secret",
      formatVersion: "secret",
    },
    workingDirectory: "/project/worktree",
    projectDirectory: "/project",
    createdAt: null,
    updatedAt: null,
    resume: { allowed: true, reason: null, secret: "secret" },
    parentId: "secret",
    childIds: ["secret"],
    sourceId: "secret",
    messageCount: 8,
    toolCount: 5,
    itemCount: 9,
  },
  live: true,
  nextAfter: 44,
  hasMore: true,
  interaction: {
    supported: true,
    tmux: null,
    state: "connected",
    activity: "working",
    supersededBySessionId: null,
    attachCommand: "secret",
  },
  items: [],
  secret: "secret",
} as unknown as InspectResponse;
const record = { id: "record", ordinal: 42, timestamp: null, secret: "secret" };
const request = {
  ...record,
  kind: "user_input",
  stage: "request",
  callId: "call",
  questions: [
    {
      id: "q",
      header: "选择修复方式",
      question: "采用哪种实现？",
      secret: "secret",
      options: [{ label: "最小改动", description: "仅修复当前问题", secret: "secret" }],
    },
    { id: "q2", header: "验证方式", question: "如何验证？", options: [] },
  ],
};

it("maps the list with a field whitelist and excludes ordinary and orphan children", () => {
  const list = mapList({
    homes: [{ nickname: "default" }],
    projects: [{ directory: "/project" }],
    revision: "secret",
    sessions: [
      {
        id: "main",
        title: "title",
        status: "normal",
        home: "default",
        projectDirectory: "/project",
        updatedAt: null,
        isChild: false,
        parentId: null,
        secret: "secret",
      },
      { id: "child", isChild: true, parentId: "main", projectDirectory: "/project" },
      { id: "orphan", isChild: true, parentId: null, projectDirectory: "/project" },
      {
        id: "missing",
        title: "missing",
        status: "archived",
        home: "work",
        projectDirectory: null,
        updatedAt: null,
      },
    ],
  } as unknown as SessionListResponse);
  expect(list).toEqual({
    sessions: [
      {
        id: "main",
        title: "title",
        status: "normal",
        home: "default",
        projectDirectory: "/project",
        updatedAt: null,
      },
      {
        id: "missing",
        title: "missing",
        status: "archived",
        home: "work",
        projectDirectory: null,
        updatedAt: null,
      },
    ],
  });
  expect(mapList({ homes: [], projects: [], sessions: [], revision: "" }, "/project")).toEqual({
    sessions: [],
  });
});

it("whitelists nested records and renders Markdown, questions, matched answers and pagination", () => {
  const mapped = mapInspect({
    ...base,
    items: [
      {
        ...record,
        kind: "message",
        role: "assistant",
        phase: "update",
        itemType: null,
        markdown: "**检查**\n正在检查登录流程。",
      },
      request,
      {
        ...record,
        ordinal: 44,
        kind: "user_input",
        stage: "response",
        callId: "call",
        outcome: "answered",
        answers: [
          { questionId: "q", answers: ["最小改动"], secret: "secret" },
          { questionId: "outside", answers: ["原文"] },
        ],
      },
      { ...record, kind: "tool", toolName: "secret" },
      { ...record, kind: "future", secret: "secret" },
    ],
  } as unknown as InspectResponse);
  expect(Object.keys(mapped)).toEqual(["session", "interaction", "items", "nextAfter", "hasMore"]);
  expect(Object.keys(mapped.session)).toEqual([
    "id",
    "title",
    "status",
    "home",
    "agentName",
    "workingDirectory",
    "projectDirectory",
    "createdAt",
    "updatedAt",
    "resume",
  ]);
  expect(mapped.items).toHaveLength(3);
  expect(JSON.stringify(mapped)).not.toContain("secret");
  expect(mapped.session.home).toBe("work");
  const text = formatResult("inspect", mapped);
  expect(text).not.toContain("secret");
  expect(text).toContain(
    "Title: 修复 登录 问题\nStatus: live\nInteraction: connected\nActivity: working",
  );
  expect(text).toContain("--- #42 Assistant · update ---\n**检查**\n正在检查登录流程。");
  expect(text).toContain(
    "选择修复方式\n采用哪种实现？\n1. 最小改动 — 仅修复当前问题\n\n验证方式\n如何验证？",
  );
  expect(text).toContain("--- #44 Answer ---\n选择修复方式: 最小改动\noutside: 原文");
  expect(text).toContain("Next after: 44\nHas more: yes");
});

it.each(["idle", null] as const)("renders activity %s explicitly", (activity) => {
  const mapped = mapInspect({
    ...base,
    interaction: {
      ...base.interaction,
      supported: true,
      state: "connected",
      supersededBySessionId: null,
      attachCommand: null,
      activity,
    },
  });
  expect(formatResult("inspect", mapped)).toContain(`Activity: ${activity ?? "unknown"}`);
});
it("renders unsupported, empty pages, cancelled and unavailable outcomes", () => {
  const mapped = mapInspect({
    ...base,
    interaction: { supported: false, attachCommand: "secret" },
    hasMore: false,
  });
  expect(mapped.interaction).toEqual({ supported: false, tmux: null });
  expect(formatResult("inspect", mapped)).toContain("Interaction: unsupported");
  expect(formatResult("inspect", mapped)).toContain(
    "No visible items.\n\nNext after: 44\nHas more: no",
  );
  const outcomes = mapInspect({
    ...base,
    items: [
      { ...record, kind: "user_input", stage: "response", callId: "call", outcome: "aborted" },
      {
        ...record,
        kind: "user_input",
        stage: "response",
        callId: "call",
        outcome: "unavailable",
        summary: "读取失败\n详细说明",
      },
    ],
  } as unknown as InspectResponse);
  expect(formatResult("inspect", outcomes)).toContain("Answer ---\nCancelled.");
  expect(formatResult("inspect", outcomes)).toContain(
    "Answer ---\nUnavailable: 读取失败\n详细说明",
  );
});
it("maps terminal fields explicitly", () => {
  expect(
    mapTerminal({
      content: "screen",
      truncated: false,
      capturedAt: "now",
      secret: "secret",
    } as any),
  ).toEqual({ content: "screen", truncated: false, capturedAt: "now" });
});

import { expect, it } from "vitest";

import {
  formatResult,
  mapInspect,
  mapList,
  mapTerminal,
} from "../../src/server/cli/session-output.js";
import type {
  SessionListResponse,
  SessionMessagesResponse,
} from "../../src/shared/api-contract.js";

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
} as unknown as SessionMessagesResponse;
const record = { id: "record", ordinal: 42, timestamp: null, secret: "secret" };

it("maps the list with a field whitelist and excludes ordinary and orphan children", () => {
  const response = {
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
  } as unknown as SessionListResponse;
  const list = mapList(response, undefined, true);
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
  } as unknown as SessionMessagesResponse);
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

it.each([
  ["assistant", "response", "Plan", true],
  ["assistant", "update", "Plan", false],
] as const)(
  "adds hints only to assistant response Plans (%s %s %s)",
  (role, phase, itemType, hinted) => {
    const mapped = mapInspect({
      ...base,
      items: [
        {
          ...record,
          kind: "message",
          role,
          phase,
          itemType,
          markdown: "完整计划\n1. 实施\n2. 验证",
        },
      ],
    });
    const item = mapped.items[0]!;
    expect("inputHint" in item).toBe(hinted);
    const text = formatResult("inspect", mapped);
    expect(text).toContain("完整计划\n1. 实施\n2. 验证");
    expect(text.includes("session terminal child")).toBe(hinted);
    expect(mapped.nextAfter).toBe(44);
  },
);

it("aligns complete session list columns, including empty projects and long opaque IDs", () => {
  const row = {
    id: "id",
    title: "中文 title",
    status: "live",
    home: "工作",
    projectDirectory: "/project",
    updatedAt: null,
  };
  expect(
    formatResult("list", {
      sessions: [
        row,
        {
          ...row,
          id: "opaque-session-with-a-long-native-id",
          status: "archived",
          home: "e\u0301",
          projectDirectory: null,
          title: "👩🏽‍💻 fix",
        },
      ],
    }),
  ).toBe(
    [
      "ID                                    STATUS    HOME  PROJECT   TITLE",
      "id                                    live      工作  /project  中文 title",
      "opaque-session-with-a-long-native-id  archived  e\u0301               👩🏽‍💻 fix",
    ].join("\n"),
  );
  const withTask = formatResult("list", {
    sessions: [row, { ...row, taskName: "修复" }],
  }).split("\n");
  expect(withTask).toEqual([
    "ID  STATUS  HOME  PROJECT   TASK  TITLE",
    "id  live    工作  /project        中文 title",
    "id  live    工作  /project  修复  中文 title",
  ]);
  expect(formatResult("list", { sessions: [] })).toBe(
    "ID  STATUS  HOME  PROJECT  TITLE\nNo sessions.",
  );
});

export const docsTimestamp = "2026-10-16T14:00:00.000Z";

export const docsSession = {
  id: "docs-demo-session-00000001",
  title: "Design the project dashboard",
  origin: {
    sourceType: "codex",
    sourceInstanceId: "docs-demo",
    agentName: "Codex",
    agentVersion: null,
    formatVersion: null,
  },
  nickname: null,
  workingDirectory: "/projects/atlas-dashboard",
  projectDirectory: "/projects/atlas-dashboard",
  createdAt: docsTimestamp,
  updatedAt: docsTimestamp,
  status: "live",
  resume: { allowed: false, reason: "Session is already live" },
  parentId: null,
  childIds: [],
  agent: null,
  messageCount: 0,
  toolCount: 0,
  sourceId: null,
  itemCount: 0,
};

export const connectedInteraction = {
  supported: true,
  state: "connected",
  supersededBySessionId: null,
  attachCommand: "tmux attach -t atlas-dashboard",
};

export const docsUserInput = [
  {
    id: "dashboard-question",
    ordinal: 1,
    timestamp: docsTimestamp,
    kind: "user_input",
    callId: "dashboard-focus",
    stage: "request",
    questions: [
      {
        id: "focus",
        header: "Dashboard focus",
        question: "Which area should we improve first?",
        options: [
          { label: "Project health", description: "Show status and next steps at a glance." },
          { label: "Recent activity", description: "Highlight the latest changes and decisions." },
        ],
      },
    ],
  },
  {
    id: "dashboard-answer",
    ordinal: 2,
    timestamp: docsTimestamp,
    kind: "user_input",
    callId: "dashboard-focus",
    stage: "response",
    outcome: "answered",
    answers: [{ questionId: "focus", answers: ["Project health"] }],
  },
];

export const docsItems = [
  {
    id: "prompt",
    ordinal: 0,
    timestamp: docsTimestamp,
    kind: "message",
    role: "user",
    phase: null,
    itemType: null,
    markdown: "Suggest three improvements for this project dashboard.",
  },
  ...docsUserInput,
  {
    id: "reply",
    ordinal: 3,
    timestamp: docsTimestamp,
    kind: "message",
    role: "assistant",
    phase: "final",
    itemType: null,
    markdown:
      "Start with **project health**, then highlight recent activity and keep navigation clear.",
  },
];

// Playwright intercepts the current WebSocket protocol without a real Codex session.
export async function mockDocsTerminal(context, timestamp) {
  await context.routeWebSocket("**/api/v1/sessions/*/terminal-preview", (socket) => {
    socket.send(
      JSON.stringify({
        type: "snapshot",
        revision: "d".repeat(43),
        content:
          "Codex ready\n\n› Improve the project dashboard.\n\nProject health selected. Ready for the next step.",
        truncated: false,
        capturedAt: timestamp,
      }),
    );
  });
}

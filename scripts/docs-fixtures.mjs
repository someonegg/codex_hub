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

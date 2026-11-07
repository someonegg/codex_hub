import { appendFile, cp, mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, it, vi } from "vitest";

import { createAhub } from "../../src/server/create-hub.js";
import { TmuxInteractionService } from "../../src/server/interaction/tmux-service.js";
import type { UpdateRevision } from "../../src/shared/api-contract.js";
import { createTempDirectory } from "../helpers/temp-directories.js";
import { createTestPreviewListener } from "../helpers/terminal-listener.js";

vi.mock("../../src/server/interaction/tmux-preview-listener.js", () => ({
  createTmuxPreviewListener: () => createTestPreviewListener(),
}));

it("isolates native identities, names and relationships while merging projects and retaining empty agents", async () => {
  const root = await createTempDirectory("multi-agent-");
  const agents = ["personal", "work", "empty"].map((nickname) => ({
    nickname,
    path: join(root, nickname),
  }));
  for (const agent of agents.slice(0, 2)) {
    await cp(resolve("tests/fixtures/codex-home"), agent.path, { recursive: true });
    await writeFile(
      join(agent.path, "session_index.jsonl"),
      JSON.stringify({ id: "basic-session", thread_name: `${agent.nickname} title` }) + "\n",
    );
  }
  await mkdir(agents[2]!.path);
  const hub = await createAhub({ agents: agents });
  try {
    const list = await hub.sessions.list();
    expect(list.agents).toEqual([
      { nickname: "personal", runtimeName: "Codex", management: { archive: true } },
      { nickname: "work", runtimeName: "Codex", management: { archive: true } },
      { nickname: "empty", runtimeName: "Codex", management: { archive: true } },
    ]);
    expect(JSON.stringify(list)).not.toContain(root);
    const personal = list.sessions.find((session) => session.title === "personal title")!;
    const work = list.sessions.find((session) => session.title === "work title")!;
    expect(personal.id).not.toBe(work.id);
    expect(personal.agent).toBe("personal");
    expect(work.agent).toBe("work");
    expect(personal.projectDirectory).toBe(work.projectDirectory);
    for (const parent of [personal, work]) {
      const detail = (await hub.sessions.getSession(parent.id))!.session;
      expect(detail.title).toBe(parent.title);
      expect(detail).not.toHaveProperty("nickname");
      expect(detail.childIds).toHaveLength(1);
      const child = (await hub.sessions.getSession(detail.childIds[0]!))!.session;
      expect(child.parentId).toBe(parent.id);
      expect(child.origin.agent).toBe(parent.agent);
    }
    const reordered = await createAhub({
      agents: [...agents]
        .reverse()
        .map((agent) => ({ ...agent, nickname: `${agent.nickname} renamed` })),
    });
    try {
      const next = await reordered.sessions.list();
      expect(next.sessions.map((session) => session.id)).toEqual(
        list.sessions.map((session) => session.id),
      );
      expect(next.revision).not.toBe(list.revision);
      expect(next.sessions.find((session) => session.id === personal.id)?.agent).toBe(
        "personal renamed",
      );
      expect((await reordered.sessions.getSession(personal.id))!.session.origin.agent).toBe(
        "personal renamed",
      );
    } finally {
      reordered.close();
    }
    // A recoverably unreadable session root must not prevent access to another agent.
    await rename(join(agents[0]!.path, "sessions"), join(root, "offline"));
    await writeFile(join(agents[0]!.path, "sessions"), "unavailable");
    await hub.sessions.refresh();
    expect((await hub.sessions.getSession(work.id))!.session.title).toBe("work title");
  } finally {
    hub.close();
  }
});

it("keeps automatic updates reads isolated and resolves tmux takeover across agents", async () => {
  const root = await createTempDirectory("multi-agent-updates-");
  const agents = ["personal", "work"].map((nickname) => ({ nickname, path: join(root, nickname) }));
  const rollout = (index: number) =>
    join(
      agents[index]!.path,
      "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl",
    );
  const target = {
    socketPath: join(root, "tmux.sock"),
    sessionName: "ahub-00000000-0000-0000-0000-000000000007",
  };
  const bind = (timestamp: string) =>
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `<user_shell_command>\nAHUB_TMUX_BIND_V3\n${target.socketPath}\n${target.sessionName}\n\n\n</user_shell_command>`,
          },
        ],
      },
    }) + "\n";
  for (let index = 0; index < agents.length; index++) {
    await cp(resolve("tests/fixtures/codex-home"), agents[index]!.path, { recursive: true });
    await appendFile(rollout(index), bind(`2026-07-28T12:00:0${index}.000Z`));
  }
  const connect = vi
    .spyOn(TmuxInteractionService.prototype, "resolveTarget")
    .mockResolvedValue(target);
  const hub = await createAhub({ agents: agents });
  try {
    const list = await hub.sessions.list();
    expect(list.agents).toEqual(
      agents.map(({ nickname }) => ({
        nickname,
        runtimeName: "Codex",
        management: { archive: true },
      })),
    );
    const parents = agents.map(
      (agent) =>
        list.sessions.find(
          (session) => session.agent === agent.nickname && session.title === "Synthetic trace",
        )!,
    );
    const [personal, work] = parents;
    expect(await hub.interaction.describe(personal!.id)).toMatchObject({
      state: "superseded",
      supersededBySessionId: work!.id,
    });
    expect(await hub.interaction.describe(work!.id)).toMatchObject({ state: "connected" });
    const personalPage = (await hub.sessions.messages(personal!.id, { limit: 300 }))!;
    const workPage = (await hub.sessions.messages(work!.id, { limit: 300 }))!;
    await appendFile(
      rollout(0),
      JSON.stringify({
        timestamp: "2026-07-28T13:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Personal update only",
        },
      }) + "\n",
    );
    await hub.sessions.refresh();
    const updates = await hub.updates.wait(personal!.id, {
      after: personalPage.nextAfter,
      stateRevision: "unseen" as UpdateRevision,
    });
    expect(updates!.items).toHaveLength(1);
    expect(updates!.session.origin.agent).toBe(personal!.agent);
    const other = await hub.updates.wait(work!.id, {
      after: workPage.nextAfter,
      stateRevision: "unseen" as UpdateRevision,
    });
    expect(other!.hasMore).toBe(false);
  } finally {
    hub.close();
    connect.mockRestore();
  }
});

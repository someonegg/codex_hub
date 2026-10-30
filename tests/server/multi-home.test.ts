import { appendFile, cp, mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, it, vi } from "vitest";

import { createCodexHub } from "../../src/server/create-hub.js";
import { TmuxInteractionService } from "../../src/server/interaction/tmux-service.js";
import type { UpdateRevision } from "../../src/shared/api-contract.js";
import { createTempDirectory } from "../helpers/temp-directories.js";
import { createTestPreviewListener } from "../helpers/terminal-listener.js";

vi.mock("../../src/server/interaction/tmux-preview-listener.js", () => ({
  createTmuxPreviewListener: () => createTestPreviewListener(),
}));

it("isolates native identities, names and relationships while merging projects and retaining empty homes", async () => {
  const root = await createTempDirectory("multi-home-");
  const homes = ["personal", "work", "empty"].map((nickname) => ({
    nickname,
    path: join(root, nickname),
  }));
  for (const home of homes.slice(0, 2)) {
    await cp(resolve("tests/fixtures/codex-home"), home.path, { recursive: true });
    await writeFile(
      join(home.path, "session_index.jsonl"),
      JSON.stringify({ id: "basic-session", thread_name: `${home.nickname} title` }) + "\n",
    );
  }
  await mkdir(homes[2]!.path);
  const hub = await createCodexHub(homes);
  try {
    const list = await hub.sessions.list();
    expect(list.homes).toEqual([
      { nickname: "empty" },
      { nickname: "personal" },
      { nickname: "work" },
    ]);
    expect(JSON.stringify(list)).not.toContain(root);
    const personal = list.sessions.find((session) => session.title === "personal title")!;
    const work = list.sessions.find((session) => session.title === "work title")!;
    expect(personal.id).not.toBe(work.id);
    expect(personal.home).toBe("personal");
    expect(work.home).toBe("work");
    expect(personal.projectId).toBe(work.projectId);
    for (const parent of [personal, work]) {
      const detail = (await hub.sessions.getSession(parent.id))!.session;
      expect(detail.title).toBe(parent.title);
      expect(detail).not.toHaveProperty("nickname");
      expect(detail.childIds).toHaveLength(1);
      const child = (await hub.sessions.getSession(detail.childIds[0]!))!.session;
      expect(child.parentId).toBe(parent.id);
      expect(child.origin.home).toBe(parent.home);
    }
    const reordered = await createCodexHub(
      [...homes].reverse().map((home) => ({ ...home, nickname: `${home.nickname} renamed` })),
    );
    try {
      const next = await reordered.sessions.list();
      expect(next.sessions.map((session) => session.id)).toEqual(
        list.sessions.map((session) => session.id),
      );
      expect(next.revision).not.toBe(list.revision);
      expect(next.sessions.find((session) => session.id === personal.id)?.home).toBe(
        "personal renamed",
      );
      expect((await reordered.sessions.getSession(personal.id))!.session.origin.home).toBe(
        "personal renamed",
      );
    } finally {
      reordered.close();
    }
    // A recoverably unreadable session root must not prevent access to another home.
    await rename(join(homes[0]!.path, "sessions"), join(root, "offline"));
    await writeFile(join(homes[0]!.path, "sessions"), "unavailable");
    await hub.sessions.refresh();
    expect((await hub.sessions.getSession(work.id))!.session.title).toBe("work title");
  } finally {
    hub.close();
  }
});

it("keeps automatic updates reads isolated and resolves tmux takeover across homes", async () => {
  const root = await createTempDirectory("multi-home-updates-");
  const homes = ["personal", "work"].map((nickname) => ({ nickname, path: join(root, nickname) }));
  const rollout = (index: number) =>
    join(homes[index]!.path, "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl");
  const target = { socketPath: join(root, "tmux.sock"), paneId: "%7" };
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
            text: `<user_shell_command>\nAHUB_TMUX_BIND_V1\n${target.socketPath}\n${target.paneId}\n\n\n</user_shell_command>`,
          },
        ],
      },
    }) + "\n";
  for (let index = 0; index < homes.length; index++) {
    await cp(resolve("tests/fixtures/codex-home"), homes[index]!.path, { recursive: true });
    await appendFile(rollout(index), bind(`2026-07-28T12:00:0${index}.000Z`));
  }
  const connect = vi
    .spyOn(TmuxInteractionService.prototype, "resolveTarget")
    .mockResolvedValue(target);
  const hub = await createCodexHub(homes);
  try {
    const list = await hub.sessions.list();
    expect(list.homes).toEqual(homes.map(({ nickname }) => ({ nickname })));
    const parents = homes.map(
      (home) =>
        list.sessions.find(
          (session) => session.home === home.nickname && session.title === "Synthetic trace",
        )!,
    );
    const [personal, work] = parents;
    expect(await hub.interaction.describe(personal!.id)).toMatchObject({
      state: "superseded",
      supersededBySessionId: work!.id,
    });
    expect(await hub.interaction.describe(work!.id)).toMatchObject({ state: "connected" });
    const personalPage = (await hub.sessions.getItems(personal!.id, { limit: 300 }))!;
    const workPage = (await hub.sessions.getItems(work!.id, { limit: 300 }))!;
    await appendFile(
      rollout(0),
      JSON.stringify({
        timestamp: "2026-07-28T13:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Personal update only" }],
        },
      }) + "\n",
    );
    await hub.sessions.refresh();
    const updates = await hub.updates.wait(personal!.id, {
      cursor: personalPage.cursor,
      after: "unseen" as UpdateRevision,
    });
    expect(updates!.hasMore).toBe(true);
    expect(updates!.session.origin.home).toBe(personal!.home);
    const other = await hub.updates.wait(work!.id, {
      cursor: workPage.cursor,
      after: "unseen" as UpdateRevision,
    });
    expect(other!.hasMore).toBe(false);
  } finally {
    hub.close();
    connect.mockRestore();
  }
});

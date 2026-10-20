import { expect, it, vi } from "vitest";

import { CodexSessionManager } from "../../src/server/adapters/codex/session-manager.js";
import { TmuxLauncher } from "../../src/server/interaction/tmux-launcher.js";

it.each([
  [false, undefined, []],
  [true, false, ["--worktree"]],
  [false, true, ["--yolo"]],
  [true, true, ["--worktree", "--yolo"]],
] as const)(
  "passes only enabled creation flags (worktree=%s, yolo=%s)",
  async (worktree, yolo, flags) => {
    const tmux = new TmuxLauncher();
    const launch = vi
      .spyOn(tmux, "launch")
      .mockResolvedValue({ socketPath: "/tmp/test", paneId: "%1" });
    const manager = new CodexSessionManager("/codex-home", tmux);
    await manager.launch({
      operationId: "54c105aa-3622-45bc-b4c4-e0fa9110d399",
      directory: "/project with spaces",
      worktree,
      yolo: yolo ?? false,
    });
    const args = launch.mock.calls[0]![2];
    expect(args.filter((arg) => arg === "--worktree" || arg === "--yolo")).toEqual(flags);
  },
);

it("resumes an explicit UUID in the original CODEX_HOME with an operation binding prompt", async () => {
  const tmux = new TmuxLauncher();
  const launch = vi
    .spyOn(tmux, "launch")
    .mockResolvedValue({ socketPath: "/tmp/test", paneId: "%1" });
  const manager = new CodexSessionManager("/original-home", tmux);
  const nativeId = "00000000-0000-4000-8000-000000000001";
  await manager.launch({
    operationId: "54c105aa-3622-45bc-b4c4-e0fa9110d399",
    directory: "/project",
    worktree: false,
    yolo: true,
    resumeNativeId: nativeId,
  });
  const args = launch.mock.calls[0]![2];
  expect(args.slice(0, 5)).toEqual([
    "env",
    "CODEX_HOME=/original-home",
    "codex",
    "resume",
    nativeId,
  ]);
  expect(args).toContain("--yolo");
  expect(args).not.toContain("--worktree");
  expect(args.at(-1)).toContain("54c105aa-3622-45bc-b4c4-e0fa9110d399");
  expect(manager.isValidNativeId(nativeId)).toBe(true);
  for (const resumeNativeId of ["malicious", "", "native:会话/42%"]) {
    expect(manager.isValidNativeId(resumeNativeId)).toBe(false);
    expect(() =>
      manager.launch({
        operationId: "54c105aa-3622-45bc-b4c4-e0fa9110d399",
        directory: "/project",
        worktree: false,
        yolo: false,
        resumeNativeId,
      }),
    ).toThrow(/Invalid/);
    await expect(manager.archive(resumeNativeId)).rejects.toThrow(/UUID/);
    await expect(manager.delete(resumeNativeId)).rejects.toThrow(/UUID/);
  }
  expect(launch).toHaveBeenCalledOnce();
});

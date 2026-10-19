import { spawn } from "node:child_process";

import type { TmuxBinding } from "./transport.js";

export interface PreviewSubscription {
  ready: Promise<void>;
  close(): void;
}
export type PreviewListener = (
  binding: TmuxBinding,
  change: (pane?: string) => void,
  fail: (error: Error) => void,
) => PreviewSubscription;

/** One control client per socket/session; protocol payload is never interpreted as commands. */
export function createTmuxPreviewListener(): PreviewListener {
  const connections = new Map<
    string,
    {
      subscribe(change: (pane?: string) => void, fail: (error: Error) => void): PreviewSubscription;
    }
  >();
  return (binding, change, fail) => {
    const key = JSON.stringify([binding.socketPath, binding.sessionName]);
    let connection = connections.get(key);
    if (!connection) {
      const child = spawn(
        "tmux",
        [
          "-S",
          binding.socketPath,
          "-C",
          "attach-session",
          "-f",
          // tmux may use this client as the context for separate send commands.
          // Marking it read-only also prevents those commands from writing.
          "ignore-size",
          "-E",
          "-t",
          `=${binding.sessionName}`,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const subscribers = new Set<{
        change: (pane?: string) => void;
        fail: (error: Error) => void;
      }>();
      let buffer = "";
      let settled = false;
      let stopped = false;
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      void ready.catch(() => {});
      const timer = setTimeout(() => failure(new Error("tmux listener startup timed out")), 5000);
      function failure(error: Error) {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        connections.delete(key);
        rejectReady(error);
        child.kill();
        for (const subscriber of subscribers) subscriber.fail(error);
        subscribers.clear();
      }
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, "");
          buffer = buffer.slice(end + 1);
          if (line.startsWith("%end ") && !settled) {
            settled = true;
            clearTimeout(timer);
            resolveReady();
          }
          if (line.startsWith("%error") || line.startsWith("%exit")) {
            failure(new Error("tmux control connection ended"));
            return;
          }
          const output = /^%(?:output|extended-output) (%\d+) /.exec(line);
          if (output) for (const subscriber of subscribers) subscriber.change(output[1]);
          else if (
            /^%(?:layout-change|window-add|window-close|unlinked-window-close|sessions-changed|session-changed|session-window-changed|window-pane-changed|pane-mode-changed)\b/.test(
              line,
            )
          )
            for (const subscriber of subscribers) subscriber.change();
        }
        if (buffer.length > 2_000_000) failure(new Error("tmux control line exceeds limit"));
      });
      child.stderr.resume();
      child.on("error", failure);
      child.stdin.on("error", failure);
      child.on("close", () => failure(new Error("tmux control connection closed")));
      connection = {
        subscribe(change, fail) {
          const subscriber = { change, fail };
          subscribers.add(subscriber);
          return {
            ready,
            close() {
              subscribers.delete(subscriber);
              if (!subscribers.size && !stopped) {
                stopped = true;
                clearTimeout(timer);
                rejectReady(new Error("tmux control subscription closed"));
                connections.delete(key);
                child.kill();
              }
            },
          };
        },
      };
      connections.set(key, connection);
    }
    return connection.subscribe(change, fail);
  };
}

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A complete owner directory is atomically installed; stale owners move to permanent tombstones.
 * Keeping tombstones prevents a second reclaimer from renaming a new owner's lock. */
export class HostingLock {
  private readonly token = randomUUID();
  private readonly attempt: string;
  private readonly target: string;
  private held = false;
  constructor(root: string, name: string) {
    mkdirSync(root, { recursive: true });
    this.target = join(root, name);
    this.attempt = join(root, `${name}-attempt-${this.token}`);
    mkdirSync(this.attempt);
    writeFileSync(
      join(this.attempt, "owner.json"),
      JSON.stringify({ pid: process.pid, token: this.token }),
    );
  }
  acquire(): boolean {
    for (;;) {
      try {
        renameSync(this.attempt, this.target);
        this.held = true;
        return true;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(String((error as NodeJS.ErrnoException).code)))
          throw error;
      }
      let owner: { pid: number; token: string };
      try {
        owner = JSON.parse(readFileSync(join(this.target, "owner.json"), "utf8")) as typeof owner;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !/^[a-f0-9-]{36}$/.test(owner.token))
        throw new Error("Invalid hosting lock owner");
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      try {
        renameSync(this.target, `${this.target}-dead-${owner.token}`);
      } catch (error) {
        if (
          !["ENOENT", "EEXIST", "ENOTEMPTY"].includes(String((error as NodeJS.ErrnoException).code))
        )
          throw error;
      }
    }
  }
  close(): void {
    if (this.held) {
      renameSync(this.target, this.attempt);
      this.held = false;
    }
    rmSync(this.attempt, { recursive: true, force: true });
  }
}

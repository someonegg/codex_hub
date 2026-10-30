import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { DirectoryLock } from "../directory-lock.js";
import { ResourceValidationError } from "./validation-error.js";

export const ID = /^[a-f0-9]{32}$/;
export const defaultHostingDirectory = join(homedir(), ".codex-hub", "hosting");
export interface Artifact {
  id: string;
  name: string;
  title: string;
  project: string;
  source: string;
  snapshotId: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}
interface ArtifactEntry {
  artifact: Artifact;
  directory: string;
}
function parseArtifact(json: string): Artifact {
  const value = JSON.parse(json) as Artifact;
  if (
    !value ||
    !ID.test(value.id) ||
    !ID.test(value.snapshotId) ||
    typeof value.project !== "string" ||
    typeof value.source !== "string" ||
    typeof value.name !== "string" ||
    typeof value.title !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    value.url !== `/web/${value.id}/`
  )
    throw new Error("Invalid artifact metadata");
  return value;
}
async function copySnapshot(from: string, to: string): Promise<void> {
  const info = await lstat(from);
  if (info.isDirectory()) {
    await mkdir(to);
    for (const item of await readdir(from)) {
      await copySnapshot(join(from, item), join(to, item));
    }
    return;
  }
  if (!info.isFile())
    throw new ResourceValidationError(
      `Only regular files and directories can be published: ${from}`,
    );
  await copyFile(from, to, constants.COPYFILE_EXCL);
}
function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}
export class HostingStore {
  readonly root: string;
  constructor(root = defaultHostingDirectory) {
    if (!root.trim()) throw new ResourceValidationError("Hosting directory must not be empty");
    this.root = resolve(root.startsWith("~/") ? join(homedir(), root.slice(2)) : root);
  }
  async locked<T>(action: () => Promise<T>): Promise<T> {
    const lock = new DirectoryLock(this.root, ".write-lock");
    try {
      while (!lock.acquire()) await new Promise((done) => setTimeout(done, 30));
      return await action();
    } finally {
      lock.close();
    }
  }
  async get(id: string): Promise<ArtifactEntry | undefined> {
    if (!ID.test(id)) return undefined;
    const directory = join(this.root, "artifacts", id);
    let directoryExists = false;
    try {
      const canonicalDirectory = join(await realpath(this.root), "artifacts", id);
      if ((await realpath(directory)) !== canonicalDirectory)
        throw new Error("Artifact aliases are not allowed");
      if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid artifact directory");
      directoryExists = true;
      const artifact = parseArtifact(await readFile(join(directory, "artifact.json"), "utf8"));
      if (artifact.id !== id) throw new Error("Artifact identity does not match directory");
      return { artifact, directory: canonicalDirectory };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") throw error;
      if (directoryExists || (error as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn(`Skipping damaged hosting entry ${directory}: ${String(error)}`);
      return undefined;
    }
  }
  async entries(): Promise<ArtifactEntry[]> {
    let children;
    try {
      children = await readdir(join(this.root, "artifacts"), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const results: ArtifactEntry[] = [];
    for (const child of children) {
      if (!child.isDirectory() || !ID.test(child.name)) continue;
      const entry = await this.get(child.name);
      if (entry) results.push(entry);
    }
    return results;
  }
  async publish(
    sourcePath: string,
    projectPathInput: string,
    nameInput?: string,
    title?: string,
  ): Promise<Artifact> {
    const source = await realpath(resolve(sourcePath));
    const project = await realpath(resolve(projectPathInput));
    if (!(await lstat(source)).isDirectory() || !(await lstat(project)).isDirectory())
      throw new ResourceValidationError("Source and project must be directories");
    await mkdir(this.root, { recursive: true });
    const root = await realpath(this.root);
    if (inside(source, root) || inside(root, source))
      throw new ResourceValidationError("Source must not overlap hosting storage");
    const name = nameInput ?? basename(source);
    if (!name.trim()) throw new ResourceValidationError("Artifact name must not be empty");
    if (!(await lstat(join(source, "index.html"))).isFile())
      throw new ResourceValidationError("Source requires index.html");
    return this.locked(async () => {
      const previous = (await this.entries()).find(
        ({ artifact }) => artifact.project === project && artifact.name === name,
      )?.artifact;
      const id = previous?.id ?? randomUUID().replaceAll("-", "");
      const directory = join(root, "artifacts", id);
      await mkdir(join(directory, "snapshots"), { recursive: true });
      const snapshotId = randomUUID().replaceAll("-", "");
      const temp = join(directory, "snapshots", `.tmp-${snapshotId}`);
      const metadataTemp = join(directory, `.artifact-${snapshotId}.json`);
      try {
        await copySnapshot(source, temp);
        await rename(temp, join(directory, "snapshots", snapshotId));
        const now = new Date().toISOString();
        const artifact: Artifact = {
          id,
          name,
          title: title ?? previous?.title ?? name,
          project,
          source,
          snapshotId,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          url: `/web/${id}/`,
        };
        await writeFile(metadataTemp, JSON.stringify(artifact));
        await rename(metadataTemp, join(directory, "artifact.json"));
        return artifact;
      } finally {
        await rm(temp, { recursive: true, force: true });
        await rm(metadataTemp, { force: true });
      }
    });
  }
  async delete(id: string): Promise<boolean> {
    return this.locked(async () => {
      const entry = await this.get(id);
      if (!entry) return false;
      await rm(entry.directory, { recursive: true });
      return true;
    });
  }
}

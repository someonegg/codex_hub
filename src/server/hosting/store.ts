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

import { HostingLock } from "./lock.js";

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
function segment(value: string): string {
  return encodeURIComponent(value).replaceAll(".", "%2E");
}
function projectPath(project: string): string {
  return project
    .split(sep)
    .filter(Boolean)
    .map((part) => part.replaceAll("%", "%25").replace(/^\.hub$/, "%2Ehub"))
    .join(sep);
}
function artifactDirectory(root: string, project: string, name: string): string {
  return join(root, "projects", projectPath(project), ".hub", "artifacts", segment(name));
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
    throw new Error(`Only regular files and directories can be published: ${from}`);
  await copyFile(from, to, constants.COPYFILE_EXCL);
}
function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}
export class HostingStore {
  readonly root: string;
  constructor(root = defaultHostingDirectory) {
    if (!root.trim()) throw new Error("Hosting directory must not be empty");
    this.root = resolve(root.startsWith("~/") ? join(homedir(), root.slice(2)) : root);
  }
  async locked<T>(action: () => Promise<T>): Promise<T> {
    const lock = new HostingLock(this.root, ".write-lock");
    try {
      while (!lock.acquire()) await new Promise((done) => setTimeout(done, 30));
      return await action();
    } finally {
      lock.close();
    }
  }
  async entries(): Promise<{ artifact: Artifact; directory: string }[]> {
    let root: string;
    try {
      root = await realpath(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const results: { artifact: Artifact; directory: string }[] = [];
    const walk = async (directory: string): Promise<void> => {
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        const path = join(directory, child.name);
        if (child.name !== ".hub") {
          await walk(path);
          continue;
        }
        let names;
        try {
          names = await readdir(join(path, "artifacts"));
        } catch {
          continue;
        }
        for (const name of names) {
          const entry = join(path, "artifacts", name);
          try {
            if (!(await lstat(entry)).isDirectory()) continue;
            const artifact = parseArtifact(await readFile(join(entry, "artifact.json"), "utf8"));
            if (artifactDirectory(root, artifact.project, artifact.name) !== entry)
              throw new Error("Artifact path does not match metadata");
            results.push({ artifact, directory: entry });
          } catch (error) {
            console.warn(`Skipping damaged hosting entry ${entry}: ${String(error)}`);
          }
        }
      }
    };
    await walk(join(root, "projects"));
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
      throw new Error("Source and project must be directories");
    await mkdir(this.root, { recursive: true });
    const root = await realpath(this.root);
    if (inside(source, root) || inside(root, source))
      throw new Error("Source must not overlap hosting storage");
    const name = nameInput ?? basename(source);
    if (!name.trim()) throw new Error("Artifact name must not be empty");
    if (!(await lstat(join(source, "index.html"))).isFile())
      throw new Error("Source requires index.html");
    return this.locked(async () => {
      const directory = artifactDirectory(root, project, name);
      await mkdir(join(directory, "snapshots"), { recursive: true });
      let previous: Artifact | undefined;
      try {
        previous = parseArtifact(await readFile(join(directory, "artifact.json"), "utf8"));
        if (previous.project !== project || previous.name !== name)
          throw new Error("Artifact identity does not match metadata");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const snapshotId = randomUUID().replaceAll("-", "");
      const temp = join(directory, "snapshots", `.tmp-${snapshotId}`);
      const metadataTemp = join(directory, `.artifact-${snapshotId}.json`);
      try {
        await copySnapshot(source, temp);
        await rename(temp, join(directory, "snapshots", snapshotId));
        const id = previous?.id ?? randomUUID().replaceAll("-", "");
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
      const entry = (await this.entries()).find((entry) => entry.artifact.id === id);
      if (!entry) return false;
      await rm(entry.directory, { recursive: true });
      return true;
    });
  }
}

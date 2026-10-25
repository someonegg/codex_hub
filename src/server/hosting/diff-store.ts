import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { HostingStore } from "./store.js";

export const DIFF_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface DiffMetadata {
  id: string;
  title: string;
  createdAt: string;
  url: string;
}
export class DiffStore {
  private hosting: HostingStore;
  constructor(root?: string) {
    this.hosting = new HostingStore(root);
  }
  private directory(id: string) {
    return join(this.hosting.root, "diffs", id);
  }
  private async metadata(id: string): Promise<DiffMetadata | null> {
    if (!DIFF_ID.test(id)) return null;
    try {
      const directory = this.directory(id);
      const metadata = JSON.parse(
        await readFile(join(directory, "metadata.json"), "utf8"),
      ) as DiffMetadata;
      if (
        metadata.id !== id ||
        metadata.url !== `/diffs/${id}` ||
        typeof metadata.title !== "string" ||
        !Number.isFinite(Date.parse(metadata.createdAt))
      )
        throw new Error("Invalid diff metadata");
      return metadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async exists(id: string): Promise<boolean> {
    if (!(await this.metadata(id))) return false;
    try {
      return (await lstat(join(this.directory(id), "raw.diff"))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async get(id: string): Promise<(DiffMetadata & { raw: string }) | null> {
    const metadata = await this.metadata(id);
    if (!metadata) return null;
    try {
      return { ...metadata, raw: await readFile(join(this.directory(id), "raw.diff"), "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async list(): Promise<DiffMetadata[]> {
    let names: string[];
    try {
      names = await readdir(join(this.hosting.root, "diffs"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries = await Promise.all(
      names.filter((id) => DIFF_ID.test(id)).map((id) => this.metadata(id)),
    );
    return entries.filter((entry) => entry !== null);
  }
  async publish(file: string, title?: string): Promise<DiffMetadata> {
    if (!(await lstat(file)).isFile()) throw new Error("Diff source must be a regular file");
    const raw = await readFile(file);
    return this.hosting.locked(async () => {
      const id = randomUUID();
      const metadata = {
        id,
        title: title ?? basename(file),
        createdAt: new Date().toISOString(),
        url: `/diffs/${id}`,
      };
      const temporary = this.directory(`.tmp-${id}`);
      await mkdir(temporary, { recursive: true });
      try {
        await writeFile(join(temporary, "raw.diff"), raw);
        await writeFile(join(temporary, "metadata.json"), JSON.stringify(metadata));
        await rename(temporary, this.directory(id));
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      return metadata;
    });
  }
  async delete(id: string): Promise<void> {
    if (!DIFF_ID.test(id)) throw new Error("Invalid diff UUID");
    await this.hosting.locked(() => rm(this.directory(id), { recursive: true, force: true }));
  }
}

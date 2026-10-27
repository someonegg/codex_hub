import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import type { UploadAttachment } from "../../shared/uploads.js";

const ATTACHMENT_ID_PATTERN = /^[a-f0-9-]{36}$/;

export interface UploadCleanup {
  cleanup(id: string): Promise<void>;
}

export class UploadStore implements UploadCleanup {
  constructor(readonly directory: string) {}
  private folder(id: string) {
    return join(this.directory, createHash("sha256").update(id).digest("hex"));
  }
  async cleanup(id: string) {
    const tombstone = this.folder(id) + ".deleting";
    await rename(this.folder(id), tombstone).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rm(tombstone, { recursive: true, force: true });
  }
  async upload(id: string, filename: string, type: string, chunks: AsyncIterable<Uint8Array>) {
    const folder = this.folder(id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const attachmentId = randomUUID();
    const extension = extname(filename);
    const path = join(
      folder,
      attachmentId + (/^\.[a-zA-Z0-9]{1,16}$/.test(extension) ? extension : ""),
    );
    const file = await open(path, "wx", 0o600);
    let complete = false;
    try {
      let size = 0;
      for await (const chunk of chunks) {
        size += chunk.byteLength;
        await file.writeFile(chunk);
      }
      await file.sync();
      await file.close();
      const attachment: UploadAttachment = {
        id: attachmentId,
        sessionId: id,
        filename,
        size,
        type,
        uploadedAt: new Date().toISOString(),
        path,
      };
      const temporary = join(folder, attachmentId + ".meta.pending");
      await writeFile(temporary, JSON.stringify(attachment), { mode: 0o600 });
      await rename(temporary, join(folder, attachmentId + ".meta.json"));
      complete = true;
      return attachment;
    } finally {
      if (!complete) {
        await file.close().catch(() => undefined);
        await rm(path, { force: true });
        await rm(join(folder, attachmentId + ".meta.pending"), { force: true });
      }
    }
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const folder of await readdir(this.directory, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      try {
        if (/^[a-f0-9]{64}\.deleting$/.test(folder.name)) {
          await rm(join(this.directory, folder.name), { recursive: true, force: true });
        } else if (/^[a-f0-9]{64}$/.test(folder.name)) {
          await this.recover(join(this.directory, folder.name));
        }
      } catch (error) {
        // Recovery is best effort and must not prevent startup.
        console.error("Upload recovery failed", error);
      }
    }
  }

  private async recover(folder: string) {
    const names = await readdir(folder);
    for (const name of names) {
      if (name.endsWith(".meta.deleting")) {
        await this.finishDeletion(join(folder, name));
      } else if (
        name.endsWith(".meta.pending") ||
        (/^[a-f0-9-]{36}(?:\.[a-zA-Z0-9]{1,16})?$/.test(name) &&
          !names.includes(name.slice(0, 36) + ".meta.json") &&
          !names.includes(name.slice(0, 36) + ".meta.deleting"))
      ) {
        await rm(join(folder, name), { force: true });
      }
    }
  }
  async list(id: string) {
    const folder = this.folder(id);
    const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const entries: UploadAttachment[] = [];
    for (const name of names) {
      if (!name.endsWith(".meta.json")) continue;
      try {
        entries.push(JSON.parse(await readFile(join(folder, name), "utf8")) as UploadAttachment);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    entries.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || b.id.localeCompare(a.id));
    return entries;
  }
  async get(id: string, attachmentId: string): Promise<UploadAttachment | null> {
    if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) return null;
    try {
      return JSON.parse(await readFile(join(this.folder(id), attachmentId + ".meta.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async delete(id: string, attachmentId: string) {
    if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) return;
    const metadata = join(this.folder(id), attachmentId + ".meta.json");
    const tombstone = join(this.folder(id), attachmentId + ".meta.deleting");
    await rename(metadata, tombstone).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await this.finishDeletion(tombstone);
  }
  private async finishDeletion(tombstone: string) {
    let attachment: UploadAttachment;
    try {
      attachment = JSON.parse(await readFile(tombstone, "utf8")) as UploadAttachment;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rm(attachment.path, { force: true });
    await rm(tombstone, { force: true });
  }
}

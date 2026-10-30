import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
  lstat,
  realpath,
} from "node:fs/promises";
import { extname, join, resolve, dirname, basename, isAbsolute } from "node:path";

import type { UploadAttachment } from "../../shared/uploads.js";
import { isOpaqueId } from "../security/opaque-id.js";

const ATTACHMENT_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function validAttachmentId(id: string) {
  return ATTACHMENT_ID_PATTERN.test(id);
}

export interface UploadCleanup {
  cleanup(id: string): Promise<void>;
}

export class UploadStore implements UploadCleanup {
  constructor(readonly directory: string) {}
  private folder(id: string) {
    if (!isOpaqueId(id)) throw new Error("Invalid session ID");
    return resolve(this.directory, id);
  }
  async cleanup(id: string) {
    const folder = this.folder(id);
    await this.safeFolder(folder);
    const tombstone = folder + ".deleting";
    await this.safeFolder(tombstone);
    await rename(folder, tombstone).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rm(tombstone, { recursive: true, force: true });
  }
  async upload(id: string, filename: string, type: string, chunks: AsyncIterable<Uint8Array>) {
    const folder = this.folder(id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await this.safeFolder(folder);
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
        if (folder.name.endsWith(".deleting") && isOpaqueId(folder.name.slice(0, -9))) {
          await this.safeFolder(join(this.directory, folder.name));
          await rm(join(this.directory, folder.name), { recursive: true, force: true });
        } else if (isOpaqueId(folder.name)) {
          await this.recover(join(this.directory, folder.name));
        }
      } catch (error) {
        // Recovery is best effort and must not prevent startup.
        console.error("Upload recovery failed", error);
      }
    }
  }

  private async recover(folder: string) {
    await this.safeFolder(folder);
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
    await this.safeFolder(folder);
    const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const entries: UploadAttachment[] = [];
    for (const name of names) {
      if (!name.endsWith(".meta.json")) continue;
      try {
        entries.push(await this.metadata(join(folder, name), id, name.slice(0, -10)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    entries.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || b.id.localeCompare(a.id));
    return entries;
  }
  async get(id: string, attachmentId: string): Promise<UploadAttachment | null> {
    const folder = this.folder(id);
    if (!validAttachmentId(attachmentId)) throw new Error("Invalid attachment ID");
    try {
      return await this.metadata(join(folder, attachmentId + ".meta.json"), id, attachmentId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async delete(id: string, attachmentId: string) {
    const folder = this.folder(id);
    if (!validAttachmentId(attachmentId)) throw new Error("Invalid attachment ID");
    await this.get(id, attachmentId);
    const metadata = join(folder, attachmentId + ".meta.json");
    const tombstone = join(folder, attachmentId + ".meta.deleting");
    await rename(metadata, tombstone).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await this.finishDeletion(tombstone);
  }
  private async safeFolder(folder: string) {
    let root: string;
    try {
      root = await realpath(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (dirname(resolve(folder)) !== resolve(this.directory))
      throw new Error("Invalid upload directory");
    try {
      const stat = await lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(await realpath(folder)) !== root)
        throw new Error("Unsafe upload directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async safeFile(path: string, folder: string) {
    await this.safeFolder(folder);
    if (dirname(resolve(path)) !== resolve(folder)) throw new Error("Invalid upload path");
    try {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        dirname(await realpath(path)) !== (await realpath(folder))
      )
        throw new Error("Unsafe upload file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async metadata(
    path: string,
    id: string,
    attachmentId: string,
  ): Promise<UploadAttachment> {
    const folder = this.folder(id);
    if (!validAttachmentId(attachmentId)) throw new Error("Invalid attachment metadata ID");
    await this.safeFile(path, folder);
    const value = JSON.parse(await readFile(path, "utf8")) as UploadAttachment;
    if (
      !value ||
      value.id !== attachmentId ||
      value.sessionId !== id ||
      typeof value.filename !== "string" ||
      typeof value.type !== "string" ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      typeof value.uploadedAt !== "string" ||
      !Number.isFinite(Date.parse(value.uploadedAt)) ||
      typeof value.path !== "string" ||
      !isAbsolute(value.path) ||
      dirname(resolve(value.path)) !== folder ||
      !new RegExp("^" + attachmentId + "(?:\\.[a-zA-Z0-9]{1,16})?$").test(basename(value.path))
    )
      throw new Error("Corrupt upload metadata");
    await this.safeFile(value.path, folder);
    return value;
  }
  private async finishDeletion(tombstone: string) {
    let attachment: UploadAttachment;
    try {
      attachment = await this.metadata(
        tombstone,
        basename(dirname(tombstone)),
        basename(tombstone).replace(/\.meta\.deleting$/, ""),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rm(attachment.path, { force: true });
    await rm(tombstone, { force: true });
  }
}

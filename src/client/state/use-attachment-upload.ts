import { useEffect, useRef, useState } from "react";

import { MAX_UPLOAD_BYTES } from "../../shared/uploads";

import { api } from "../api/client";
import type { DraftAttachment } from "./session-drafts";

export function useAttachmentUpload(
  sessionId: string,
  previewConnected: boolean,
  interactionBusy: boolean,
  addAttachment: (attachment: DraftAttachment) => void,
) {
  const upload = useRef<AbortController | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  useEffect(() => {
    upload.current = null;
    return () => upload.current?.abort();
  }, []);
  const uploadFiles = async (files: File[]) => {
    if (!files.length || upload.current || interactionBusy || !previewConnected) return;
    setUploadError(null);
    if (files.some((file) => file.size > MAX_UPLOAD_BYTES)) {
      setUploadError("Files must be at most 20 MiB");
      return;
    }
    const controller = new AbortController();
    upload.current = controller;
    try {
      for (const [index, file] of files.entries()) {
        setUploadProgress(`Uploading ${index + 1}/${files.length}…`);
        const result = await api.upload(normalizeImageFile(file), controller.signal, sessionId);
        if (controller.signal.aborted) return;
        addAttachment({
          id: result.id,
          file,
          path: result.path,
        });
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setUploadError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      if (!controller.signal.aborted) {
        upload.current = null;
        setUploadProgress(null);
      }
    }
    return !controller.signal.aborted;
  };
  return {
    uploadFiles,
    uploadProgress,
    uploadError,
    setUploadError,
    isUploading: () => upload.current !== null,
  };
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/x-icon": "ico",
};

function normalizeImageFile(file: File): File {
  const extension = IMAGE_EXTENSIONS[file.type];
  if (/\.[a-zA-Z0-9]{1,16}$/.test(file.name) || !extension) return file;
  return new File([file], `${file.name || "clipboard"}.${extension}`, { type: file.type });
}

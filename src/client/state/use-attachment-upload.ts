import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { MAX_UPLOAD_BYTES } from "../../shared/uploads";

import { api } from "../api/client";
import { t } from "../i18n";
import { LocalizedError } from "../i18n/localized-error";
import type { DraftAttachment } from "./session-drafts";

export function useAttachmentUpload(
  sessionId: string,
  previewConnected: boolean,
  interactionBusy: boolean,
  addAttachment: (attachment: DraftAttachment) => void,
) {
  useTranslation();
  const upload = useRef<AbortController | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(
    null,
  );
  const [uploadError, setUploadError] = useState<Error | null>(null);
  useEffect(() => {
    upload.current = null;
    return () => upload.current?.abort();
  }, []);
  const uploadFiles = async (files: File[]) => {
    if (!files.length || upload.current || interactionBusy || !previewConnected) return;
    setUploadError(null);
    if (files.some((file) => file.size > MAX_UPLOAD_BYTES)) {
      setUploadError(new LocalizedError("filesMustBeAtMost20MiB"));
      return;
    }
    const controller = new AbortController();
    upload.current = controller;
    try {
      for (const [index, file] of files.entries()) {
        setUploadProgress({ current: index + 1, total: files.length });
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
        setUploadError(error instanceof Error ? error : new LocalizedError("uploadFailed"));
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
    uploadProgress: uploadProgress ? t("uploadProgress", uploadProgress) : null,
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

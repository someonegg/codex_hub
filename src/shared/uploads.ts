export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function isPreviewableUploadType(type: string): boolean {
  return /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(type);
}

export function supportsUploadThumbnail(type: string): boolean {
  return isPreviewableUploadType(type) && type !== "image/bmp";
}

export interface UploadAttachment {
  id: string;
  sessionId: string;
  filename: string;
  size: number;
  type: string;
  uploadedAt: string;
  path: string;
}

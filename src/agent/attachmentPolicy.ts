export const MAX_CONTEXT_FILE_ATTACHMENTS = 6;
export const MAX_CONTEXT_FILE_BYTES = 256 * 1024;
export const MAX_CONTEXT_FILE_CHARS = 24_000;
export const MAX_IMAGE_ATTACHMENTS = 6;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const SUPPORTED_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};

export function imageMimeTypeForPath(filePath: string) {
  const extension = /\.([^.]+)$/.exec(filePath)?.[1]?.toLowerCase();
  return extension ? SUPPORTED_IMAGE_MIME_BY_EXTENSION[extension] : undefined;
}

export function countAttachmentLines(text: string) {
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
}

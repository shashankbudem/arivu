import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  countAttachmentLines,
  imageMimeTypeForPath,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_FILE_CHARS,
  MAX_IMAGE_BYTES
} from "../../src/agent/attachmentPolicy.js";
import type { PromptImageAttachment as ImageAttachment } from "../../src/agent/promptPayload.js";
import { appDataDir } from "../../src/config.js";
import { relativeToWorkspace, resolveSafeWorkspacePath } from "../../src/tools/pathSafety.js";


export type LocalImageResult = {
  mimeType: string;
  size: number;
  dataUrl: string;
};

export type ContextFileAttachment = {
  id: string;
  path: string;
  name: string;
  size: number;
  lineCount: number;
  content: string;
  truncated: boolean;
};

export async function readImageAttachment(filePath: string): Promise<ImageAttachment> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`${path.basename(filePath)} is not a file.`);
  }
  if (fileStat.size > MAX_IMAGE_BYTES) {
    throw new Error(`${path.basename(filePath)} is larger than ${formatBytes(MAX_IMAGE_BYTES)}.`);
  }

  const mimeType = imageMimeTypeForPath(filePath);
  if (!mimeType) {
    throw new Error(`${path.basename(filePath)} is not a supported image type.`);
  }

  const data = await readFile(filePath);
  return {
    id: randomUUID(),
    name: path.basename(filePath),
    mimeType,
    size: fileStat.size,
    dataUrl: `data:${mimeType};base64,${data.toString("base64")}`,
    detail: "auto"
  };
}

export async function readContextFileAttachment(workspaceRoot: string, filePath: string): Promise<ContextFileAttachment> {
  const target = await resolveSafeWorkspacePath(workspaceRoot, filePath);
  const fileStat = await stat(target);
  if (!fileStat.isFile()) {
    throw new Error(`${path.basename(target)} is not a file.`);
  }
  if (fileStat.size > MAX_CONTEXT_FILE_BYTES) {
    throw new Error(`${path.basename(target)} is larger than ${formatBytes(MAX_CONTEXT_FILE_BYTES)}.`);
  }

  const data = await readFile(target);
  if (data.includes(0)) {
    throw new Error(`${path.basename(target)} looks like a binary file.`);
  }

  const fullContent = data.toString("utf8");
  const truncated = fullContent.length > MAX_CONTEXT_FILE_CHARS;
  const content = truncated ? fullContent.slice(0, MAX_CONTEXT_FILE_CHARS) : fullContent;
  return {
    id: randomUUID(),
    path: relativeToWorkspace(workspaceRoot, target),
    name: path.basename(target),
    size: fileStat.size,
    lineCount: countAttachmentLines(content),
    content,
    truncated
  };
}

export function isAllowedBrowserScreenshotPath(filePath: string) {
  if (!path.basename(filePath).startsWith("arivu-browser-") && !path.basename(filePath).startsWith("annotation-")) {
    return false;
  }
  if (!imageMimeTypeForPath(filePath)) {
    return false;
  }

  return (
    isInsideDirectory(path.join(appDataDir(), "browser-screenshots"), filePath) ||
    isInsideDirectory(path.join(appDataDir(), "browser-annotations"), filePath) ||
    path.dirname(filePath) === path.resolve(os.tmpdir())
  );
}

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function isInsideDirectory(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

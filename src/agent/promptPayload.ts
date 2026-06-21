import { randomUUID } from "node:crypto";
import { textPart, type ChatContent, type ChatContentPart, type ImageDetail } from "./content.js";

export const MAX_PROMPT_IMAGE_ATTACHMENTS = 6;
export const MAX_PROMPT_IMAGE_BYTES = 10 * 1024 * 1024;

export type PromptImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  detail?: ImageDetail;
};

export type PromptPayload = unknown;

export type PromptLoopOptions = {
  enabled: boolean;
  maxIterations: number;
};

export function normalizePromptPayload(payload: PromptPayload): ChatContent {
  if (typeof payload === "string") {
    return payload.trim();
  }

  if (!isRecord(payload)) {
    return "";
  }

  if (payload.content !== undefined) {
    return normalizeChatContent(payload.content);
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const images = Array.isArray(payload.images) ? payload.images.slice(0, MAX_PROMPT_IMAGE_ATTACHMENTS) : [];
  const parts: ChatContentPart[] = [];
  if (text) {
    parts.push(textPart(text));
  }
  parts.push(...images.map((image) => attachmentToImagePart(normalizeImageAttachment(image))));

  if (parts.length === 1 && parts[0]?.type === "text") {
    return parts[0].text;
  }
  return parts;
}

export function normalizePromptSkillNames(payload: PromptPayload): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.skills)) {
    return [];
  }

  const names = new Set<string>();
  for (const value of payload.skills) {
    if (typeof value !== "string") {
      continue;
    }
    const name = value.trim().replace(/^[$/]+/, "");
    if (/^[a-zA-Z0-9._-]+$/.test(name)) {
      names.add(name);
    }
  }
  return Array.from(names);
}

export function normalizePromptReuseLastUserMessage(payload: PromptPayload): boolean {
  return isRecord(payload) && payload.reuseLastUserMessage === true;
}

export function normalizePromptLoopOptions(payload: PromptPayload): PromptLoopOptions {
  if (!isRecord(payload)) {
    return { enabled: false, maxIterations: 5 };
  }

  const loop = payload.loop;
  if (loop === true) {
    return { enabled: true, maxIterations: 5 };
  }
  if (!isRecord(loop)) {
    return { enabled: false, maxIterations: 5 };
  }

  const enabled = loop.enabled === true;
  const rawMaxIterations = typeof loop.maxIterations === "number" ? loop.maxIterations : 5;
  return {
    enabled,
    maxIterations: clampInteger(rawMaxIterations, 1, 10)
  };
}

function normalizeChatContent(content: unknown): ChatContent {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    throw new Error("Prompt content must be text or content parts.");
  }

  let imageCount = 0;
  const parts = content.flatMap((part) => {
    if (!isRecord(part)) {
      throw new Error("Prompt content parts must be objects.");
    }

    if (part.type === "text") {
      return typeof part.text === "string" ? [textPart(part.text.trim())] : [];
    }

    if (part.type !== "image_url") {
      throw new Error("Unsupported prompt content part.");
    }

    if (imageCount >= MAX_PROMPT_IMAGE_ATTACHMENTS) {
      return [];
    }
    const imageUrl = isRecord(part.image_url) ? part.image_url : undefined;
    const url = typeof imageUrl?.url === "string" ? imageUrl.url : "";
    if (!url) {
      throw new Error("Image content parts must include an image URL.");
    }
    imageCount += 1;
    return attachmentToImagePart({
      id: randomUUID(),
      name: typeof part.name === "string" ? part.name : "image",
      mimeType: typeof part.mimeType === "string" ? part.mimeType : mimeTypeFromDataUrl(url),
      size: typeof part.size === "number" ? part.size : imageByteLength(url),
      dataUrl: url,
      detail: normalizeImageDetail(imageUrl?.detail)
    });
  });
  const filtered = parts.filter((part) => part.type !== "text" || part.text.length > 0);
  if (filtered.length === 1 && filtered[0]?.type === "text") {
    return filtered[0].text;
  }
  return filtered;
}

function normalizeImageAttachment(image: unknown): PromptImageAttachment {
  if (!isRecord(image)) {
    throw new Error("Image attachments must be objects.");
  }

  const dataUrl = typeof image.dataUrl === "string" ? image.dataUrl : "";
  if (!dataUrl) {
    throw new Error("Image attachments must include a data URL.");
  }

  return {
    id: typeof image.id === "string" ? image.id : randomUUID(),
    name: typeof image.name === "string" ? image.name : "image",
    mimeType: typeof image.mimeType === "string" ? image.mimeType : mimeTypeFromDataUrl(dataUrl),
    size: typeof image.size === "number" ? image.size : imageByteLength(dataUrl),
    dataUrl,
    detail: normalizeImageDetail(image.detail)
  };
}

function attachmentToImagePart(image: PromptImageAttachment): ChatContentPart {
  const mimeType = normalizeImageMimeType(image.mimeType || mimeTypeFromDataUrl(image.dataUrl));
  const size = image.size || imageByteLength(image.dataUrl);
  if (!isImageDataUrl(image.dataUrl, mimeType)) {
    throw new Error(`${image.name || "Image"} must be a PNG, JPEG, WebP, or GIF data URL.`);
  }
  if (size > MAX_PROMPT_IMAGE_BYTES) {
    throw new Error(`${image.name || "Image"} is larger than ${formatBytes(MAX_PROMPT_IMAGE_BYTES)}.`);
  }

  return {
    type: "image_url",
    image_url: {
      url: image.dataUrl,
      detail: normalizeImageDetail(image.detail)
    },
    name: image.name,
    mimeType,
    size
  };
}

function mimeTypeFromDataUrl(dataUrl: string) {
  const match = /^data:([^;,]+);base64,/i.exec(dataUrl);
  return normalizeImageMimeType(match?.[1] ?? "");
}

function normalizeImageMimeType(value: string) {
  const lower = value.toLowerCase();
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(lower)) {
    return lower;
  }
  throw new Error(`Unsupported image type: ${value || "unknown"}.`);
}

function isImageDataUrl(dataUrl: string, mimeType: string) {
  return dataUrl.startsWith(`data:${mimeType};base64,`);
}

function imageByteLength(dataUrl: string) {
  const encoded = dataUrl.split(",", 2)[1] ?? "";
  return Buffer.byteLength(encoded, "base64");
}

function normalizeImageDetail(value: unknown): ImageDetail {
  return value === "auto" || value === "low" || value === "high" ? value : "auto";
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatBytes(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

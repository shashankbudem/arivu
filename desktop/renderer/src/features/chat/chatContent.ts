import { randomId } from "../../shared/id";
import { parseMaybeJson } from "../../shared/json";
import { formatBytes } from "../../format";
import { promptTextWithFileContext } from "../../../../../src/agent/fileContext";

export const MAX_IMAGE_ATTACHMENTS = 6;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const MAX_CONTEXT_FILE_ATTACHMENTS = 6;

export const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const SUPPORTED_IMAGE_EXTENSIONS: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};

export function createPromptContent(text: string, images: ImageAttachment[], files: ContextFileAttachment[] = []): ChatContent {
  const trimmed = promptTextWithFileContext(text, files);
  const parts: ChatContentPart[] = [];
  if (trimmed) {
    parts.push({ type: "text", text: trimmed });
  }
  parts.push(
    ...images.map((image) => ({
      type: "image_url" as const,
      image_url: {
        url: image.dataUrl,
        detail: image.detail ?? "auto"
      },
      name: image.name,
      mimeType: image.mimeType,
      size: image.size
    }))
  );

  if (parts.length === 1 && parts[0]?.type === "text") {
    return parts[0].text;
  }
  return parts;
}

export function imageFilesFromClipboard(clipboard: DataTransfer) {
  return imageFilesFromDataTransfer(clipboard);
}

export function imageFilesFromDataTransfer(dataTransfer: DataTransfer) {
  const files = Array.from(dataTransfer.files).filter(isSupportedImageFile);
  if (files.length > 0) {
    return files;
  }

  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file" && SUPPORTED_IMAGE_TYPES.has(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file && isSupportedImageFile(file)));
}

export function hasPotentialImageTransfer(dataTransfer: DataTransfer) {
  return (
    Array.from(dataTransfer.files).some(isSupportedImageFile) ||
    Array.from(dataTransfer.items).some((item) => item.kind === "file" && (item.type === "" || SUPPORTED_IMAGE_TYPES.has(item.type)))
  );
}

export function hasFileTransfer(dataTransfer: DataTransfer) {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.items).some((item) => item.kind === "file");
}

export function isSupportedImageFile(file: File) {
  return Boolean(imageMimeTypeForFile(file));
}

export function imageMimeTypeForFile(file: File) {
  const type = file.type.toLowerCase();
  if (SUPPORTED_IMAGE_TYPES.has(type)) {
    return type;
  }
  const extension = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase();
  return extension ? SUPPORTED_IMAGE_EXTENSIONS[extension] : undefined;
}

export async function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  const mimeType = imageMimeTypeForFile(file);
  if (!mimeType) {
    throw new Error(`${file.name || "Image"} must be a PNG, JPEG, WebP, or GIF file.`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`${file.name || "Image"} is larger than ${formatBytes(MAX_IMAGE_BYTES)}.`);
  }

  return {
    id: randomId(),
    name: file.name || `pasted-image-${Date.now()}`,
    mimeType,
    size: file.size,
    dataUrl: normalizeImageDataUrlMime(await readFileAsDataUrl(file), mimeType),
    detail: "auto"
  };
}

export function normalizeImageDataUrlMime(dataUrl: string, mimeType: string) {
  return dataUrl.startsWith("data:;base64,") ? dataUrl.replace("data:;base64,", `data:${mimeType};base64,`) : dataUrl;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image data."));
    reader.readAsDataURL(file);
  });
}

export function chatContentToText(content: ChatContent): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      const name = part.name ? ` ${part.name}` : "";
      const mimeType = part.mimeType ? `, ${part.mimeType}` : "";
      return `[Image${name}${mimeType}]`;
    })
    .filter(Boolean)
    .join("\n");
}

export function chatContentTextOnly(content: ChatContent): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part): part is ChatTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function chatContentHasText(content: ChatContent): boolean {
  return chatContentToText(content).trim().length > 0;
}

export function chatContentHasRenderableContent(content: ChatContent): boolean {
  return chatContentHasText(content) || imagePartsFromContent(content).length > 0;
}

export function chatContentEquals(left: ChatContent, right: ChatContent) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function imagePartsFromContent(content: ChatContent): ChatImagePart[] {
  return Array.isArray(content) ? content.filter((part): part is ChatImagePart => part.type === "image_url") : [];
}

export function imageAttachmentsFromContent(content: ChatContent): ImageAttachment[] {
  return imagePartsFromContent(content).map((part, index) => ({
    id: `restored-${index}-${part.image_url.url.slice(0, 32)}`,
    name: part.name ?? `image-${index + 1}`,
    mimeType: part.mimeType ?? mimeTypeFromDataUrl(part.image_url.url),
    size: part.size ?? 0,
    dataUrl: part.image_url.url,
    detail: part.image_url.detail
  }));
}

export function mergeImageAttachments(current: ImageAttachment[], next: ImageAttachment[]) {
  const byId = new Map(current.map((image) => [image.id, image]));
  for (const image of next) {
    byId.set(image.id, image);
  }
  return Array.from(byId.values()).slice(0, MAX_IMAGE_ATTACHMENTS);
}

export function mergeFileAttachments(current: ContextFileAttachment[], next: ContextFileAttachment[]) {
  const byPath = new Map(current.map((file) => [file.path, file]));
  for (const file of next) {
    byPath.set(file.path, file);
  }
  return Array.from(byPath.values()).slice(0, MAX_CONTEXT_FILE_ATTACHMENTS);
}

export function mimeTypeFromDataUrl(dataUrl: string) {
  return /^data:([^;,]+);base64,/i.exec(dataUrl)?.[1] ?? "image";
}

export function findLastUserMessage(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return { index, content: message.content };
    }
  }
  return null;
}

export function applyStreamEventToMessages(messages: ChatMessage[], event: AgentStreamEvent): ChatMessage[] {
  if (event.type === "assistant_delta") {
    const { next, index } = ensureAssistantDraft(messages);
    next[index] = {
      ...next[index],
      content: `${chatContentToText(next[index].content)}${event.delta}`
    };
    return next;
  }

  if (event.type === "tool_call_delta") {
    const { next, index } = ensureAssistantDraft(messages);
    next[index] = upsertToolCall(next[index], {
      id: event.toolCallId,
      name: event.name,
      arguments: parseMaybeJson(event.argumentsText) ?? event.argumentsText
    });
    return next;
  }

  if (event.type === "tool_call") {
    const { next, index } = ensureAssistantDraft(messages);
    next[index] = upsertToolCall(next[index], event.call);
    return next;
  }

  if (event.type === "browser_task_progress" || event.type === "empty_response_retry") {
    return messages;
  }

  const existingIndex = messages.findIndex((message) => message.role === "tool" && message.toolCallId === event.toolCallId);
  if (existingIndex >= 0) {
    const next = [...messages];
    next[existingIndex] = {
      ...next[existingIndex],
      name: event.name,
      content: event.result
    };
    return next;
  }

  return [
    ...messages,
    {
      role: "tool",
      toolCallId: event.toolCallId,
      name: event.name,
      content: event.result
    }
  ];
}

export function ensureAssistantDraft(messages: ChatMessage[]) {
  const next = [...messages];
  const last = next.at(-1);
  if (last?.role === "assistant") {
    return { next, index: next.length - 1 };
  }

  // Stream events arrive before the durable backend message. Keep one timestamp for this UI-only
  // draft; the next lifecycle snapshot replaces it with the persisted transcript record.
  next.push({ role: "assistant", content: "", createdAt: new Date().toISOString() });
  return { next, index: next.length - 1 };
}

export function upsertToolCall(message: ChatMessage, call: ToolCall): ChatMessage {
  const toolCalls = [...(message.toolCalls ?? [])];
  const index = toolCalls.findIndex((existing) => existing.id === call.id);
  if (index >= 0) {
    toolCalls[index] = call;
  } else {
    toolCalls.push(call);
  }
  return {
    ...message,
    toolCalls
  };
}

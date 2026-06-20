export type ImageDetail = "auto" | "low" | "high";

export type ChatTextPart = {
  type: "text";
  text: string;
};

export type ChatImagePart = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: ImageDetail;
  };
  name?: string;
  mimeType?: string;
  size?: number;
};

export type ChatContentPart = ChatTextPart | ChatImagePart;

export type ChatContent = string | ChatContentPart[];

export function textPart(text: string): ChatTextPart {
  return { type: "text", text };
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
      return imagePartLabel(part);
    })
    .filter(Boolean)
    .join("\n");
}

export function chatContentHasText(content: ChatContent): boolean {
  return chatContentToText(content).trim().length > 0;
}

export function chatContentHasImage(content: ChatContent): boolean {
  return Array.isArray(content) && content.some((part) => part.type === "image_url");
}

export function chatContentHasRenderableContent(content: ChatContent): boolean {
  return chatContentHasText(content) || chatContentHasImage(content);
}

export function trimChatContent(content: ChatContent): ChatContent {
  if (typeof content === "string") {
    return content.trim();
  }

  const parts = content
    .map((part) => (part.type === "text" ? { ...part, text: part.text.trim() } : part))
    .filter((part) => part.type !== "text" || part.text.length > 0);
  return parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts;
}

export function imagePartLabel(part: ChatImagePart): string {
  const name = part.name ? ` ${part.name}` : "";
  const detail = part.image_url.detail ? `, detail=${part.image_url.detail}` : "";
  const mimeType = part.mimeType ? `, ${part.mimeType}` : "";
  return `[Image${name}${mimeType}${detail}]`;
}

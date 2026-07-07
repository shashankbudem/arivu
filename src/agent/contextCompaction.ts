import { chatContentToText, type ChatContent, type ChatContentPart } from "./content.js";
import type { ChatMessage } from "./types.js";

export const COMPACT_RECENT_MESSAGE_COUNT = 8;
export const AUTO_COMPACT_REQUEST_TOKEN_LIMIT = 48_000;
export const AUTO_COMPACT_REQUEST_RECENT_MESSAGE_COUNT = 8;
export const AUTO_COMPACT_REQUEST_ENTRY_CHARACTER_LIMIT = 700;
export const AUTO_COMPACT_REQUEST_RECENT_CHARACTER_LIMIT = 6_000;
export const AUTO_COMPACT_REQUEST_ACTIVE_USER_CHARACTER_LIMIT = 32_000;

const COMPACTION_PREFIX = "Context compacted locally to reduce future model requests.";
const DEFAULT_ENTRY_LIMIT = 700;

type CompactOptions = {
  recentMessageCount?: number;
  entryCharacterLimit?: number;
  recentEntryCharacterLimit?: number;
  activeUserMessageCharacterLimit?: number;
  preserveLatestUserMessage?: boolean;
  force?: boolean;
  now?: Date;
};

type ModelRequestCompactOptions = CompactOptions & {
  tokenLimit?: number;
};

export type ContextCompactionResult = {
  messages: ChatMessage[];
  compacted: boolean;
  compactedMessageCount: number;
  remainingMessageCount: number;
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
};

export function compactSessionMessages(messages: ChatMessage[], options: CompactOptions = {}): ContextCompactionResult {
  const recentMessageCount = options.recentMessageCount ?? COMPACT_RECENT_MESSAGE_COUNT;
  const entryCharacterLimit = options.entryCharacterLimit ?? DEFAULT_ENTRY_LIMIT;
  const recentEntryCharacterLimit = options.recentEntryCharacterLimit;
  const preserveLatestUserMessage = options.preserveLatestUserMessage ?? false;
  const activeUserMessageCharacterLimit = options.activeUserMessageCharacterLimit ?? recentEntryCharacterLimit;
  const systemMessages = messages.filter((message) => message.role === "system" && !isCompactionMessage(message));
  const previousCompactions = messages.filter(isCompactionMessage);
  const nonSystemMessages = messages.filter((message) => message.role !== "system");

  if (!options.force && nonSystemMessages.length <= recentMessageCount) {
    return {
      messages,
      compacted: false,
      compactedMessageCount: 0,
      remainingMessageCount: nonSystemMessages.length
    };
  }

  const recentStart = Math.max(0, nonSystemMessages.length - recentMessageCount);
  const latestUserMessageIndex = preserveLatestUserMessage ? latestUserIndex(nonSystemMessages) : -1;
  const latestUserMessage = latestUserMessageIndex >= 0 ? nonSystemMessages[latestUserMessageIndex] : undefined;
  const pinnedLatestUser =
    latestUserMessage && latestUserMessageIndex < recentStart
      ? [toPinnedUserMessage(latestUserMessage, activeUserMessageCharacterLimit)]
      : [];
  const olderMessages = nonSystemMessages.filter((_message, index) => index < recentStart && index !== latestUserMessageIndex);
  const recentMessages = nonSystemMessages.slice(recentStart).map((message, index) =>
    toPlainTranscriptMessage(
      message,
      recentStart + index === latestUserMessageIndex ? activeUserMessageCharacterLimit : recentEntryCharacterLimit,
      recentStart + index === latestUserMessageIndex && preserveLatestUserMessage
    )
  );
  const compactedAt = (options.now ?? new Date()).toISOString();
  const compactedMessage: ChatMessage = {
    role: "system",
    content: [
      COMPACTION_PREFIX,
      `Compacted at: ${compactedAt}`,
      `Compacted messages: ${olderMessages.length}`,
      "Older transcript summary:",
      buildCompactionSummary([...previousCompactions, ...olderMessages], entryCharacterLimit)
    ].join("\n")
  };

  return {
    messages: [...systemMessages, compactedMessage, ...pinnedLatestUser, ...recentMessages],
    compacted: true,
    compactedMessageCount: olderMessages.length,
    remainingMessageCount: pinnedLatestUser.length + recentMessages.length
  };
}

export function compactMessagesForModelRequest(messages: ChatMessage[], options: ModelRequestCompactOptions = {}): ContextCompactionResult {
  const tokenLimit = options.tokenLimit ?? AUTO_COMPACT_REQUEST_TOKEN_LIMIT;
  const estimatedTokensBefore = estimateMessageTokens(messages);
  if (!options.force && estimatedTokensBefore <= tokenLimit) {
    return {
      messages,
      compacted: false,
      compactedMessageCount: 0,
      remainingMessageCount: messages.filter((message) => message.role !== "system").length,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore
    };
  }

  const compacted = compactSessionMessages(messages, {
    recentMessageCount: options.recentMessageCount ?? AUTO_COMPACT_REQUEST_RECENT_MESSAGE_COUNT,
    entryCharacterLimit: options.entryCharacterLimit ?? AUTO_COMPACT_REQUEST_ENTRY_CHARACTER_LIMIT,
    recentEntryCharacterLimit: options.recentEntryCharacterLimit ?? AUTO_COMPACT_REQUEST_RECENT_CHARACTER_LIMIT,
    activeUserMessageCharacterLimit: options.activeUserMessageCharacterLimit ?? AUTO_COMPACT_REQUEST_ACTIVE_USER_CHARACTER_LIMIT,
    preserveLatestUserMessage: options.preserveLatestUserMessage ?? true,
    force: true,
    now: options.now
  });
  return {
    ...compacted,
    estimatedTokensBefore,
    estimatedTokensAfter: estimateMessageTokens(compacted.messages)
  };
}

export function estimateMessageTokens(messages: ChatMessage[]) {
  const transcript = messages.map((message) => `${message.role}: ${transcriptContent(message)}`).join("\n\n");
  return Math.ceil(transcript.length / 4);
}

function isCompactionMessage(message: ChatMessage) {
  return message.role === "system" && chatContentToText(message.content).startsWith(COMPACTION_PREFIX);
}

function buildCompactionSummary(messages: ChatMessage[], entryCharacterLimit: number) {
  if (messages.length === 0) {
    return "- No older transcript content.";
  }

  return messages.map((message) => `- ${messageLabel(message)}: ${summarizeContent(message, entryCharacterLimit)}`).join("\n");
}

function summarizeContent(message: ChatMessage, entryCharacterLimit: number) {
  const content = transcriptContent(message).replace(/\s+/g, " ").trim();
  if (!content) {
    return "(empty)";
  }
  if (content.length <= entryCharacterLimit) {
    return content;
  }
  return `${content.slice(0, Math.max(0, entryCharacterLimit - 1)).trimEnd()}...`;
}

function messageLabel(message: ChatMessage) {
  if (isCompactionMessage(message)) {
    return "Prior compacted context";
  }
  if (message.role === "assistant") {
    return "Agent";
  }
  if (message.role === "tool") {
    return message.name ? `Tool ${message.name}` : "Tool";
  }
  return "User";
}

function latestUserIndex(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && isPinnableUserMessage(message)) {
      return index;
    }
  }
  return -1;
}

function isPinnableUserMessage(message: ChatMessage) {
  const content = chatContentToText(message.content).trimStart();
  return !content.startsWith("Local tool result");
}

function toPlainTranscriptMessage(message: ChatMessage, entryCharacterLimit?: number, preserveUserContent = false): ChatMessage {
  if (preserveUserContent && message.role === "user") {
    return toPinnedUserMessage(message, entryCharacterLimit);
  }

  const content = truncateTranscriptContent(transcriptContent(message), entryCharacterLimit);
  if (message.role === "tool") {
    return {
      role: "user",
      content
    };
  }

  if (message.toolCalls?.length) {
    return {
      role: message.role,
      content
    };
  }

  return {
    role: message.role,
    content
  };
}

function toPinnedUserMessage(message: ChatMessage, entryCharacterLimit?: number): ChatMessage {
  return {
    role: "user",
    content: truncateChatContent(message.content, entryCharacterLimit)
  };
}

function truncateChatContent(content: ChatContent, entryCharacterLimit: number | undefined): ChatContent {
  if (typeof content === "string") {
    return truncateTranscriptContent(content, entryCharacterLimit);
  }
  if (!entryCharacterLimit) {
    return content.map((part) => (part.type === "text" ? { ...part } : { ...part, image_url: { ...part.image_url } }));
  }

  let remainingTextCharacters = entryCharacterLimit;
  return content
    .map((part) => {
      if (part.type === "image_url") {
        return { ...part, image_url: { ...part.image_url } };
      }
      if (remainingTextCharacters <= 0) {
        return undefined;
      }
      if (part.text.length <= remainingTextCharacters) {
        remainingTextCharacters -= part.text.length;
        return { ...part };
      }
      const text = truncateTranscriptContent(part.text, remainingTextCharacters);
      remainingTextCharacters = 0;
      return text ? { ...part, text } : undefined;
    })
    .filter((part): part is ChatContentPart => Boolean(part));
}

function transcriptContent(message: ChatMessage) {
  if (message.role === "tool") {
    const label = message.name ? ` from ${message.name}` : "";
    const id = message.toolCallId ? ` (${message.toolCallId})` : "";
    return `Local tool result${label}${id}:\n${chatContentToText(message.content)}`;
  }

  if (!message.toolCalls?.length) {
    return chatContentToText(message.content);
  }

  const content = chatContentToText(message.content).trim();
  const toolRequests = message.toolCalls.map((call) => `- ${call.name}: ${formatToolArguments(call.arguments)}`).join("\n");
  return [content, `Local tool request${message.toolCalls.length === 1 ? "" : "s"}:\n${toolRequests}`].filter(Boolean).join("\n\n");
}

function formatToolArguments(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateTranscriptContent(content: string, entryCharacterLimit: number | undefined) {
  if (!entryCharacterLimit || content.length <= entryCharacterLimit) {
    return content;
  }
  if (entryCharacterLimit <= 3) {
    return ".".repeat(Math.max(0, entryCharacterLimit));
  }
  return `${content.slice(0, Math.max(0, entryCharacterLimit - 3)).trimEnd()}...`;
}

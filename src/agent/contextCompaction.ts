import { chatContentToText } from "./content.js";
import type { ChatMessage } from "./types.js";

export const COMPACT_RECENT_MESSAGE_COUNT = 8;

const COMPACTION_PREFIX = "Context compacted locally to reduce future model requests.";
const DEFAULT_ENTRY_LIMIT = 700;

type CompactOptions = {
  recentMessageCount?: number;
  entryCharacterLimit?: number;
  now?: Date;
};

export type ContextCompactionResult = {
  messages: ChatMessage[];
  compacted: boolean;
  compactedMessageCount: number;
  remainingMessageCount: number;
};

export function compactSessionMessages(messages: ChatMessage[], options: CompactOptions = {}): ContextCompactionResult {
  const recentMessageCount = options.recentMessageCount ?? COMPACT_RECENT_MESSAGE_COUNT;
  const entryCharacterLimit = options.entryCharacterLimit ?? DEFAULT_ENTRY_LIMIT;
  const systemMessages = messages.filter((message) => message.role === "system" && !isCompactionMessage(message));
  const previousCompactions = messages.filter(isCompactionMessage);
  const nonSystemMessages = messages.filter((message) => message.role !== "system");

  if (nonSystemMessages.length <= recentMessageCount) {
    return {
      messages,
      compacted: false,
      compactedMessageCount: 0,
      remainingMessageCount: nonSystemMessages.length
    };
  }

  const olderMessages = nonSystemMessages.slice(0, -recentMessageCount);
  const recentMessages = nonSystemMessages.slice(-recentMessageCount).map(toPlainTranscriptMessage);
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
    messages: [...systemMessages, compactedMessage, ...recentMessages],
    compacted: true,
    compactedMessageCount: olderMessages.length,
    remainingMessageCount: recentMessages.length
  };
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

function toPlainTranscriptMessage(message: ChatMessage): ChatMessage {
  if (message.role === "tool") {
    const label = message.name ? ` from ${message.name}` : "";
    const id = message.toolCallId ? ` (${message.toolCallId})` : "";
    return {
      role: "user",
      content: `Local tool result${label}${id}:\n${chatContentToText(message.content)}`
    };
  }

  if (message.toolCalls?.length) {
    return {
      role: message.role,
      content: transcriptContent(message)
    };
  }

  return {
    role: message.role,
    content: chatContentToText(message.content)
  };
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

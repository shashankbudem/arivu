import { chatContentToText } from "../../../src/agent/content.js";
import type { ChatContent } from "../../../src/agent/content.js";
import type { ChatMessage } from "../../../src/agent/types.js";

export type VisibleMessageEntry = {
  message: ChatMessage;
  messageIndex: number;
  sourceIndexes: number[];
  key: string;
};

export function deriveVisibleMessages(messages: ChatMessage[]): VisibleMessageEntry[] {
  const visible: VisibleMessageEntry[] = [];

  messages.forEach((message, messageIndex) => {
    if (message.role === "user") {
      const last = visible.at(-1);
      if (last?.message.role === "user" && chatContentEquals(last.message.content, message.content)) {
        // Retries duplicate the prompt; the visible entry retains the first submission time.
        last.sourceIndexes.push(messageIndex);
        last.key = `${last.message.role}-${last.sourceIndexes.join("-")}`;
        return;
      }
      visible.push({ message, messageIndex, sourceIndexes: [messageIndex], key: `user-${messageIndex}` });
      return;
    }

    if (message.role !== "assistant" || !chatContentToText(message.content).trim()) {
      return;
    }

    const last = visible.at(-1);
    if (last?.message.role === "assistant") {
      last.message = {
        ...last.message,
        content: [chatContentToText(last.message.content), chatContentToText(message.content)].filter(Boolean).join("\n\n"),
        // A merged reply completes with its final assistant fragment, so show that final time.
        createdAt: message.createdAt ?? last.message.createdAt
      };
      last.sourceIndexes.push(messageIndex);
      last.key = `${last.message.role}-${last.sourceIndexes.join("-")}`;
      return;
    }

    visible.push({ message, messageIndex, sourceIndexes: [messageIndex], key: `assistant-${messageIndex}` });
  });

  return visible;
}

function chatContentEquals(left: ChatContent, right: ChatContent) {
  return JSON.stringify(left) === JSON.stringify(right);
}

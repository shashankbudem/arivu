import { describe, expect, it } from "vitest";
import { compactMessagesForModelRequest, compactSessionMessages } from "../src/agent/contextCompaction.js";
import type { ChatMessage } from "../src/agent/types.js";

describe("context compaction", () => {
  it("does nothing when the transcript fits inside the recent message window", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ];

    const result = compactSessionMessages(messages, { recentMessageCount: 4 });

    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("summarizes older messages and keeps the recent transcript", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "older question" },
      { role: "assistant", content: "older answer" },
      { role: "user", content: "recent question" },
      { role: "assistant", content: "recent answer" }
    ];

    const result = compactSessionMessages(messages, {
      now: new Date("2026-06-16T00:00:00.000Z"),
      recentMessageCount: 2
    });

    expect(result).toMatchObject({
      compacted: true,
      compactedMessageCount: 2,
      remainingMessageCount: 2
    });
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]).toEqual({ role: "system", content: "system prompt" });
    expect(result.messages[1]?.role).toBe("system");
    expect(result.messages[1]?.content).toContain("Context compacted locally");
    // Anti-mimicry warning: models must not imitate the textified tool-transcript format.
    expect(result.messages[1]?.content).toContain("not a format to reply in");
    expect(result.messages[1]?.content).toContain("User: older question");
    expect(result.messages[1]?.content).toContain("Agent: older answer");
    expect(result.messages.slice(2)).toEqual([
      { role: "user", content: "recent question" },
      { role: "assistant", content: "recent answer" }
    ]);
  });

  it("converts retained tool protocol into plain transcript messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "old" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "README.md" } }]
      },
      {
        role: "tool",
        toolCallId: "call_1",
        name: "read_file",
        content: "README contents"
      },
      { role: "assistant", content: "Recent answer" }
    ];

    const result = compactSessionMessages(messages, { recentMessageCount: 3 });

    expect(result.compacted).toBe(true);
    expect(result.messages[1]).toEqual({
      role: "assistant",
      content: 'Local tool request:\n- read_file: {\n  "path": "README.md"\n}'
    });
    expect(result.messages[2]).toEqual({
      role: "user",
      content: "Local tool result from read_file (call_1):\nREADME contents"
    });
    expect(result.messages[3]).toEqual({ role: "assistant", content: "Recent answer" });
  });

  it("compacts oversized model requests even when the recent message window is small", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "inspect the browser" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_browser", name: "browser_snapshot", arguments: { mode: "visible", maxLength: 200000 } }]
      },
      {
        role: "tool",
        toolCallId: "call_browser",
        name: "browser_snapshot",
        content: "x".repeat(30_000)
      }
    ];

    const result = compactMessagesForModelRequest(messages, {
      tokenLimit: 100,
      recentMessageCount: 8,
      recentEntryCharacterLimit: 200,
      now: new Date("2026-06-16T00:00:00.000Z")
    });

    expect(result.compacted).toBe(true);
    expect(result.compactedMessageCount).toBe(0);
    expect(result.estimatedTokensBefore).toBeGreaterThan(result.estimatedTokensAfter ?? 0);
    expect(result.messages[1]?.role).toBe("system");
    expect(String(result.messages[1]?.content)).toContain("Context compacted locally");
    expect(String(result.messages.at(-1)?.content)).toContain("Local tool result from browser_snapshot");
    expect(String(result.messages.at(-1)?.content).length).toBeLessThan(260);
  });

  it("preserves the latest user request when later tool output pushes it out of the recent window", () => {
    const longTodoPrompt = Array.from({ length: 120 }, (_entry, index) => `TODO-${index + 1}: implement requirement ${index + 1}`).join(
      "\n"
    );
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: longTodoPrompt }
    ];
    for (let index = 0; index < 8; index += 1) {
      messages.push(
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: `call_${index}`, name: "browser_snapshot", arguments: { mode: "visible", maxLength: 200000 } }]
        },
        {
          role: "tool",
          toolCallId: `call_${index}`,
          name: "browser_snapshot",
          content: `snapshot ${index}\n${"x".repeat(20_000)}`
        }
      );
    }

    const result = compactMessagesForModelRequest(messages, {
      tokenLimit: 100,
      recentMessageCount: 4,
      recentEntryCharacterLimit: 200,
      activeUserMessageCharacterLimit: 10_000,
      now: new Date("2026-06-16T00:00:00.000Z")
    });
    const requestText = result.messages.map((message) => String(message.content)).join("\n");
    const pinnedUserIndex = result.messages.findIndex((message) => message.role === "user" && String(message.content).includes("TODO-120"));
    const firstRecentToolIndex = result.messages.findIndex((message) => String(message.content).includes("snapshot 6"));

    expect(result.compacted).toBe(true);
    expect(requestText).toContain("TODO-1: implement requirement 1");
    expect(requestText).toContain("TODO-120: implement requirement 120");
    expect(String(result.messages[1]?.content)).not.toContain("TODO-120");
    expect(pinnedUserIndex).toBeGreaterThan(1);
    expect(firstRecentToolIndex).toBeGreaterThan(pinnedUserIndex);
    expect(requestText).not.toContain("x".repeat(10_000));
  });

  it("does not pin synthetic user messages created from retained tool results", () => {
    const realPrompt = "Please finish the ServiceNow todo list.\nKEEP-ME";
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: realPrompt },
      { role: "assistant", content: "I will inspect the portal." },
      { role: "user", content: `Local tool result from browser_snapshot (call_old):\n${"tool-result ".repeat(400)}` }
    ];
    for (let index = 0; index < 6; index += 1) {
      messages.push(
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: `call_more_${index}`, name: "browser_snapshot", arguments: { mode: "visible" } }]
        },
        {
          role: "tool",
          toolCallId: `call_more_${index}`,
          name: "browser_snapshot",
          content: `recent snapshot ${index}\n${"x".repeat(20_000)}`
        }
      );
    }

    const result = compactMessagesForModelRequest(messages, {
      tokenLimit: 100,
      recentMessageCount: 4,
      recentEntryCharacterLimit: 200,
      activeUserMessageCharacterLimit: 4_000,
      now: new Date("2026-06-16T00:00:00.000Z")
    });
    const pinnedMessages = result.messages.slice(2, -4).map((message) => String(message.content));

    expect(result.compacted).toBe(true);
    expect(pinnedMessages.some((content) => content.includes("KEEP-ME"))).toBe(true);
    expect(pinnedMessages.some((content) => content.startsWith("Local tool result"))).toBe(false);
  });

  it("preserves image parts on the latest user request during request compaction", () => {
    const imageUrl = "data:image/png;base64,aGVsbG8=";
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      {
        role: "user",
        content: [
          { type: "text", text: `Please inspect this screenshot.\n${"details ".repeat(200)}` },
          { type: "image_url", image_url: { url: imageUrl, detail: "low" }, name: "screen.png", mimeType: "image/png", size: 128 }
        ]
      }
    ];
    for (let index = 0; index < 6; index += 1) {
      messages.push(
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: `call_image_${index}`, name: "browser_snapshot", arguments: { mode: "visible" } }]
        },
        {
          role: "tool",
          toolCallId: `call_image_${index}`,
          name: "browser_snapshot",
          content: `snapshot ${index}\n${"x".repeat(20_000)}`
        }
      );
    }

    const result = compactMessagesForModelRequest(messages, {
      tokenLimit: 100,
      recentMessageCount: 4,
      recentEntryCharacterLimit: 200,
      activeUserMessageCharacterLimit: 80,
      now: new Date("2026-06-16T00:00:00.000Z")
    });
    const pinnedUser = result.messages.find((message) => Array.isArray(message.content));
    const pinnedContent = pinnedUser?.content;
    const pinnedParts = Array.isArray(pinnedContent) ? pinnedContent : [];

    expect(result.compacted).toBe(true);
    expect(Array.isArray(pinnedContent)).toBe(true);
    expect(pinnedParts).toContainEqual({
      type: "image_url",
      image_url: { url: imageUrl, detail: "low" },
      name: "screen.png",
      mimeType: "image/png",
      size: 128
    });
    expect(pinnedParts.find((part) => part.type === "text")?.text).toContain("Please inspect this screenshot.");
    expect(pinnedParts.find((part) => part.type === "text")?.text.length).toBeLessThanOrEqual(80);
  });
});

import { describe, expect, it } from "vitest";
import { compactSessionMessages } from "../src/agent/contextCompaction.js";
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
});

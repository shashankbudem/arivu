import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/agent/types.js";
import {
  activityForSession,
  inferToolResultPhase,
  transcriptForSession,
  truncateNativeActivityDetail
} from "../src/tui/nativeSessionPresentation.js";

function sessionWithToolResult(result: string): AgentSession {
  return {
    id: "session-1",
    cwd: "/tmp/arivu",
    trustMode: "ask",
    messages: [
      {
        role: "user",
        content: "Inspect the project",
        createdAt: "2026-07-31T00:00:00.000Z"
      },
      {
        role: "assistant",
        content: "I will inspect it.",
        createdAt: "2026-07-31T00:00:01.000Z",
        toolCalls: [{ id: "call-1", name: "git_status", arguments: { short: true } }]
      },
      {
        role: "tool",
        name: "git_status",
        toolCallId: "call-1",
        content: result,
        createdAt: "2026-07-31T00:00:02.000Z"
      }
    ],
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:02.000Z"
  };
}

describe("native TUI session presentation", () => {
  it("restores compact tool steps to scrollback and keeps full details in Activity", () => {
    const session = sessionWithToolResult("Working tree clean. No errors found.");

    const transcript = transcriptForSession(session);
    expect(transcript.map((entry) => entry.kind)).toEqual(["user", "assistant", "system", "system"]);
    expect(transcript[2]?.text).toContain("◆ Running git_status");
    expect(transcript[3]?.text).toContain("✓ Completed git_status");

    const activity = activityForSession(session);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ id: "call-1", name: "git_status", phase: "completed" });
    expect(activity[0]?.detail).toContain('Arguments\n{\n  "short": true\n}');
    expect(activity[0]?.detail).toContain("Result\nWorking tree clean. No errors found.");
  });

  it("classifies explicit failures without treating harmless error words as failures", () => {
    expect(inferToolResultPhase("No errors found.")).toBe("completed");
    expect(inferToolResultPhase("Error: browser task timed out")).toBe("failed");
    expect(inferToolResultPhase('{"ok":false,"message":"blocked"}')).toBe("failed");
    expect(inferToolResultPhase("Process exited with code 2")).toBe("failed");
  });

  it("bounds full Activity payloads sent to the native process", () => {
    expect(truncateNativeActivityDetail("abcdef", 5)).toBe("abcde\n[truncated]");
  });
});

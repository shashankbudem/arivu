import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/agent/types.js";
import {
  deriveSessionTitleFromText,
  ensureSessionTitle,
  resolveSessionTitleSource,
  sessionDisplayTitle
} from "../src/sessions/sessionList.js";

function session(partial: Partial<AgentSession> & Pick<AgentSession, "id" | "messages">): AgentSession {
  return {
    cwd: "/tmp",
    trustMode: "ask",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial
  };
}

describe("session title helpers", () => {
  it("derives a short title from free text", () => {
    expect(deriveSessionTitleFromText("one two three four five six seven eight nine ten eleven twelve thirteen")).toBe(
      "one two three four five six seven eight nine ten eleven twelve"
    );
    expect(deriveSessionTitleFromText("   ")).toBe("Untitled session");
  });

  it("prefers a saved title, then substantial user text, then task preview", () => {
    expect(
      resolveSessionTitleSource(
        session({
          id: "a",
          title: "Renamed chat",
          messages: [{ role: "user", content: "ignored prompt" }]
        })
      )
    ).toBe("Renamed chat");

    expect(
      resolveSessionTitleSource(
        session({
          id: "b",
          messages: [
            { role: "user", content: "continue" },
            { role: "user", content: "Complete ALL 10 TODOs below in this single run for ServiceNow." }
          ]
        })
      )
    ).toBe("Complete ALL 10 TODOs below in this single run for ServiceNow.");

    expect(
      resolveSessionTitleSource(
        session({
          id: "c",
          messages: [{ role: "system", content: "summary only" }],
          taskRuns: [
            {
              id: "run-1",
              userMessageIndex: 0,
              promptPreview: "Build the New Hire IT Onboarding Kit catalog item.",
              status: "completed",
              capabilities: [],
              approvals: [],
              tools: [],
              artifacts: [],
              startedAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z"
            }
          ]
        })
      )
    ).toBe("Build the New Hire IT Onboarding Kit catalog item.");
  });

  it("freezes a title once without overwriting renames", () => {
    const s = session({
      id: "d",
      messages: [{ role: "user", content: "Complete ALL 10 TODOs below in this single run." }]
    });
    expect(ensureSessionTitle(s)).toBe(true);
    expect(s.title).toBe("Complete ALL 10 TODOs below in this single run.");
    expect(ensureSessionTitle(s)).toBe(false);

    s.title = "Custom name";
    expect(ensureSessionTitle(s)).toBe(false);
    expect(s.title).toBe("Custom name");
    expect(sessionDisplayTitle(s)).toBe("Custom name");
  });
});

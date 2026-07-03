import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/agent/types.js";
import { formatTuiSessionList, parseTuiSlashCommand } from "../src/tui/TuiApp.js";

describe("TUI slash commands", () => {
  it("parses session listing and resume commands", () => {
    expect(parseTuiSlashCommand("/sessions")).toEqual({ kind: "sessions", limit: 10 });
    expect(parseTuiSlashCommand("/sessions 3")).toEqual({ kind: "sessions", limit: 3 });
    expect(parseTuiSlashCommand("/resume abc123")).toEqual({ kind: "resume", sessionId: "abc123" });
  });

  it("keeps unknown slash commands available for model prompts", () => {
    expect(parseTuiSlashCommand("/unknown command")).toEqual({ kind: "unknown" });
    expect(parseTuiSlashCommand("plain prompt")).toBeUndefined();
  });

  it("reports invalid command usage", () => {
    expect(parseTuiSlashCommand("/sessions zero")).toEqual({ kind: "error", message: "Usage: /sessions [positive-limit]" });
    expect(parseTuiSlashCommand("/resume")).toEqual({ kind: "error", message: "Usage: /resume <session-id>" });
  });

  it("formats recent sessions with resume guidance", () => {
    const sessions: AgentSession[] = [
      {
        id: "newer",
        cwd: "/tmp/project",
        projectRoot: "/tmp/project",
        trustMode: "ask",
        messages: [{ role: "user", content: "new work in project" }],
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z"
      },
      {
        id: "older",
        cwd: "/tmp/other",
        trustMode: "ask",
        messages: [{ role: "user", content: "old work" }],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ];

    const output = formatTuiSessionList(sessions, 1);

    expect(output).toContain("Recent sessions:");
    expect(output).toContain("newer  2026-01-02T00:00:00Z  project  new work in project");
    expect(output).toContain("Resume with /resume <session-id>.");
    expect(output).not.toContain("older");
  });

  it("formats an empty session list", () => {
    expect(formatTuiSessionList([])).toBe("No saved sessions.");
  });
});

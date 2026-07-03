import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/agent/types.js";
import { formatTuiGitDiffSummary, formatTuiSessionList, loadTuiGitDiffSummary, parseTuiSlashCommand } from "../src/tui/TuiApp.js";

describe("TUI slash commands", () => {
  it("parses session listing and resume commands", () => {
    expect(parseTuiSlashCommand("/sessions")).toEqual({ kind: "sessions", limit: 10 });
    expect(parseTuiSlashCommand("/sessions 3")).toEqual({ kind: "sessions", limit: 3 });
    expect(parseTuiSlashCommand("/resume abc123")).toEqual({ kind: "resume", sessionId: "abc123" });
    expect(parseTuiSlashCommand("/diff")).toEqual({ kind: "diff" });
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

  it("formats a clean git diff summary", () => {
    const output = formatTuiGitDiffSummary({
      root: "/tmp/project",
      branch: "main",
      stagedFiles: [],
      unstagedFiles: [],
      untrackedFiles: []
    });

    expect(output).toContain("Git diff summary:");
    expect(output).toContain("Root: /tmp/project");
    expect(output).toContain("Branch: main");
    expect(output).toContain("No staged, unstaged, or untracked changes.");
  });

  it("formats staged, unstaged, and untracked git diff sections", () => {
    const output = formatTuiGitDiffSummary({
      root: "/tmp/project",
      branch: "feature",
      stagedShortstat: "1 file changed, 2 insertions(+)",
      unstagedShortstat: "1 file changed, 1 deletion(-)",
      stagedFiles: ["M   src/app.ts"],
      unstagedFiles: ["D   src/old.ts"],
      untrackedFiles: ["notes.md"]
    });

    expect(output).toContain("Staged:\n  1 file changed, 2 insertions(+)\n  M   src/app.ts");
    expect(output).toContain("Unstaged:\n  1 file changed, 1 deletion(-)\n  D   src/old.ts");
    expect(output).toContain("Untracked:\n  notes.md");
  });

  it("loads staged, unstaged, and untracked changes from git", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "arivu-tui-diff-"));
    try {
      await execa("git", ["init"], { cwd });
      await execa("git", ["config", "user.email", "arivu@example.test"], { cwd });
      await execa("git", ["config", "user.name", "Arivu Test"], { cwd });
      await writeFile(path.join(cwd, "tracked.txt"), "initial\n");
      await execa("git", ["add", "tracked.txt"], { cwd });
      await execa("git", ["commit", "-m", "initial"], { cwd });

      await writeFile(path.join(cwd, "tracked.txt"), "changed\n");
      await writeFile(path.join(cwd, "staged.txt"), "staged\n");
      await execa("git", ["add", "staged.txt"], { cwd });
      await writeFile(path.join(cwd, "untracked.txt"), "new\n");

      const summary = await loadTuiGitDiffSummary(cwd);

      expect(summary.stagedFiles).toContain("A   staged.txt");
      expect(summary.unstagedFiles).toContain("M   tracked.txt");
      expect(summary.untrackedFiles).toContain("untracked.txt");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions/SessionStore.js";

const execFileAsync = promisify(execFile);

let tempDir: string;

describe("cli sessions command", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-cli-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("lists recent saved sessions with a limit", async () => {
    const store = new SessionStore(path.join(tempDir, "sessions"));
    await store.save({
      id: "older",
      cwd: "/tmp/project",
      trustMode: "ask",
      messages: [{ role: "user", content: "old work" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    await store.save({
      id: "newer",
      cwd: "/tmp/project",
      projectRoot: "/tmp/project",
      trustMode: "ask",
      messages: [{ role: "user", content: "new work" }],
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z"
    });

    const { stdout } = await execArivu(["sessions", "--limit", "1"]);

    expect(stdout).toContain("ID\tUPDATED\tWORKSPACE\tTITLE");
    expect(stdout).toContain("newer\t2026-01-02T00:00:00Z\t/tmp/project\tnew work");
    expect(stdout).not.toContain("older");
  });

  it("filters saved sessions by search, workspace, and pinned state", async () => {
    const store = new SessionStore(path.join(tempDir, "sessions"));
    await store.save({
      id: "pinned-api",
      title: "Fix provider fallback",
      pinnedAt: "2026-01-03T00:00:00.000Z",
      cwd: "/tmp/arivu",
      projectRoot: "/tmp/arivu",
      trustMode: "ask",
      selectedProviderName: "NVIDIA",
      messages: [{ role: "user", content: "repair fallback issue" }],
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z"
    });
    await store.save({
      id: "standalone-notes",
      cwd: "/tmp/notes",
      trustMode: "ask",
      messages: [{ role: "user", content: "browser notes" }],
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z"
    });
    await store.save({
      id: "project-browser",
      cwd: "/tmp/other",
      projectRoot: "/tmp/other",
      trustMode: "ask",
      messages: [{ role: "user", content: "browser tabs" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    const { stdout } = await execArivu(["sessions", "--search", "fallback", "--workspace", "arivu", "--pinned"]);

    expect(stdout).toContain("Filters: search=fallback, workspace=arivu, pinned");
    expect(stdout).toContain("pinned-api\t2026-01-03T00:00:00Z\t/tmp/arivu\tFix provider fallback");
    expect(stdout).not.toContain("standalone-notes");
    expect(stdout).not.toContain("project-browser");
  });

  it("filters saved sessions by project mode", async () => {
    const store = new SessionStore(path.join(tempDir, "sessions"));
    await store.save({
      id: "project-chat",
      cwd: "/tmp/project",
      projectRoot: "/tmp/project",
      trustMode: "ask",
      messages: [{ role: "user", content: "project work" }],
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z"
    });
    await store.save({
      id: "standalone-chat",
      cwd: "/tmp/project",
      trustMode: "ask",
      messages: [{ role: "user", content: "standalone work" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    const { stdout } = await execArivu(["sessions", "--standalone"]);

    expect(stdout).toContain("Filters: standalone");
    expect(stdout).toContain("standalone-chat");
    expect(stdout).not.toContain("project-chat");
  });

  it("prints a filtered empty state", async () => {
    const { stdout } = await execArivu(["sessions", "--search", "missing"]);

    expect(stdout.trim()).toBe("No saved sessions match filters: search=missing.");
  });

  it("prints an empty state when no sessions are saved", async () => {
    const { stdout } = await execArivu(["sessions"]);

    expect(stdout.trim()).toBe("No saved sessions.");
  });
});

describe("cli compact command", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-cli-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("compacts a saved session transcript", async () => {
    const store = new SessionStore(path.join(tempDir, "sessions"));
    await store.save({
      id: "long-session",
      cwd: "/tmp/project",
      trustMode: "ask",
      messages: [
        { role: "user", content: "older question" },
        { role: "assistant", content: "older answer" },
        { role: "user", content: "recent question" },
        { role: "assistant", content: "recent answer" }
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    const { stdout } = await execArivu(["compact", "long-session", "--recent", "2"]);

    expect(stdout).toContain("Compacted session long-session.");
    expect(stdout).toContain("Compacted messages: 2");
    expect(stdout).toContain("Kept recent messages: 2");

    const compacted = await store.load("long-session");
    expect(compacted.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
    expect(compacted.messages).toHaveLength(3);
    expect(compacted.messages[0]?.role).toBe("system");
    expect(compacted.messages[0]?.content).toContain("Context compacted locally");
    expect(compacted.messages[0]?.content).toContain("User: older question");
    expect(compacted.messages.slice(1)).toEqual([
      { role: "user", content: "recent question" },
      { role: "assistant", content: "recent answer" }
    ]);
  });

  it("supports dry-run compaction without saving", async () => {
    const store = new SessionStore(path.join(tempDir, "sessions"));
    const session = {
      id: "dry-run-session",
      cwd: "/tmp/project",
      trustMode: "ask" as const,
      messages: [
        { role: "user" as const, content: "older question" },
        { role: "assistant" as const, content: "older answer" },
        { role: "user" as const, content: "recent question" },
        { role: "assistant" as const, content: "recent answer" }
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    await store.save(session);

    const { stdout } = await execArivu(["compact", "dry-run-session", "--recent", "2", "--dry-run"]);

    expect(stdout).toContain("Would compact session dry-run-session.");
    expect(await store.load("dry-run-session")).toEqual(session);
  });

  it("reports when a saved session does not need compaction", async () => {
    const store = new SessionStore(path.join(tempDir, "sessions"));
    await store.save({
      id: "short-session",
      cwd: "/tmp/project",
      trustMode: "ask",
      messages: [{ role: "user", content: "short" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    const { stdout } = await execArivu(["compact", "short-session", "--recent", "8"]);

    expect(stdout.trim()).toBe("Session short-session is already compact enough. Non-system messages: 1; recent window: 8.");
  });
});

describe("cli doctor command", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-cli-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("prints offline diagnostics when no API key is configured", async () => {
    const { stdout } = await execArivu(["doctor"]);

    expect(stdout).toContain("arivu doctor");
    expect(stdout).toContain("[FAIL] API key: Missing");
    expect(stdout).toContain("[SKIP] Chat completions: Skipped because no API key is configured.");
    expect(stdout).toContain("[SKIP] Tavily: No Tavily API key is configured.");
    expect(stdout).toContain("Summary:");
  });

  it("prints doctor diagnostics as JSON", async () => {
    const { stdout } = await execArivu(["doctor", "--json"]);
    const report = JSON.parse(stdout) as {
      checks: Array<{ id: string; status: string }>;
      summary: Record<string, number>;
    };

    expect(report.checks.find((check) => check.id === "api-key")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "chat")?.status).toBe("skip");
    expect(report.summary.fail).toBeGreaterThanOrEqual(1);
    expect(report.summary.skip).toBeGreaterThanOrEqual(1);
  });
});

async function execArivu(args: string[]) {
  const tsxBin = path.join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  return execFileAsync(tsxBin, ["src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ARIVU_DATA_HOME: tempDir,
      ARIVU_CONFIG_HOME: path.join(tempDir, "config"),
      SHANKINSTER_CONFIG_HOME: path.join(tempDir, "legacy-config"),
      ARIVU_API_KEY: "",
      SHANKINSTER_API_KEY: "",
      ARIVU_TAVILY_API_KEY: "",
      SHANKINSTER_TAVILY_API_KEY: "",
      TAVILY_API_KEY: "",
      NO_COLOR: "1",
      // chalk gives FORCE_COLOR precedence over NO_COLOR, so an inherited FORCE_COLOR (common under
      // agent/CI tooling) would re-enable ANSI codes and break exact-output assertions.
      FORCE_COLOR: "0"
    }
  });
}

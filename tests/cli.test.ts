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

  it("prints an empty state when no sessions are saved", async () => {
    const { stdout } = await execArivu(["sessions"]);

    expect(stdout.trim()).toBe("No saved sessions.");
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
      NO_COLOR: "1"
    }
  });
}

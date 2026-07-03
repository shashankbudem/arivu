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

async function execArivu(args: string[]) {
  const tsxBin = path.join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  return execFileAsync(tsxBin, ["src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ARIVU_DATA_HOME: tempDir,
      NO_COLOR: "1"
    }
  });
}

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions/SessionStore.js";

let tempDir: string;

describe("session store", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-session-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("saves and loads a session", async () => {
    const store = new SessionStore(tempDir);
    await store.save({
      id: "abc123",
      cwd: "/tmp/project",
      trustMode: "ask",
      agentLoop: {
        status: "completed",
        goal: "fix the bug",
        iteration: 2,
        maxIterations: 5,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:05:00.000Z",
        lastDecision: "done"
      },
      messages: [{ role: "user", content: "hello" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    await expect(store.load("abc123")).resolves.toMatchObject({
      id: "abc123",
      cwd: "/tmp/project",
      agentLoop: {
        status: "completed",
        goal: "fix the bug",
        iteration: 2,
        maxIterations: 5,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:05:00.000Z",
        lastDecision: "done"
      },
      messages: [{ role: "user", content: "hello" }]
    });
  });

  it("lists sessions newest first", async () => {
    const store = new SessionStore(tempDir);
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
      trustMode: "ask",
      messages: [{ role: "user", content: "new work" }],
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z"
    });

    await expect(store.list()).resolves.toMatchObject([{ id: "newer" }, { id: "older" }]);
  });

  it("deletes a saved session", async () => {
    const store = new SessionStore(tempDir);
    await store.save({
      id: "doomed",
      cwd: "/tmp/project",
      trustMode: "ask",
      messages: [{ role: "user", content: "remove me" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    await store.delete("doomed");

    await expect(store.list()).resolves.toEqual([]);
    await expect(store.load("doomed")).rejects.toThrow();
  });
});

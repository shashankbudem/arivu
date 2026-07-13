import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      title: "Named harness task",
      pinnedAt: "2026-01-01T00:06:00.000Z",
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
      taskRuns: [
        {
          id: "run-1",
          userMessageIndex: 0,
          promptPreview: "hello",
          status: "completed",
          model: "test-model",
          providerName: "Test Provider",
          planMode: {
            enabled: true
          },
          plan: {
            summary: "make the repair safely",
            items: [
              { text: "Inspect failure", status: "completed" },
              { text: "Patch code", status: "pending" }
            ],
            sourceMessageIndex: 2,
            updatedAt: "2026-01-01T00:01:30.000Z"
          },
          completion: {
            summary: "finished against the approved plan",
            items: [
              {
                text: "Inspect failure",
                status: "completed",
                evidence: [
                  { kind: "command", value: "npm test" },
                  { kind: "report", value: "reports/junit.xml" }
                ]
              },
              { text: "Patch code", status: "needs_followup" }
            ],
            sourceMessageIndex: 5,
            updatedAt: "2026-01-01T00:02:30.000Z"
          },
          planReview: {
            status: "approved",
            updatedAt: "2026-01-01T00:01:40.000Z"
          },
          verification: {
            status: "passed",
            summary: "Verification passed: 1 command, no failed exits.",
            commandCount: 1,
            failedCommandCount: 0,
            parsedReportCount: 0,
            failedReportCount: 0,
            passedReportCount: 0,
            unknownReportCount: 0,
            updatedAt: "2026-01-01T00:01:55.000Z"
          },
          worktree: {
            enabled: true,
            status: "ready",
            originalRoot: "/tmp/project",
            path: "/tmp/arivu-worktree",
            branch: "arivu/task-run-1",
            baseRef: "abc1234",
            plannedFromTaskRunId: "run-plan",
            continuedFromTaskRunId: "run-original",
            replayOfTaskRunId: "run-original",
            createdAt: "2026-01-01T00:00:30.000Z",
            diff: {
              hasChanges: true,
              files: 1,
              insertions: 2,
              deletions: 1,
              changedPaths: ["README.md"],
              updatedAt: "2026-01-01T00:01:30.000Z"
            },
            patchPreview: {
              text: "diff --git a/README.md b/README.md\n+hello\n",
              bytes: 44,
              lineCount: 3,
              truncated: false,
              updatedAt: "2026-01-01T00:01:45.000Z"
            },
            pullRequest: {
              title: "Arivu: hello",
              body: "body",
              branch: "arivu/task-run-1",
              baseBranch: "main",
              baseRef: "abc1234",
              commit: "abc123456789abc123456789abc123456789abcd",
              remoteName: "origin",
              remoteUrl: "https://github.com/acme/repo.git",
              pushCommand: "git push",
              createCommand: "gh pr create --draft",
              preparedAt: "2026-01-01T00:02:30.000Z",
              review: {
                checkSummary: "1 failed",
                checks: { total: 1, passed: 0, failed: 1, pending: 0, skipped: 0, cancelled: 0, unknown: 0 },
                checkItems: [
                  {
                    name: "lint",
                    bucket: "failed",
                    status: "COMPLETED",
                    conclusion: "FAILURE",
                    logSource: "github_actions",
                    logCommand: "gh run view '123456' --repo 'acme/repo' --job '7890' --log-failed",
                    logArtifactId: "pr-check-log:lint:123456:7890:command_output",
                    logFetchedAt: "2026-01-01T00:02:45.000Z",
                    logError: "Exit code 1"
                  }
                ],
                notifications: [
                  {
                    level: "warning",
                    summary: "Review decision changed",
                    detail: "review required -> changes requested",
                    createdAt: "2026-01-01T00:02:40.000Z"
                  }
                ],
                summary: "1 failed check.",
                updatedAt: "2026-01-01T00:02:40.000Z"
              }
            },
            conflict: {
              type: "sync",
              message: "README.md needs conflict resolution.",
              files: ["README.md"],
              originalHead: "1111111111111111111111111111111111111111",
              taskHead: "2222222222222222222222222222222222222222",
              detectedAt: "2026-01-01T00:02:45.000Z"
            },
            mergeCommit: "abc123456789",
            mergedAt: "2026-01-01T00:03:00.000Z"
          },
          capabilities: ["read_repo"],
          tools: [
            {
              id: "tool-1",
              toolCallId: "call_1",
              name: "read",
              arguments: { path: "README.md" },
              capability: "read_repo",
              status: "done",
              startedAt: "2026-01-01T00:01:00.000Z",
              completedAt: "2026-01-01T00:02:00.000Z",
              resultPreview: "fixture"
            }
          ],
          approvals: [],
          artifacts: [
            {
              id: "call_patch:patch",
              kind: "patch",
              title: "Patch applied",
              summary: "README.md (1 hunks) (1 file +1)",
              diff: "--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n",
              changedPaths: ["README.md"],
              additions: 1,
              createdAt: "2026-01-01T00:01:45.000Z"
            },
            {
              id: "call_write:file_change:notes/plan.md",
              kind: "file_change",
              title: "File created",
              summary: "Created notes/plan.md (2 lines)",
              path: "notes/plan.md",
              writeMode: "create",
              content: "# Plan\nShip it.\n",
              lineCount: 2,
              createdAt: "2026-01-01T00:01:50.000Z"
            },
            {
              id: "call_typecheck:command_output",
              kind: "command_output",
              title: "Command output",
              summary: "Exit code 2 - 1 diagnostic",
              command: "npm run typecheck",
              exitCode: 2,
              diagnostics: [
                {
                  source: "typescript",
                  severity: "error",
                  path: "src/agent/taskRuns.ts",
                  line: 12,
                  column: 8,
                  code: "TS2305",
                  message: "Module './types.js' has no exported member 'AgentTaskRunDiagnostic'."
                },
                {
                  source: "eslint",
                  severity: "warning",
                  path: "src/app.ts",
                  line: 7,
                  column: 3,
                  code: "no-console",
                  message: "Unexpected console statement"
                }
              ],
              createdAt: "2026-01-01T00:01:55.000Z"
            }
          ],
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:02:00.000Z",
          completedAt: "2026-01-01T00:02:00.000Z"
        }
      ],
      messages: [{ role: "user", content: "hello" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    await expect(store.load("abc123")).resolves.toMatchObject({
      id: "abc123",
      title: "Named harness task",
      pinnedAt: "2026-01-01T00:06:00.000Z",
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
    await expect(store.load("abc123")).resolves.toMatchObject({
      taskRuns: [
        {
          id: "run-1",
          status: "completed",
          plan: {
            summary: "make the repair safely",
            items: [
              { text: "Inspect failure", status: "completed" },
              { text: "Patch code", status: "pending" }
            ],
            sourceMessageIndex: 2
          },
          planMode: {
            enabled: true
          },
          completion: {
            summary: "finished against the approved plan",
            items: [
              {
                text: "Inspect failure",
                status: "completed",
                evidence: [
                  { kind: "command", value: "npm test" },
                  { kind: "report", value: "reports/junit.xml" }
                ]
              },
              { text: "Patch code", status: "needs_followup" }
            ],
            sourceMessageIndex: 5
          },
          planReview: {
            status: "approved",
            updatedAt: "2026-01-01T00:01:40.000Z"
          },
          worktree: {
            enabled: true,
            status: "ready",
            path: "/tmp/arivu-worktree",
            branch: "arivu/task-run-1",
            plannedFromTaskRunId: "run-plan",
            continuedFromTaskRunId: "run-original",
            replayOfTaskRunId: "run-original",
            diff: {
              hasChanges: true,
              files: 1,
              changedPaths: ["README.md"]
            },
            patchPreview: {
              truncated: false,
              lineCount: 3
            },
            pullRequest: {
              title: "Arivu: hello",
              branch: "arivu/task-run-1",
              baseBranch: "main",
              remoteName: "origin",
              preparedAt: "2026-01-01T00:02:30.000Z",
              review: {
                checkItems: [
                  {
                    name: "lint",
                    bucket: "failed",
                    logSource: "github_actions",
                    logArtifactId: "pr-check-log:lint:123456:7890:command_output",
                    logFetchedAt: "2026-01-01T00:02:45.000Z",
                    logError: "Exit code 1"
                  }
                ],
                notifications: [
                  {
                    level: "warning",
                    summary: "Review decision changed",
                    detail: "review required -> changes requested",
                    createdAt: "2026-01-01T00:02:40.000Z"
                  }
                ]
              }
            },
            conflict: {
              type: "sync",
              files: ["README.md"],
              detectedAt: "2026-01-01T00:02:45.000Z"
            },
            mergeCommit: "abc123456789"
          },
          capabilities: ["read_repo"],
          verification: {
            status: "passed",
            summary: "Verification passed: 1 command, no failed exits.",
            commandCount: 1,
            failedCommandCount: 0,
            parsedReportCount: 0,
            updatedAt: "2026-01-01T00:01:55.000Z"
          },
          tools: [{ name: "read", status: "done" }],
          artifacts: [
            {
              id: "call_patch:patch",
              kind: "patch",
              changedPaths: ["README.md"],
              additions: 1
            },
            {
              id: "call_write:file_change:notes/plan.md",
              kind: "file_change",
              path: "notes/plan.md",
              writeMode: "create",
              content: "# Plan\nShip it.\n",
              lineCount: 2
            },
            {
              id: "call_typecheck:command_output",
              kind: "command_output",
              command: "npm run typecheck",
              diagnostics: [
                {
                  source: "typescript",
                  severity: "error",
                  path: "src/agent/taskRuns.ts",
                  line: 12,
                  column: 8,
                  code: "TS2305",
                  message: "Module './types.js' has no exported member 'AgentTaskRunDiagnostic'."
                },
                {
                  source: "eslint",
                  severity: "warning",
                  path: "src/app.ts",
                  line: 7,
                  column: 3,
                  code: "no-console",
                  message: "Unexpected console statement"
                }
              ]
            }
          ]
        }
      ]
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

  it("lists pinned sessions before newer unpinned sessions", async () => {
    const store = new SessionStore(tempDir);
    await store.save({
      id: "newer",
      cwd: "/tmp/project",
      trustMode: "ask",
      messages: [{ role: "user", content: "new work" }],
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z"
    });
    await store.save({
      id: "pinned",
      title: "Pinned task",
      pinnedAt: "2026-01-02T00:00:00.000Z",
      cwd: "/tmp/project",
      trustMode: "ask",
      messages: [{ role: "user", content: "important work" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    await expect(store.list()).resolves.toMatchObject([{ id: "pinned", title: "Pinned task" }, { id: "newer" }]);
  });

  it("loads legacy task runs without approval records", async () => {
    const legacySession = {
      id: "legacy-task-run",
      cwd: "/tmp/project",
      trustMode: "ask",
      taskRuns: [
        {
          id: "run-legacy",
          userMessageIndex: 0,
          promptPreview: "legacy",
          status: "completed",
          capabilities: ["read_repo"],
          tools: [],
          artifacts: [
            {
              id: "artifact-command",
              kind: "command_output",
              title: "Command output",
              command: "npm test",
              executionProfile: "host",
              executionIsolation: "local host process",
              workingDirectory: "/tmp/project",
              exitCode: 0,
              createdAt: "2026-01-01T00:00:01.000Z"
            }
          ],
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:01.000Z"
        }
      ],
      messages: [{ role: "user", content: "legacy" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z"
    };
    await writeFile(path.join(tempDir, "legacy-task-run.json"), `${JSON.stringify(legacySession)}\n`, "utf8");

    await expect(new SessionStore(tempDir).load("legacy-task-run")).resolves.toMatchObject({
      taskRuns: [
        {
          id: "run-legacy",
          approvals: [],
          artifacts: [
            {
              id: "artifact-command",
              executionProfile: "host",
              executionIsolation: "local host process",
              workingDirectory: "/tmp/project"
            }
          ]
        }
      ]
    });
  });

  it("round-trips a browser_task_log artifact through save, load, and list", async () => {
    // Regression guard: the persisted artifact-kind enum must stay in sync with
    // AgentTaskRunArtifact.kind. When it drifted, sessions with browser_task_log
    // artifacts failed schema validation and were silently dropped from the list.
    const store = new SessionStore(tempDir);
    await store.save({
      id: "browser-task-session",
      cwd: "/tmp/project",
      trustMode: "trusted",
      taskRuns: [
        {
          id: "run-browser-task",
          userMessageIndex: 1,
          promptPreview: "fill the form",
          status: "completed",
          capabilities: ["browser_control"],
          tools: [],
          approvals: [],
          artifacts: [
            {
              id: "artifact-browser-task-log",
              kind: "browser_task_log",
              title: "Browser task log",
              summary: "Filled the form and submitted.",
              createdAt: "2026-01-01T00:00:01.000Z"
            }
          ],
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:01.000Z"
        }
      ],
      messages: [
        { role: "system", content: "You are Arivu, a local CLI coding agent." },
        { role: "user", content: "fill the form" },
        { role: "assistant", content: "Done." }
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z"
    });

    await expect(store.load("browser-task-session")).resolves.toMatchObject({
      taskRuns: [{ artifacts: [{ id: "artifact-browser-task-log", kind: "browser_task_log" }] }]
    });
    await expect(store.list()).resolves.toMatchObject([{ id: "browser-task-session" }]);
  });

  it("repairs task-run indexes that drifted before a saved user prompt", async () => {
    const driftedSession = {
      id: "drifted-task-run",
      cwd: "/tmp/project",
      trustMode: "trusted",
      taskRuns: [
        {
          id: "run-drifted",
          userMessageIndex: 0,
          promptPreview: "Can you see the website opened in the browser?",
          status: "completed",
          capabilities: ["browser_control"],
          tools: [],
          approvals: [],
          artifacts: [],
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:01.000Z"
        }
      ],
      messages: [
        { role: "system", content: "You are Arivu, a local CLI coding agent." },
        { role: "user", content: "Can you see the website opened in the browser?" },
        { role: "assistant", content: "Yes." }
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z"
    };
    await writeFile(path.join(tempDir, "drifted-task-run.json"), `${JSON.stringify(driftedSession)}\n`, "utf8");

    const store = new SessionStore(tempDir);

    await expect(store.load("drifted-task-run")).resolves.toMatchObject({
      taskRuns: [{ id: "run-drifted", userMessageIndex: 1 }]
    });
    await expect(store.list()).resolves.toMatchObject([{ id: "drifted-task-run", taskRuns: [{ userMessageIndex: 1 }] }]);
  });

  it("repairs truncated task-run prompt previews when saving sessions", async () => {
    const store = new SessionStore(tempDir);
    const prompt = `Inspect ${"the browser page ".repeat(20)}`.trim();
    const promptPreview = `${prompt.replace(/\s+/g, " ").slice(0, 179).trimEnd()}...`;
    await store.save({
      id: "save-drifted-task-run",
      cwd: "/tmp/project",
      trustMode: "trusted",
      taskRuns: [
        {
          id: "run-save-drifted",
          userMessageIndex: 0,
          promptPreview,
          status: "completed",
          capabilities: ["browser_control"],
          tools: [],
          approvals: [],
          artifacts: [],
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:01.000Z"
        }
      ],
      messages: [
        { role: "system", content: "You are Arivu, a local CLI coding agent." },
        { role: "user", content: prompt },
        { role: "assistant", content: "Done." }
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z"
    });

    await expect(store.load("save-drifted-task-run")).resolves.toMatchObject({
      taskRuns: [{ id: "run-save-drifted", userMessageIndex: 1 }]
    });
  });

  it("skips malformed session files when listing", async () => {
    const store = new SessionStore(tempDir);
    await writeFile(path.join(tempDir, "broken.json"), "{", "utf8");
    await store.save({
      id: "valid",
      cwd: "/tmp/project",
      trustMode: "ask",
      messages: [{ role: "user", content: "good work" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    await expect(store.list()).resolves.toMatchObject([{ id: "valid" }]);
  });

  it("recovers a truncated primary session from the previous valid backup", async () => {
    const store = new SessionStore(tempDir);
    await store.save({
      id: "recoverable",
      cwd: "/tmp/project",
      trustMode: "ask",
      messages: [{ role: "user", content: "previous good state" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    await store.save({
      id: "recoverable",
      cwd: "/tmp/project",
      trustMode: "ask",
      messages: [{ role: "user", content: "latest state" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z"
    });
    await writeFile(path.join(tempDir, "recoverable.json"), "{", "utf8");
    const restartedStore = new SessionStore(tempDir);

    await expect(restartedStore.list()).resolves.toMatchObject([{ id: "recoverable", messages: [{ content: "previous good state" }] }]);
    await expect(restartedStore.load("recoverable")).resolves.toMatchObject({
      id: "recoverable",
      messages: [{ content: "previous good state" }]
    });

    const healed = JSON.parse(await readFile(path.join(tempDir, "recoverable.json"), "utf8"));
    expect(healed.messages).toMatchObject([{ content: "previous good state" }]);
  });

  it("serializes rapid saves so the last requested snapshot wins", async () => {
    const store = new SessionStore(tempDir);
    const saves = Array.from({ length: 20 }, (_, index) =>
      store.save({
        id: "rapid",
        cwd: "/tmp/project",
        trustMode: "ask",
        messages: [{ role: "user" as const, content: `snapshot ${index}` }],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      })
    );

    await Promise.all(saves);

    await expect(store.load("rapid")).resolves.toMatchObject({
      messages: [{ content: "snapshot 19" }]
    });
    const backup = JSON.parse(await readFile(path.join(tempDir, "rapid.json.bak"), "utf8"));
    expect(backup.messages).toMatchObject([{ content: "snapshot 18" }]);
  });

  it("skips oversized session files when listing", async () => {
    const store = new SessionStore(tempDir);
    await writeFile(path.join(tempDir, "huge.json"), "x".repeat(2 * 1024 * 1024 + 1), "utf8");

    await expect(store.list()).resolves.toEqual([]);
  });

  it("deletes a saved session", async () => {
    const store = new SessionStore(tempDir);
    const session = {
      id: "doomed",
      cwd: "/tmp/project",
      trustMode: "ask" as const,
      messages: [{ role: "user" as const, content: "remove me" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    await store.save(session);
    await store.save({ ...session, updatedAt: "2026-01-02T00:00:00.000Z" });

    await store.delete("doomed");

    await expect(store.list()).resolves.toEqual([]);
    await expect(store.load("doomed")).rejects.toThrow();
    await expect(readFile(path.join(tempDir, "doomed.json.bak"), "utf8")).rejects.toThrow();
  });

  it("externalizes large image attachments and rehydrates them on load", async () => {
    const store = new SessionStore(tempDir);
    const bytes = Buffer.alloc(8_000, 7);
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    await store.save({
      id: "with-image",
      cwd: "/tmp/project",
      trustMode: "ask",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image_url", image_url: { url: dataUrl, detail: "low" }, name: "shot.png", mimeType: "image/png", size: bytes.length }
          ]
        }
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    // The stored JSON must not contain the inline base64 payload.
    const rawFile = await readFile(path.join(tempDir, "with-image.json"), "utf8");
    expect(rawFile).toContain("arivu-attachment:v1:");
    expect(rawFile).not.toContain(bytes.toString("base64"));

    const loaded = await store.load("with-image");
    const imagePart = Array.isArray(loaded.messages[0]?.content)
      ? loaded.messages[0].content.find((part) => part.type === "image_url")
      : undefined;
    expect(imagePart && imagePart.type === "image_url" ? imagePart.image_url.url : "").toBe(dataUrl);

    await store.delete("with-image");
    await expect(readFile(path.join(tempDir, "attachments", "with-image"))).rejects.toThrow();
  });

  it("loads legacy sessions with inline image data urls unchanged", async () => {
    const store = new SessionStore(tempDir);
    const smallDataUrl = "data:image/png;base64,aGVsbG8=";
    await writeFile(
      path.join(tempDir, "legacy-image.json"),
      JSON.stringify({
        id: "legacy-image",
        cwd: "/tmp/project",
        trustMode: "ask",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: smallDataUrl } }] }],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }),
      "utf8"
    );

    const loaded = await store.load("legacy-image");
    const imagePart = Array.isArray(loaded.messages[0]?.content)
      ? loaded.messages[0].content.find((part) => part.type === "image_url")
      : undefined;
    expect(imagePart && imagePart.type === "image_url" ? imagePart.image_url.url : "").toBe(smallDataUrl);
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("skips oversized session files when listing", async () => {
    const store = new SessionStore(tempDir);
    await writeFile(path.join(tempDir, "huge.json"), "x".repeat(2 * 1024 * 1024 + 1), "utf8");

    await expect(store.list()).resolves.toEqual([]);
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

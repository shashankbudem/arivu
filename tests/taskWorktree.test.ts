import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  abortTaskWorktreeConflict,
  cleanupMergedTaskWorktree,
  continueTaskWorktreeConflict,
  createTaskWorktreePullRequest,
  createTaskWorktree,
  discardTaskWorktree,
  mergeTaskWorktree,
  prepareTaskWorktreePullRequest,
  previewTaskWorktreePatch,
  refreshTaskWorktreePullRequest,
  resolveTaskWorktreePath,
  summarizeTaskWorktree,
  syncTaskWorktreeWithOriginal,
  taskWorktreeInstruction
} from "../src/agent/taskWorktree.js";
import type { AgentTaskRunVerification, AgentTaskRunWorktree } from "../src/agent/types.js";

let tempDir: string;

describe("task worktrees", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-task-worktree-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates an isolated git worktree for a task run", async () => {
    const repo = path.join(tempDir, "repo");
    const worktreesRoot = path.join(tempDir, "worktrees");
    await mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "Arivu Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "original\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });

    const worktree = await createTaskWorktree({
      cwd: repo,
      sessionId: "session-1",
      taskRunId: "run-1",
      worktreesRoot
    });

    await expect(realpath(worktree.originalRoot)).resolves.toBe(await realpath(repo));
    expect(worktree.branch).toBe("arivu/task-run-1");
    expect(worktree.path).toBe(path.join(worktreesRoot, "session-1", "run-1"));
    await expect(readFile(path.join(worktree.path, "README.md"), "utf8")).resolves.toBe("original\n");

    await writeFile(path.join(worktree.path, "README.md"), "changed\n", "utf8");
    await expect(readFile(path.join(repo, "README.md"), "utf8")).resolves.toBe("original\n");
    const branch = await execa("git", ["branch", "--show-current"], { cwd: worktree.path });
    expect(branch.stdout).toBe("arivu/task-run-1");
  });

  it("summarizes, commits, fast-forwards, and cleans up a task worktree", async () => {
    const repo = path.join(tempDir, "repo");
    const worktreesRoot = path.join(tempDir, "worktrees");
    await mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "Arivu Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "original\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });

    const worktree = await createTaskWorktree({
      cwd: repo,
      sessionId: "session-1",
      taskRunId: "run-merge",
      worktreesRoot
    });

    await writeFile(path.join(worktree.path, "README.md"), "changed\n", "utf8");
    await writeFile(path.join(worktree.path, "NEW.md"), "new\n", "utf8");

    const summary = await summarizeTaskWorktree({ enabled: true, status: "ready", ...worktree }, { worktreesRoot });
    expect(summary).toMatchObject({
      hasChanges: true,
      files: 2,
      changedPaths: ["NEW.md", "README.md"]
    });

    const preview = await previewTaskWorktreePatch({ enabled: true, status: "ready", ...worktree }, { worktreesRoot });
    expect(preview.patchPreview?.text).toContain("+changed");
    expect(preview.patchPreview?.text).toContain("+new");
    const merged = await mergeTaskWorktree(
      { enabled: true, status: "ready", ...worktree, patchPreview: preview.patchPreview },
      { taskRunId: "run-merge", worktreesRoot }
    );
    expect(merged.status).toBe("merged");
    expect(merged.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    await expect(readFile(path.join(repo, "README.md"), "utf8")).resolves.toBe("changed\n");
    await expect(readFile(path.join(repo, "NEW.md"), "utf8")).resolves.toBe("new\n");

    const cleaned = await cleanupMergedTaskWorktree({ enabled: true, status: "merged", ...worktree }, { worktreesRoot });
    expect(cleaned.status).toBe("cleaned");
    await expect(access(worktree.path)).rejects.toThrow();
    const branch = await execa("git", ["branch", "--list", worktree.branch], { cwd: repo });
    expect(branch.stdout.trim()).toBe("");
  });

  it("requires a patch preview before merging changed worktrees", async () => {
    const repo = path.join(tempDir, "repo");
    const worktreesRoot = path.join(tempDir, "worktrees");
    await mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "Arivu Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "original\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });

    const worktree = await createTaskWorktree({
      cwd: repo,
      sessionId: "session-1",
      taskRunId: "run-preview-required",
      worktreesRoot
    });

    await writeFile(path.join(worktree.path, "README.md"), "changed\n", "utf8");
    await expect(mergeTaskWorktree({ enabled: true, status: "ready", ...worktree }, { worktreesRoot })).rejects.toThrow(
      "Preview the task worktree patch before merging"
    );
  });

  it("syncs a diverged task worktree and records conflicts for manual resolution", async () => {
    const repo = path.join(tempDir, "repo");
    const worktreesRoot = path.join(tempDir, "worktrees");
    await mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "Arivu Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "base\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });

    const worktree = await createTaskWorktree({
      cwd: repo,
      sessionId: "session-1",
      taskRunId: "run-conflict",
      worktreesRoot
    });

    await writeFile(path.join(worktree.path, "README.md"), "task change\n", "utf8");
    await writeFile(path.join(repo, "README.md"), "original change\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "original change"], { cwd: repo });

    const synced = await syncTaskWorktreeWithOriginal(
      { enabled: true, status: "ready", ...worktree },
      { taskRunId: "run-conflict", worktreesRoot, now: "2026-06-27T00:00:00.000Z" }
    );

    expect(synced.conflict).toMatchObject({
      type: "sync",
      files: ["README.md"],
      detectedAt: "2026-06-27T00:00:00.000Z"
    });
    await expect(readFile(path.join(worktree.path, "README.md"), "utf8")).resolves.toContain("<<<<<<<");

    await writeFile(path.join(worktree.path, "README.md"), "resolved change\n", "utf8");
    const continued = await continueTaskWorktreeConflict(
      { enabled: true, status: "ready", ...worktree, conflict: synced.conflict },
      { worktreesRoot }
    );
    expect(continued.conflict).toBeUndefined();
    expect(continued.diff?.changedPaths).toContain("README.md");

    const preview = await previewTaskWorktreePatch({ enabled: true, status: "ready", ...worktree }, { worktreesRoot });
    const merged = await mergeTaskWorktree(
      { enabled: true, status: "ready", ...worktree, patchPreview: preview.patchPreview },
      { taskRunId: "run-conflict", worktreesRoot }
    );
    expect(merged.status).toBe("merged");
    await expect(readFile(path.join(repo, "README.md"), "utf8")).resolves.toBe("resolved change\n");
  });

  it("aborts task worktree conflict resolution", async () => {
    const repo = path.join(tempDir, "repo");
    const worktreesRoot = path.join(tempDir, "worktrees");
    await mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "Arivu Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "base\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });

    const worktree = await createTaskWorktree({
      cwd: repo,
      sessionId: "session-1",
      taskRunId: "run-abort-conflict",
      worktreesRoot
    });

    await writeFile(path.join(worktree.path, "README.md"), "task change\n", "utf8");
    await writeFile(path.join(repo, "README.md"), "original change\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "original change"], { cwd: repo });
    const synced = await syncTaskWorktreeWithOriginal(
      { enabled: true, status: "ready", ...worktree },
      { taskRunId: "run-abort-conflict", worktreesRoot }
    );
    expect(synced.conflict?.files).toEqual(["README.md"]);

    const aborted = await abortTaskWorktreeConflict(
      { enabled: true, status: "ready", ...worktree, conflict: synced.conflict },
      { worktreesRoot }
    );

    expect(aborted.conflict).toBeUndefined();
    await expect(readFile(path.join(worktree.path, "README.md"), "utf8")).resolves.toBe("task change\n");
  });

  it("blocks task worktree promotion when verification failed", async () => {
    const failedVerification: AgentTaskRunVerification = {
      status: "failed",
      summary: "Verification failed: 1 command, 1 failed exit.",
      commandCount: 1,
      failedCommandCount: 1,
      parsedReportCount: 0,
      failedReportCount: 0,
      passedReportCount: 0,
      unknownReportCount: 0,
      updatedAt: "2026-06-25T00:00:00.000Z"
    };
    const worktree: AgentTaskRunWorktree = {
      enabled: true,
      status: "ready",
      originalRoot: "/repo",
      path: "/worktree",
      branch: "arivu/task-failed",
      patchPreview: {
        text: "diff --git a/README.md b/README.md\n",
        bytes: 36,
        lineCount: 1,
        truncated: false,
        updatedAt: "2026-06-25T00:00:00.000Z"
      },
      pullRequest: {
        title: "Arivu: failed task",
        body: "body",
        branch: "arivu/task-failed",
        baseBranch: "main",
        commit: "0123456789012345678901234567890123456789",
        remoteName: "origin",
        preparedAt: "2026-06-25T00:00:00.000Z"
      }
    };

    await expect(mergeTaskWorktree(worktree, { verification: failedVerification })).rejects.toThrow(
      "Resolve failed verification before merging"
    );
    await expect(prepareTaskWorktreePullRequest(worktree, { verification: failedVerification })).rejects.toThrow(
      "Resolve failed verification before preparing a PR draft"
    );
    await expect(createTaskWorktreePullRequest(worktree, { verification: failedVerification })).rejects.toThrow(
      "Resolve failed verification before creating a PR"
    );
  });

  it("truncates task worktree patch previews", async () => {
    const repo = path.join(tempDir, "repo");
    const worktreesRoot = path.join(tempDir, "worktrees");
    await mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "Arivu Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "original\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });

    const worktree = await createTaskWorktree({
      cwd: repo,
      sessionId: "session-1",
      taskRunId: "run-truncated-preview",
      worktreesRoot
    });

    await writeFile(path.join(worktree.path, "README.md"), `${"changed\n".repeat(40)}`, "utf8");
    const preview = await previewTaskWorktreePatch(
      { enabled: true, status: "ready", ...worktree },
      { worktreesRoot, patchPreviewBytes: 120 }
    );
    expect(preview.patchPreview?.truncated).toBe(true);
    expect(preview.patchPreview?.bytes).toBeGreaterThan(120);
    expect(preview.patchPreview?.text.length).toBeLessThanOrEqual(120);
  });

  it("prepares a pull request draft for a previewed task worktree", async () => {
    const repo = path.join(tempDir, "repo");
    const remote = path.join(tempDir, "remote.git");
    const worktreesRoot = path.join(tempDir, "worktrees");
    await mkdir(repo);
    await execa("git", ["init", "--bare", remote]);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "Arivu Test"], { cwd: repo });
    await execa("git", ["remote", "add", "origin", remote], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "original\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });

    const worktree = await createTaskWorktree({
      cwd: repo,
      sessionId: "session-1",
      taskRunId: "run-pr",
      worktreesRoot
    });

    await writeFile(path.join(worktree.path, "README.md"), "changed\n", "utf8");
    const preview = await previewTaskWorktreePatch({ enabled: true, status: "ready", ...worktree }, { worktreesRoot });
    const prepared = await prepareTaskWorktreePullRequest(
      { enabled: true, status: "ready", ...worktree, patchPreview: preview.patchPreview },
      {
        taskRunId: "run-pr",
        promptPreview: "Update the README for PR prep",
        worktreesRoot
      }
    );

    expect(prepared.status).toBe("ready");
    expect(prepared.diff).toMatchObject({
      hasChanges: true,
      files: 1,
      changedPaths: ["README.md"]
    });
    expect(prepared.pullRequest).toMatchObject({
      title: "Arivu: Update the README for PR prep",
      branch: worktree.branch,
      remoteName: "origin",
      remoteUrl: remote
    });
    expect(prepared.pullRequest?.baseBranch).toBeTruthy();
    expect(prepared.pullRequest?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(prepared.pullRequest?.body).toContain("Update the README for PR prep");
    expect(prepared.pullRequest?.pushCommand).toContain("git -C");
    expect(prepared.pullRequest?.createCommand).toContain("gh pr create --draft");
    const status = await execa("git", ["status", "--porcelain=v1"], { cwd: worktree.path });
    expect(status.stdout.trim()).toBe("");
  });

  it("pushes and creates a draft pull request from prepared metadata", async () => {
    const repo = path.join(tempDir, "repo");
    const remote = path.join(tempDir, "remote.git");
    const worktreesRoot = path.join(tempDir, "worktrees");
    await mkdir(repo);
    await execa("git", ["init", "--bare", remote]);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "Arivu Test"], { cwd: repo });
    await execa("git", ["remote", "add", "origin", remote], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "original\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });

    const worktree = await createTaskWorktree({
      cwd: repo,
      sessionId: "session-1",
      taskRunId: "run-create-pr",
      worktreesRoot
    });

    await writeFile(path.join(worktree.path, "README.md"), "changed\n", "utf8");
    const preview = await previewTaskWorktreePatch({ enabled: true, status: "ready", ...worktree }, { worktreesRoot });
    const prepared = await prepareTaskWorktreePullRequest(
      { enabled: true, status: "ready", ...worktree, patchPreview: preview.patchPreview },
      { taskRunId: "run-create-pr", promptPreview: "Create a PR", worktreesRoot }
    );
    const pullRequest = prepared.pullRequest;
    expect(pullRequest).toBeDefined();
    if (!pullRequest) {
      throw new Error("Expected pull request draft");
    }
    expect(pullRequest.baseBranch).toBeTruthy();
    if (!pullRequest.baseBranch) {
      throw new Error("Expected pull request base branch");
    }
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const created = await createTaskWorktreePullRequest(
      { enabled: true, status: "ready", ...worktree, diff: prepared.diff, pullRequest },
      {
        worktreesRoot,
        now: "2026-06-24T00:00:00.000Z",
        commandRunner: async (file, args, options) => {
          calls.push({ file, args, cwd: options.cwd });
          return {
            stdout: file === "gh" ? "https://github.com/acme/repo/pull/42\n" : "",
            stderr: "",
            exitCode: 0
          };
        }
      }
    );

    expect(calls).toEqual([
      { file: "git", args: ["push", "-u", "origin", worktree.branch], cwd: worktree.path },
      {
        file: "gh",
        args: [
          "pr",
          "create",
          "--draft",
          "--base",
          pullRequest.baseBranch,
          "--head",
          worktree.branch,
          "--title",
          pullRequest.title,
          "--body",
          pullRequest.body
        ],
        cwd: worktree.path
      }
    ]);
    expect(created.pullRequest).toMatchObject({
      url: "https://github.com/acme/repo/pull/42",
      pushedAt: "2026-06-24T00:00:00.000Z",
      createdAt: "2026-06-24T00:00:00.000Z"
    });
  });

  it("refreshes created pull request review and check status", async () => {
    const worktreesRoot = path.join(tempDir, "worktrees");
    const worktreePath = path.join(worktreesRoot, "session-1", "run-refresh-pr");
    await mkdir(worktreePath, { recursive: true });
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const refreshed = await refreshTaskWorktreePullRequest(
      {
        enabled: true,
        status: "ready",
        originalRoot: path.join(tempDir, "repo"),
        path: worktreePath,
        branch: "arivu/task-refresh",
        pullRequest: {
          title: "Arivu: Refresh PR",
          body: "Summary",
          branch: "arivu/task-refresh",
          commit: "abc123",
          preparedAt: "2026-06-24T00:00:00.000Z",
          createdAt: "2026-06-24T00:01:00.000Z",
          url: "https://github.com/acme/repo/pull/42"
        }
      },
      {
        worktreesRoot,
        now: "2026-07-01T00:00:00.000Z",
        commandRunner: async (file, args, options) => {
          calls.push({ file, args, cwd: options.cwd });
          if (args[0] === "api") {
            return {
              stdout: JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        nodes: [
                          {
                            isResolved: false,
                            path: "src/lint.ts",
                            line: 12,
                            comments: {
                              nodes: [
                                {
                                  author: { login: "reviewer-two" },
                                  body: "This path still fails lint.",
                                  path: "src/lint.ts",
                                  line: 12,
                                  createdAt: "2026-06-30T23:40:00.000Z",
                                  updatedAt: "2026-06-30T23:45:00.000Z",
                                  url: "https://github.com/acme/repo/pull/42#discussion_r1"
                                }
                              ]
                            }
                          },
                          {
                            isResolved: true,
                            path: "README.md",
                            originalLine: 4,
                            comments: {
                              nodes: [
                                {
                                  author: { login: "reviewer-one" },
                                  body: "Resolved after the docs update.",
                                  path: "README.md",
                                  originalLine: 4,
                                  createdAt: "2026-06-30T22:00:00.000Z",
                                  updatedAt: "2026-06-30T22:05:00.000Z",
                                  url: "https://github.com/acme/repo/pull/42#discussion_r2"
                                }
                              ]
                            }
                          }
                        ]
                      }
                    }
                  }
                }
              }),
              stderr: "",
              exitCode: 0
            };
          }
          return {
            stdout: JSON.stringify({
              state: "OPEN",
              isDraft: false,
              reviewDecision: "CHANGES_REQUESTED",
              mergeStateStatus: "BLOCKED",
              statusCheckRollup: [
                { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci.example/test" },
                {
                  __typename: "CheckRun",
                  name: "lint",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                  detailsUrl: "https://github.com/acme/repo/actions/runs/123456/job/7890"
                },
                { __typename: "StatusContext", context: "deploy", state: "PENDING", targetUrl: "https://ci.example/deploy" }
              ],
              comments: [
                {
                  author: { login: "reviewer-one" },
                  body: "Can you explain the new fallback?",
                  createdAt: "2026-06-30T23:00:00.000Z",
                  updatedAt: "2026-06-30T23:00:00.000Z",
                  url: "https://github.com/acme/repo/pull/42#issuecomment-1"
                }
              ],
              reviews: [
                {
                  author: { login: "reviewer-two" },
                  state: "CHANGES_REQUESTED",
                  body: "Please fix the failing lint path before merge.",
                  submittedAt: "2026-06-30T23:30:00.000Z",
                  url: "https://github.com/acme/repo/pull/42#pullrequestreview-1"
                },
                {
                  author: { login: "reviewer-three" },
                  state: "APPROVED",
                  body: "",
                  submittedAt: "2026-06-30T22:30:00.000Z"
                }
              ]
            }),
            stderr: "",
            exitCode: 0
          };
        }
      }
    );

    expect(calls[0]).toEqual({
      file: "gh",
      args: [
        "pr",
        "view",
        "https://github.com/acme/repo/pull/42",
        "--json",
        "state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,comments,reviews,url"
      ],
      cwd: worktreePath
    });
    expect(calls[1]).toMatchObject({
      file: "gh",
      cwd: worktreePath
    });
    expect(calls[1]?.args).toContain("graphql");
    expect(calls[1]?.args).toContain("-F");
    expect(calls[1]?.args).toContain("owner=acme");
    expect(calls[1]?.args).toContain("repo=repo");
    expect(calls[1]?.args).toContain("number=42");
    expect(calls[1]?.args.find((arg) => arg.startsWith("query="))).toContain("reviewThreads");
    expect(refreshed.pullRequest?.review).toMatchObject({
      state: "OPEN",
      isDraft: false,
      reviewDecision: "CHANGES_REQUESTED",
      mergeStateStatus: "BLOCKED",
      checkSummary: "3 checks: 1 passed, 1 failed, 1 pending",
      summary:
        "open - review changes requested - merge blocked - 3 checks: 1 passed, 1 failed, 1 pending - Review feedback: 2 reviews, 1 comment, 2 line threads, 1 unresolved thread, 1 changes requested, 1 approved",
      updatedAt: "2026-07-01T00:00:00.000Z",
      checks: {
        total: 3,
        passed: 1,
        failed: 1,
        pending: 1,
        skipped: 0,
        cancelled: 0,
        unknown: 0
      },
      checkItems: [
        {
          name: "lint",
          bucket: "failed",
          status: "COMPLETED",
          conclusion: "FAILURE",
          detailsUrl: "https://github.com/acme/repo/actions/runs/123456/job/7890",
          logCommand: "gh run view '123456' --repo 'acme/repo' --job '7890' --log-failed"
        },
        {
          name: "deploy",
          bucket: "pending",
          state: "PENDING",
          detailsUrl: "https://ci.example/deploy"
        },
        {
          name: "test",
          bucket: "passed",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          detailsUrl: "https://ci.example/test"
        }
      ],
      feedback: {
        total: 5,
        comments: 1,
        reviews: 2,
        threads: 2,
        unresolvedThreads: 1,
        resolvedThreads: 1,
        changesRequested: 1,
        approved: 1,
        commented: 0,
        summary: "Review feedback: 2 reviews, 1 comment, 2 line threads, 1 unresolved thread, 1 changes requested, 1 approved",
        items: [
          {
            kind: "thread",
            author: "reviewer-two",
            state: "UNRESOLVED",
            body: "This path still fails lint.",
            path: "src/lint.ts",
            line: 12,
            createdAt: "2026-06-30T23:40:00.000Z",
            updatedAt: "2026-06-30T23:45:00.000Z",
            url: "https://github.com/acme/repo/pull/42#discussion_r1"
          },
          {
            kind: "review",
            author: "reviewer-two",
            state: "CHANGES_REQUESTED",
            body: "Please fix the failing lint path before merge.",
            createdAt: "2026-06-30T23:30:00.000Z",
            updatedAt: "2026-06-30T23:30:00.000Z",
            url: "https://github.com/acme/repo/pull/42#pullrequestreview-1"
          },
          {
            kind: "comment",
            author: "reviewer-one",
            body: "Can you explain the new fallback?",
            createdAt: "2026-06-30T23:00:00.000Z",
            updatedAt: "2026-06-30T23:00:00.000Z",
            url: "https://github.com/acme/repo/pull/42#issuecomment-1"
          },
          {
            kind: "review",
            author: "reviewer-three",
            state: "APPROVED",
            createdAt: "2026-06-30T22:30:00.000Z",
            updatedAt: "2026-06-30T22:30:00.000Z"
          },
          {
            kind: "thread",
            author: "reviewer-one",
            state: "RESOLVED",
            body: "Resolved after the docs update.",
            path: "README.md",
            line: 4,
            createdAt: "2026-06-30T22:00:00.000Z",
            updatedAt: "2026-06-30T22:05:00.000Z",
            url: "https://github.com/acme/repo/pull/42#discussion_r2"
          }
        ]
      }
    });
  });

  it("keeps pull request refresh usable when review thread lookup fails", async () => {
    const worktreesRoot = path.join(tempDir, "worktrees");
    const worktreePath = path.join(worktreesRoot, "session-1", "run-refresh-pr-thread-failure");
    await mkdir(worktreePath, { recursive: true });
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const refreshed = await refreshTaskWorktreePullRequest(
      {
        enabled: true,
        status: "ready",
        originalRoot: path.join(tempDir, "repo"),
        path: worktreePath,
        branch: "arivu/task-refresh",
        pullRequest: {
          title: "Arivu: Refresh PR",
          body: "Summary",
          branch: "arivu/task-refresh",
          commit: "abc123",
          preparedAt: "2026-06-24T00:00:00.000Z",
          createdAt: "2026-06-24T00:01:00.000Z",
          url: "https://github.com/acme/repo/pull/42"
        }
      },
      {
        worktreesRoot,
        now: "2026-07-01T00:00:00.000Z",
        commandRunner: async (file, args, options) => {
          calls.push({ file, args, cwd: options.cwd });
          if (args[0] === "api") {
            throw new Error("missing review thread scope");
          }
          return {
            stdout: JSON.stringify({
              state: "OPEN",
              isDraft: false,
              reviewDecision: "REVIEW_REQUIRED",
              mergeStateStatus: "UNKNOWN",
              statusCheckRollup: [],
              comments: [],
              reviews: []
            }),
            stderr: "",
            exitCode: 0
          };
        }
      }
    );

    expect(calls).toHaveLength(2);
    expect(refreshed.pullRequest?.review?.feedback).toMatchObject({
      total: 0,
      threads: 0,
      summary: "No review comments reported",
      threadFetchError: "missing review thread scope",
      items: []
    });
  });

  it("requires a created pull request before refreshing PR status", async () => {
    const worktreesRoot = path.join(tempDir, "worktrees");
    const worktreePath = path.join(worktreesRoot, "session-1", "run-refresh-pr-missing");
    await mkdir(worktreePath, { recursive: true });

    await expect(
      refreshTaskWorktreePullRequest(
        {
          enabled: true,
          status: "ready",
          originalRoot: path.join(tempDir, "repo"),
          path: worktreePath,
          branch: "arivu/task-refresh",
          pullRequest: {
            title: "Arivu: Refresh PR",
            body: "Summary",
            branch: "arivu/task-refresh",
            commit: "abc123",
            preparedAt: "2026-06-24T00:00:00.000Z"
          }
        },
        { worktreesRoot }
      )
    ).rejects.toThrow("Create a pull request before refreshing PR status");
  });

  it("requires a patch preview before preparing a pull request draft", async () => {
    const repo = path.join(tempDir, "repo");
    const worktreesRoot = path.join(tempDir, "worktrees");
    await mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "Arivu Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "original\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });

    const worktree = await createTaskWorktree({
      cwd: repo,
      sessionId: "session-1",
      taskRunId: "run-pr-preview-required",
      worktreesRoot
    });

    await writeFile(path.join(worktree.path, "README.md"), "changed\n", "utf8");
    await expect(
      prepareTaskWorktreePullRequest({ enabled: true, status: "ready", ...worktree }, { worktreesRoot })
    ).rejects.toThrow("Preview the task worktree patch before preparing a PR draft");
  });

  it("summarizes committed task branch changes relative to the base commit", async () => {
    const repo = path.join(tempDir, "repo");
    const worktreesRoot = path.join(tempDir, "worktrees");
    await mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "Arivu Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "original\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });

    const worktree = await createTaskWorktree({
      cwd: repo,
      sessionId: "session-1",
      taskRunId: "run-committed",
      worktreesRoot
    });

    await writeFile(path.join(worktree.path, "README.md"), "committed\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: worktree.path });
    await execa("git", ["commit", "-m", "task change"], { cwd: worktree.path });

    const summary = await summarizeTaskWorktree({ enabled: true, status: "ready", ...worktree }, { worktreesRoot });
    expect(summary).toMatchObject({
      hasChanges: true,
      files: 1,
      changedPaths: ["README.md"]
    });
  });

  it("discards a task worktree and deletes its task branch", async () => {
    const repo = path.join(tempDir, "repo");
    const worktreesRoot = path.join(tempDir, "worktrees");
    await mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "Arivu Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "original\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });

    const worktree = await createTaskWorktree({
      cwd: repo,
      sessionId: "session-1",
      taskRunId: "run-discard",
      worktreesRoot
    });

    await writeFile(path.join(worktree.path, "README.md"), "changed\n", "utf8");
    const discarded = await discardTaskWorktree({ enabled: true, status: "ready", ...worktree }, { worktreesRoot });
    expect(discarded.status).toBe("discarded");
    await expect(access(worktree.path)).rejects.toThrow();
    const branch = await execa("git", ["branch", "--list", worktree.branch], { cwd: repo });
    expect(branch.stdout.trim()).toBe("");
    await expect(readFile(path.join(repo, "README.md"), "utf8")).resolves.toBe("original\n");
  });

  it("discards stale task worktree records when the folder is already missing", async () => {
    const repo = path.join(tempDir, "repo");
    const worktreesRoot = path.join(tempDir, "worktrees");
    await mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "Arivu Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "original\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });

    const worktree = await createTaskWorktree({
      cwd: repo,
      sessionId: "session-1",
      taskRunId: "run-stale-discard",
      worktreesRoot
    });

    await rm(worktree.path, { recursive: true, force: true });
    const discarded = await discardTaskWorktree({ enabled: true, status: "ready", ...worktree }, { worktreesRoot });

    expect(discarded.status).toBe("discarded");
    await expect(access(worktree.path)).rejects.toThrow();
    const branch = await execa("git", ["branch", "--list", worktree.branch], { cwd: repo });
    expect(branch.stdout.trim()).toBe("");
    const worktreeList = await execa("git", ["worktree", "list", "--porcelain"], { cwd: repo });
    expect(worktreeList.stdout).not.toContain(worktree.path);
  });

  it("cleans up stale merged task worktree records when the folder is already missing", async () => {
    const repo = path.join(tempDir, "repo");
    const worktreesRoot = path.join(tempDir, "worktrees");
    await mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "Arivu Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "original\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });

    const worktree = await createTaskWorktree({
      cwd: repo,
      sessionId: "session-1",
      taskRunId: "run-stale-cleanup",
      worktreesRoot
    });
    const diff = await summarizeTaskWorktree({ enabled: true, status: "ready", ...worktree }, { worktreesRoot });
    const merged = await mergeTaskWorktree({ enabled: true, status: "ready", ...worktree, diff }, { worktreesRoot });

    expect(merged.status).toBe("merged");
    await rm(worktree.path, { recursive: true, force: true });
    const cleaned = await cleanupMergedTaskWorktree({ enabled: true, status: "merged", ...worktree }, { worktreesRoot });

    expect(cleaned.status).toBe("cleaned");
    await expect(access(worktree.path)).rejects.toThrow();
    const branch = await execa("git", ["branch", "--list", worktree.branch], { cwd: repo });
    expect(branch.stdout.trim()).toBe("");
    const worktreeList = await execa("git", ["worktree", "list", "--porcelain"], { cwd: repo });
    expect(worktreeList.stdout).not.toContain(worktree.path);
  });

  it("resolves only managed Arivu task worktree folders for opening", async () => {
    const repo = path.join(tempDir, "repo");
    const worktreesRoot = path.join(tempDir, "worktrees");
    await mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execa("git", ["config", "user.name", "Arivu Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "original\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });

    const worktree = await createTaskWorktree({
      cwd: repo,
      sessionId: "session-1",
      taskRunId: "run-open",
      worktreesRoot
    });

    await expect(resolveTaskWorktreePath({ enabled: true, status: "ready", ...worktree }, { worktreesRoot })).resolves.toBe(worktree.path);
    await expect(
      resolveTaskWorktreePath(
        {
          enabled: true,
          status: "ready",
          originalRoot: repo,
          path: repo,
          branch: "arivu/task-outside"
        },
        { worktreesRoot }
      )
    ).rejects.toThrow("outside Arivu app data");
  });

  it("builds an instruction that points the model at the task worktree", () => {
    const instruction = taskWorktreeInstruction({
      originalRoot: "/repo",
      path: "/worktree",
      branch: "arivu/task-abc",
      baseRef: "abc1234",
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    expect(instruction).toContain("/worktree");
    expect(instruction).toContain("arivu/task-abc");
    expect(instruction).toContain("original project root is /repo");
  });
});

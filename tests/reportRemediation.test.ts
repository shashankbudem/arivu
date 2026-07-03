import { describe, expect, it } from "vitest";
import {
  REPORT_REMEDIATION_MARKER_PREFIX,
  buildReportRemediationPrompt,
  buildTaskRunPullRequestReviewPrompt,
  buildTaskRunReportRemediationInstruction,
  buildTaskRunReplayFailureReviewPrompt,
  buildTaskRunVerificationRepairPrompt,
  buildTaskRunVerificationReplayPrompt,
  buildTaskRunVerificationRerunPrompt
} from "../src/agent/reportRemediation.js";
import type { AgentTaskRun, AgentTaskRunArtifact } from "../src/agent/types.js";

describe("report remediation prompts", () => {
  it("builds a focused prompt from failed JUnit evidence", () => {
    const artifact: AgentTaskRunArtifact = {
      id: "artifact-1",
      kind: "command_output",
      title: "Command output",
      exitCode: 1,
      testReports: [
        {
          kind: "junit",
          path: "reports/junit.xml",
          summary: "3 tests, 1 failed",
          status: "failed",
          tests: 3,
          failures: 1,
          failedTests: [
            {
              classname: "math.add",
              name: "returns sum",
              file: "src/math.test.ts",
              line: 12,
              message: "expected 4 to equal 5"
            }
          ]
        }
      ],
      createdAt: "2026-06-24T00:00:00.000Z"
    };

    const prompt = buildReportRemediationPrompt(artifact);

    expect(prompt).toContain("fix the failing checks");
    expect(prompt).toContain("reports/junit.xml");
    expect(prompt).toContain("math.add.returns sum");
    expect(prompt).toContain("src/math.test.ts:12");
    expect(prompt).toContain("expected 4 to equal 5");
    expect(prompt).toContain("rerun the relevant test");
  });

  it("builds a focused prompt from SARIF findings", () => {
    const artifact: AgentTaskRunArtifact = {
      id: "artifact-2",
      kind: "command_output",
      title: "Command output",
      exitCode: 1,
      testReports: [
        {
          kind: "sarif",
          path: "reports/scan.sarif",
          summary: "2 findings, 1 error",
          status: "failed",
          findings: 2,
          errorFindings: 1,
          findingDetails: [
            {
              ruleId: "no-hardcoded-secret",
              level: "error",
              path: "src/config.ts",
              line: 44,
              column: 7,
              message: "Avoid hard-coded secrets."
            }
          ]
        }
      ],
      createdAt: "2026-06-24T00:00:00.000Z"
    };

    const prompt = buildReportRemediationPrompt(artifact);

    expect(prompt).toContain("reports/scan.sarif");
    expect(prompt).toContain("no-hardcoded-secret error");
    expect(prompt).toContain("src/config.ts:44:7");
    expect(prompt).toContain("Avoid hard-coded secrets.");
  });

  it("does not build a prompt when command reports have no actionable evidence", () => {
    const artifact: AgentTaskRunArtifact = {
      id: "artifact-3",
      kind: "command_output",
      title: "Command output",
      exitCode: 0,
      testReports: [
        {
          kind: "junit",
          path: "reports/junit.xml",
          summary: "3 tests",
          status: "passed",
          tests: 3
        }
      ],
      createdAt: "2026-06-24T00:00:00.000Z"
    };

    expect(buildReportRemediationPrompt(artifact)).toBeUndefined();
  });

  it("builds a loop continuation instruction from the latest actionable task-run artifact once", () => {
    const taskRun: AgentTaskRun = {
      id: "run-1",
      userMessageIndex: 0,
      promptPreview: "fix checks",
      status: "running",
      capabilities: ["run_command"],
      tools: [],
      approvals: [],
      artifacts: [
        {
          id: "artifact-old",
          kind: "command_output",
          title: "Command output",
          testReports: [
            {
              kind: "junit",
              path: "reports/old.xml",
              summary: "1 test, 1 failed",
              status: "failed",
              tests: 1,
              failures: 1,
              failedTests: [{ name: "old test", file: "old.test.ts" }]
            }
          ],
          createdAt: "2026-06-24T00:00:00.000Z"
        },
        {
          id: "artifact-new",
          kind: "command_output",
          title: "Command output",
          testReports: [
            {
              kind: "sarif",
              path: "reports/new.sarif",
              summary: "1 finding",
              status: "failed",
              findings: 1,
              findingDetails: [{ ruleId: "new-rule", path: "src/new.ts", line: 8 }]
            }
          ],
          createdAt: "2026-06-24T00:00:01.000Z"
        }
      ],
      startedAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:01.000Z"
    };

    const instruction = buildTaskRunReportRemediationInstruction(taskRun, []);

    expect(instruction).toContain(`${REPORT_REMEDIATION_MARKER_PREFIX} artifact-new`);
    expect(instruction).toContain("reports/new.sarif");
    expect(instruction).toContain("new-rule");
    expect(instruction).not.toContain("reports/old.xml");
    expect(buildTaskRunReportRemediationInstruction(taskRun, [{ role: "system", content: instruction ?? "" }])).toBeUndefined();
  });

  it("builds a worktree repair prompt from failed verification and command evidence", () => {
    const taskRun: AgentTaskRun = {
      id: "run-failed",
      userMessageIndex: 0,
      promptPreview: "fix tests",
      status: "completed",
      worktree: {
        enabled: true,
        status: "ready",
        originalRoot: "/repo",
        path: "/worktree",
        branch: "arivu/task-failed"
      },
      verification: {
        status: "failed",
        summary: "Verification failed: 1 command, 1 failed exit.",
        commandCount: 1,
        failedCommandCount: 1,
        parsedReportCount: 0,
        failedReportCount: 0,
        passedReportCount: 0,
        unknownReportCount: 0,
        updatedAt: "2026-06-25T00:00:00.000Z"
      },
      capabilities: ["run_command"],
      tools: [],
      approvals: [],
      artifacts: [
        {
          id: "artifact-command",
          kind: "command_output",
          title: "Command output",
          command: "npm test",
          workingDirectory: "/worktree",
          exitCode: 1,
          stderr: "expected true to be false",
          createdAt: "2026-06-25T00:00:00.000Z"
        }
      ],
      startedAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:01.000Z"
    };

    const prompt = buildTaskRunVerificationRepairPrompt(taskRun);

    expect(prompt).toContain("Continue fixing the existing Arivu task worktree");
    expect(prompt).toContain("run-failed");
    expect(prompt).toContain("arivu/task-failed");
    expect(prompt).toContain("/worktree");
    expect(prompt).toContain("Verification failed: 1 command, 1 failed exit.");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("expected true to be false");
  });

  it("does not build a worktree repair prompt for passed verification", () => {
    const taskRun: AgentTaskRun = {
      id: "run-passed",
      userMessageIndex: 0,
      promptPreview: "fix tests",
      status: "completed",
      worktree: {
        enabled: true,
        status: "ready",
        path: "/worktree",
        branch: "arivu/task-passed"
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
        updatedAt: "2026-06-25T00:00:00.000Z"
      },
      capabilities: [],
      tools: [],
      approvals: [],
      artifacts: [],
      startedAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:01.000Z"
    };

    expect(buildTaskRunVerificationRepairPrompt(taskRun)).toBeUndefined();
  });

  it("builds a continued worktree verification rerun prompt from previous failed commands", () => {
    const sourceRun: AgentTaskRun = {
      id: "run-original",
      userMessageIndex: 0,
      promptPreview: "fix tests",
      status: "completed",
      worktree: {
        enabled: true,
        status: "ready",
        originalRoot: "/repo",
        path: "/worktree",
        branch: "arivu/task-failed"
      },
      verification: {
        status: "failed",
        summary: "Verification failed: 1 command, 1 failed exit.",
        commandCount: 1,
        failedCommandCount: 1,
        parsedReportCount: 0,
        failedReportCount: 0,
        passedReportCount: 0,
        unknownReportCount: 0,
        updatedAt: "2026-06-25T00:00:00.000Z"
      },
      capabilities: ["run_command"],
      tools: [],
      approvals: [],
      artifacts: [
        {
          id: "artifact-command",
          kind: "command_output",
          title: "Command output",
          command: "npm test",
          workingDirectory: "/worktree",
          exitCode: 1,
          stderr: "expected true to be false",
          createdAt: "2026-06-25T00:00:00.000Z"
        }
      ],
      startedAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:01.000Z"
    };
    const repairRun: AgentTaskRun = {
      id: "run-repair",
      userMessageIndex: 1,
      promptPreview: "repair failed checks",
      status: "completed",
      worktree: {
        enabled: true,
        status: "ready",
        originalRoot: "/repo",
        path: "/worktree",
        branch: "arivu/task-failed",
        continuedFromTaskRunId: "run-original"
      },
      verification: {
        status: "unknown",
        summary: "Verification unknown: No command verification evidence captured.",
        commandCount: 0,
        failedCommandCount: 0,
        parsedReportCount: 0,
        failedReportCount: 0,
        passedReportCount: 0,
        unknownReportCount: 0,
        updatedAt: "2026-06-25T00:05:00.000Z"
      },
      capabilities: ["write_workspace"],
      tools: [],
      approvals: [],
      artifacts: [
        {
          id: "artifact-patch",
          kind: "patch",
          title: "Patch applied",
          changedPaths: ["src/example.ts"],
          additions: 1,
          deletions: 1,
          createdAt: "2026-06-25T00:04:00.000Z"
        }
      ],
      startedAt: "2026-06-25T00:03:00.000Z",
      updatedAt: "2026-06-25T00:05:00.000Z"
    };

    const prompt = buildTaskRunVerificationRerunPrompt(repairRun, sourceRun);

    expect(prompt).toContain("rerun verification");
    expect(prompt).toContain("run-repair");
    expect(prompt).toContain("run-original");
    expect(prompt).toContain("arivu/task-failed");
    expect(prompt).toContain("/worktree");
    expect(prompt).toContain("Verification failed: 1 command, 1 failed exit.");
    expect(prompt).toContain("npm test");
  });

  it("does not build a verification rerun prompt for fresh or passed worktree runs", () => {
    const baseRun: AgentTaskRun = {
      id: "run-passed",
      userMessageIndex: 0,
      promptPreview: "fix tests",
      status: "completed",
      worktree: {
        enabled: true,
        status: "ready",
        path: "/worktree",
        branch: "arivu/task-passed"
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
        updatedAt: "2026-06-25T00:00:00.000Z"
      },
      capabilities: [],
      tools: [],
      approvals: [],
      artifacts: [],
      startedAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:01.000Z"
    };

    expect(buildTaskRunVerificationRerunPrompt(baseRun)).toBeUndefined();
    expect(
      buildTaskRunVerificationRerunPrompt({
        ...baseRun,
        id: "run-continued-passed",
        worktree: {
          enabled: true,
          status: "ready",
          path: "/worktree",
          branch: "arivu/task-passed",
          continuedFromTaskRunId: "run-original"
        }
      })
    ).toBeUndefined();
  });

  it("builds a verification replay prompt from a prior attempt into the current worktree", () => {
    const evidenceRun: AgentTaskRun = {
      id: "run-evidence",
      userMessageIndex: 0,
      promptPreview: "fix the failing test",
      status: "completed",
      worktree: {
        enabled: true,
        status: "ready",
        path: "/worktree",
        branch: "arivu/task-repair"
      },
      verification: {
        status: "failed",
        summary: "Verification failed: npm test exited 1.",
        commandCount: 1,
        failedCommandCount: 1,
        parsedReportCount: 0,
        failedReportCount: 0,
        passedReportCount: 0,
        unknownReportCount: 0,
        updatedAt: "2026-06-27T00:00:00.000Z"
      },
      capabilities: ["run_command"],
      tools: [],
      approvals: [],
      artifacts: [
        {
          id: "artifact-command",
          kind: "command_output",
          title: "Command output",
          command: "npm test",
          workingDirectory: "/worktree",
          exitCode: 1,
          createdAt: "2026-06-27T00:00:00.000Z"
        }
      ],
      startedAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:01:00.000Z"
    };
    const currentRun: AgentTaskRun = {
      ...evidenceRun,
      id: "run-current",
      userMessageIndex: 1,
      promptPreview: "repair the test",
      worktree: {
        enabled: true,
        status: "ready",
        originalRoot: "/repo",
        path: "/worktree",
        branch: "arivu/task-repair",
        continuedFromTaskRunId: "run-evidence"
      },
      verification: {
        status: "unknown",
        summary: "Verification unknown: no commands captured.",
        commandCount: 0,
        failedCommandCount: 0,
        parsedReportCount: 0,
        failedReportCount: 0,
        passedReportCount: 0,
        unknownReportCount: 0,
        updatedAt: "2026-06-27T00:05:00.000Z"
      },
      artifacts: [],
      updatedAt: "2026-06-27T00:05:00.000Z"
    };

    const prompt = buildTaskRunVerificationReplayPrompt(evidenceRun, currentRun);

    expect(prompt).toContain("replay verification from a prior repair attempt");
    expect(prompt).toContain("Current run: run-current");
    expect(prompt).toContain("Evidence run: run-evidence");
    expect(prompt).toContain("Current continued from: run-evidence");
    expect(prompt).toContain("arivu/task-repair");
    expect(prompt).toContain("/worktree");
    expect(prompt).toContain("Verification failed: npm test exited 1.");
    expect(prompt).toContain("npm test");
  });

  it("does not build a verification replay prompt without commands or a ready target worktree", () => {
    const baseRun: AgentTaskRun = {
      id: "run-no-command",
      userMessageIndex: 0,
      promptPreview: "fix tests",
      status: "completed",
      worktree: {
        enabled: true,
        status: "ready",
        path: "/worktree",
        branch: "arivu/task-repair"
      },
      capabilities: [],
      tools: [],
      approvals: [],
      artifacts: [],
      startedAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:01:00.000Z"
    };

    expect(buildTaskRunVerificationReplayPrompt(baseRun)).toBeUndefined();
    expect(
      buildTaskRunVerificationReplayPrompt(
        {
          ...baseRun,
          artifacts: [
            {
              id: "artifact-command",
              kind: "command_output",
              title: "Command output",
              command: "npm test",
              createdAt: "2026-06-27T00:00:00.000Z"
            }
          ]
        },
        {
          ...baseRun,
          id: "run-merged",
          worktree: {
            enabled: true,
            status: "merged",
            path: "/worktree",
            branch: "arivu/task-repair"
          }
        }
      )
    ).toBeUndefined();
  });

  it("builds a pull request review handoff prompt for a created PR", () => {
    const taskRun: AgentTaskRun = {
      id: "run-pr",
      userMessageIndex: 0,
      promptPreview: "implement the feature",
      status: "completed",
      worktree: {
        enabled: true,
        status: "ready",
        originalRoot: "/repo",
        path: "/worktree",
        branch: "arivu/task-pr",
        pullRequest: {
          title: "Implement the feature",
          body: "Summary",
          branch: "arivu/task-pr",
          baseBranch: "main",
          baseRef: "origin/main",
          commit: "abc1234",
          remoteName: "origin",
          remoteUrl: "git@github.com:example/repo.git",
          preparedAt: "2026-06-27T00:00:00.000Z",
          createdAt: "2026-06-27T00:05:00.000Z",
          url: "https://github.com/example/repo/pull/42",
          review: {
            state: "OPEN",
            isDraft: true,
            reviewDecision: "CHANGES_REQUESTED",
            mergeStateStatus: "BLOCKED",
            checkSummary: "3 checks: 1 passed, 1 failed, 1 pending",
            checks: {
              total: 3,
              passed: 1,
              failed: 1,
              pending: 1,
              skipped: 0,
              cancelled: 0,
              unknown: 0
            },
            summary: "Open draft PR has changes requested and 1 failed check.",
            feedback: {
              total: 3,
              comments: 1,
              reviews: 1,
              threads: 1,
              unresolvedThreads: 1,
              resolvedThreads: 0,
              changesRequested: 1,
              approved: 0,
              commented: 0,
              summary: "Review feedback: 1 review, 1 comment, 1 line thread, 1 unresolved thread, 1 changes requested",
              items: [
                {
                  kind: "review",
                  author: "reviewer-two",
                  state: "CHANGES_REQUESTED",
                  body: "Please fix the failing lint path.",
                  updatedAt: "2026-06-27T00:05:30.000Z"
                },
                {
                  kind: "comment",
                  author: "reviewer-one",
                  body: "Can you add a note about the fallback?",
                  updatedAt: "2026-06-27T00:05:00.000Z"
                },
                {
                  kind: "thread",
                  author: "reviewer-three",
                  state: "UNRESOLVED",
                  body: "The fallback still needs a regression test.",
                  path: "src/fallback.ts",
                  line: 17,
                  updatedAt: "2026-06-27T00:04:30.000Z"
                }
              ]
            },
            updatedAt: "2026-06-27T00:06:00.000Z"
          }
        }
      },
      verification: {
        status: "passed",
        summary: "Verification passed: npm test succeeded.",
        commandCount: 1,
        failedCommandCount: 0,
        parsedReportCount: 0,
        failedReportCount: 0,
        passedReportCount: 0,
        unknownReportCount: 0,
        updatedAt: "2026-06-27T00:04:00.000Z"
      },
      capabilities: ["run_command", "write_workspace"],
      tools: [],
      approvals: [],
      artifacts: [
        {
          id: "artifact-test",
          kind: "command_output",
          title: "Command output",
          command: "npm test",
          workingDirectory: "/worktree",
          exitCode: 0,
          createdAt: "2026-06-27T00:03:00.000Z"
        }
      ],
      startedAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:05:00.000Z"
    };

    const prompt = buildTaskRunPullRequestReviewPrompt(taskRun);

    expect(prompt).toContain("review the created pull request");
    expect(prompt).toContain("Use the same managed worktree");
    expect(prompt).toContain("Current run: run-pr");
    expect(prompt).toContain("Branch: arivu/task-pr");
    expect(prompt).toContain("Path: /worktree");
    expect(prompt).toContain("Original project: /repo");
    expect(prompt).toContain("Title: Implement the feature");
    expect(prompt).toContain("URL: https://github.com/example/repo/pull/42");
    expect(prompt).toContain("Base branch: main");
    expect(prompt).toContain("Remote: origin");
    expect(prompt).toContain("Commit: abc1234");
    expect(prompt).toContain("Last refreshed PR status");
    expect(prompt).toContain("Open draft PR has changes requested and 1 failed check.");
    expect(prompt).toContain("Review decision: CHANGES_REQUESTED");
    expect(prompt).toContain("Merge state: BLOCKED");
    expect(prompt).toContain("Checks: 3 checks: 1 passed, 1 failed, 1 pending");
    expect(prompt).toContain("Check counts: 1 passed, 1 failed, 1 pending");
    expect(prompt).toContain("Review feedback: 1 review, 1 comment, 1 line thread, 1 unresolved thread, 1 changes requested");
    expect(prompt).toContain("Latest review feedback");
    expect(prompt).toContain("review CHANGES_REQUESTED by reviewer-two");
    expect(prompt).toContain("Please fix the failing lint path.");
    expect(prompt).toContain("comment by reviewer-one");
    expect(prompt).toContain("Can you add a note about the fallback?");
    expect(prompt).toContain("thread UNRESOLVED by reviewer-three at src/fallback.ts:17");
    expect(prompt).toContain("The fallback still needs a regression test.");
    expect(prompt).toContain("Refreshed: 2026-06-27T00:06:00.000Z");
    expect(prompt).toContain("Verification passed: npm test succeeded.");
    expect(prompt).toContain("Use the last refreshed PR status as a starting point");
    expect(prompt).toContain("requested changes, failed checks, informational comments, or no actionable review");
    expect(prompt).toContain("npm test");
  });

  it("builds a pull request review prompt that calls out missing refreshed PR status", () => {
    const taskRun: AgentTaskRun = {
      id: "run-pr-no-review",
      userMessageIndex: 0,
      promptPreview: "implement the feature",
      status: "completed",
      worktree: {
        enabled: true,
        status: "ready",
        path: "/worktree",
        branch: "arivu/task-pr",
        pullRequest: {
          title: "Implement the feature",
          body: "Summary",
          branch: "arivu/task-pr",
          baseBranch: "main",
          commit: "abc1234",
          preparedAt: "2026-06-27T00:00:00.000Z",
          createdAt: "2026-06-27T00:05:00.000Z",
          url: "https://github.com/example/repo/pull/42"
        }
      },
      capabilities: [],
      tools: [],
      approvals: [],
      artifacts: [],
      startedAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:05:00.000Z"
    };

    const prompt = buildTaskRunPullRequestReviewPrompt(taskRun);

    expect(prompt).toContain("Last refreshed PR status");
    expect(prompt).toContain("No Refresh PR snapshot is stored yet");
    expect(prompt).toContain("Refresh or inspect the live PR before deciding whether feedback exists.");
  });

  it("does not build a pull request review prompt before a PR URL exists", () => {
    const taskRun: AgentTaskRun = {
      id: "run-pr-draft",
      userMessageIndex: 0,
      promptPreview: "implement the feature",
      status: "completed",
      worktree: {
        enabled: true,
        status: "ready",
        path: "/worktree",
        branch: "arivu/task-pr",
        pullRequest: {
          title: "Implement the feature",
          body: "Summary",
          branch: "arivu/task-pr",
          baseBranch: "main",
          commit: "abc1234",
          preparedAt: "2026-06-27T00:00:00.000Z"
        }
      },
      capabilities: [],
      tools: [],
      approvals: [],
      artifacts: [],
      startedAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:05:00.000Z"
    };

    expect(buildTaskRunPullRequestReviewPrompt(taskRun)).toBeUndefined();
    expect(
      buildTaskRunPullRequestReviewPrompt({
        ...taskRun,
        id: "run-pr-merged",
        worktree: {
          ...taskRun.worktree!,
          status: "merged",
          pullRequest: {
            ...taskRun.worktree!.pullRequest!,
            url: "https://github.com/example/repo/pull/42"
          }
        }
      })
    ).toBeUndefined();
  });

  it("builds a review prompt for repeated failed replay outcomes", () => {
    const evidenceRun: AgentTaskRun = {
      id: "run-evidence",
      userMessageIndex: 0,
      promptPreview: "fix the failing test",
      status: "completed",
      worktree: {
        enabled: true,
        status: "ready",
        path: "/worktree",
        branch: "arivu/task-repair"
      },
      verification: {
        status: "failed",
        summary: "Verification failed: npm test exited 1.",
        commandCount: 1,
        failedCommandCount: 1,
        parsedReportCount: 0,
        failedReportCount: 0,
        passedReportCount: 0,
        unknownReportCount: 0,
        updatedAt: "2026-06-27T00:00:00.000Z"
      },
      capabilities: ["run_command"],
      tools: [],
      approvals: [],
      artifacts: [
        {
          id: "artifact-command",
          kind: "command_output",
          title: "Command output",
          command: "npm test",
          workingDirectory: "/worktree",
          exitCode: 1,
          stderr: "expected true to be false",
          createdAt: "2026-06-27T00:00:00.000Z"
        }
      ],
      startedAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:01:00.000Z"
    };
    const replayRun = (id: string, updatedAt: string): AgentTaskRun => ({
      ...evidenceRun,
      id,
      promptPreview: "replay npm test",
      worktree: {
        enabled: true,
        status: "ready",
        path: "/worktree",
        branch: "arivu/task-repair",
        replayOfTaskRunId: "run-evidence"
      },
      verification: {
        ...evidenceRun.verification!,
        summary: `${id} failed: npm test exited 1.`
      },
      updatedAt
    });
    const currentRun: AgentTaskRun = {
      ...evidenceRun,
      id: "run-current",
      userMessageIndex: 3,
      promptPreview: "review replay failures",
      worktree: {
        enabled: true,
        status: "ready",
        originalRoot: "/repo",
        path: "/worktree",
        branch: "arivu/task-repair",
        continuedFromTaskRunId: "run-replay-2"
      },
      verification: {
        status: "unknown",
        summary: "Verification unknown: no commands captured.",
        commandCount: 0,
        failedCommandCount: 0,
        parsedReportCount: 0,
        failedReportCount: 0,
        passedReportCount: 0,
        unknownReportCount: 0,
        updatedAt: "2026-06-27T00:05:00.000Z"
      },
      artifacts: [],
      updatedAt: "2026-06-27T00:05:00.000Z"
    };

    const prompt = buildTaskRunReplayFailureReviewPrompt(evidenceRun, [
      replayRun("run-replay-1", "2026-06-27T00:02:00.000Z"),
      replayRun("run-replay-2", "2026-06-27T00:03:00.000Z")
    ], currentRun);

    expect(prompt).toContain("review repeated replay verification failures");
    expect(prompt).toContain("Current run: run-current");
    expect(prompt).toContain("Evidence run: run-evidence");
    expect(prompt).toContain("run-replay-1 failed");
    expect(prompt).toContain("run-replay-2 failed");
    expect(prompt).toContain("Failure pattern summary:");
    expect(prompt).toContain("Failed replay attempts: 2");
    expect(prompt).toContain("Latest failed replay: run-replay-2");
    expect(prompt).toContain("Repeated failing command(s): npm test");
    expect(prompt).toContain("Best first command to reproduce: npm test");
    expect(prompt).toContain("Minimal verification plan:");
    expect(prompt).toContain("Reproduce once with the smallest relevant command: npm test");
    expect(prompt).toContain("Run broader checks only after the focused command passes");
    expect(prompt).toContain("real remaining defect, a stale verification command, an environment issue, or a missing precondition");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("expected true to be false");
  });

  it("does not build a replay failure review prompt without repeated failures", () => {
    const evidenceRun: AgentTaskRun = {
      id: "run-evidence",
      userMessageIndex: 0,
      promptPreview: "fix tests",
      status: "completed",
      worktree: {
        enabled: true,
        status: "ready",
        path: "/worktree",
        branch: "arivu/task-repair"
      },
      capabilities: [],
      tools: [],
      approvals: [],
      artifacts: [
        {
          id: "artifact-command",
          kind: "command_output",
          title: "Command output",
          command: "npm test",
          createdAt: "2026-06-27T00:00:00.000Z"
        }
      ],
      startedAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:01:00.000Z"
    };
    const replayRun: AgentTaskRun = {
      ...evidenceRun,
      id: "run-replay-1",
      worktree: {
        enabled: true,
        status: "ready",
        path: "/worktree",
        branch: "arivu/task-repair",
        replayOfTaskRunId: "run-evidence"
      },
      verification: {
        status: "failed",
        summary: "Verification failed.",
        commandCount: 1,
        failedCommandCount: 1,
        parsedReportCount: 0,
        failedReportCount: 0,
        passedReportCount: 0,
        unknownReportCount: 0,
        updatedAt: "2026-06-27T00:02:00.000Z"
      }
    };

    expect(buildTaskRunReplayFailureReviewPrompt(evidenceRun, [replayRun], evidenceRun)).toBeUndefined();
    expect(
      buildTaskRunReplayFailureReviewPrompt(evidenceRun, [replayRun, { ...replayRun, id: "run-replay-2" }], {
        ...evidenceRun,
        id: "run-merged",
        worktree: {
          enabled: true,
          status: "merged",
          path: "/worktree",
          branch: "arivu/task-repair"
        }
      })
    ).toBeUndefined();
  });
});

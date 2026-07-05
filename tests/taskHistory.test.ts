import { describe, expect, it } from "vitest";
import {
  buildTaskRunDiffComparison,
  buildTaskRunPlanSourceReview,
  buildTaskRunPullRequestReadiness,
  buildTaskRunReplayOutcomeGroups
} from "../src/agent/taskHistory.js";
import type { AgentTaskRun } from "../src/agent/types.js";

describe("task history helpers", () => {
  it("compares changed paths across task worktree attempts", () => {
    const left = taskRun({
      id: "run-left",
      worktree: {
        enabled: true,
        status: "ready",
        diff: {
          hasChanges: true,
          files: 2,
          insertions: 10,
          deletions: 2,
          changedPaths: ["src/old.ts", "src/shared.ts"],
          updatedAt: "2026-06-27T00:01:00.000Z"
        }
      }
    });
    const right = taskRun({
      id: "run-right",
      worktree: {
        enabled: true,
        status: "ready",
        patchPreview: {
          text: [
            "diff --git a/src/shared.ts b/src/shared.ts",
            "--- a/src/shared.ts",
            "+++ b/src/shared.ts",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "diff --git a/src/new.ts b/src/new.ts",
            "--- /dev/null",
            "+++ b/src/new.ts",
            "@@ -0,0 +1 @@",
            "+new"
          ].join("\n"),
          bytes: 180,
          lineCount: 11,
          truncated: false,
          updatedAt: "2026-06-27T00:02:00.000Z"
        }
      },
      artifacts: [
        {
          id: "file-change",
          kind: "file_change",
          title: "Wrote docs",
          path: "docs/note.md",
          writeMode: "create",
          createdAt: "2026-06-27T00:02:00.000Z"
        },
        {
          id: "file-change-a-dir",
          kind: "file_change",
          title: "Wrote nested file",
          path: "a/actual.md",
          writeMode: "create",
          createdAt: "2026-06-27T00:02:00.000Z"
        }
      ]
    });

    const comparison = buildTaskRunDiffComparison(left, right);

    expect(comparison.added).toEqual(["a/actual.md", "docs/note.md", "src/new.ts"]);
    expect(comparison.removed).toEqual(["src/old.ts"]);
    expect(comparison.shared).toEqual(["src/shared.ts"]);
    expect(comparison.right.patchPreviewBytes).toBe(180);
    expect(comparison.pathDeltas).toContainEqual({
      path: "src/shared.ts",
      state: "shared",
      leftSources: ["worktree diff"],
      rightSources: ["patch preview"]
    });
  });

  it("groups replay outcomes by evidence task run", () => {
    const original = taskRun({
      id: "run-original",
      promptPreview: "fix failing test",
      verification: verification("failed"),
      updatedAt: "2026-06-27T00:01:00.000Z"
    });
    const firstReplay = taskRun({
      id: "run-replay-1",
      promptPreview: "replay npm test",
      worktree: {
        enabled: true,
        status: "ready",
        replayOfTaskRunId: "run-original"
      },
      verification: verification("failed"),
      updatedAt: "2026-06-27T00:03:00.000Z"
    });
    const secondReplay = taskRun({
      id: "run-replay-2",
      promptPreview: "replay npm test again",
      worktree: {
        enabled: true,
        status: "ready",
        replayOfTaskRunId: "run-original"
      },
      verification: verification("passed"),
      updatedAt: "2026-06-27T00:05:00.000Z"
    });

    const groups = buildTaskRunReplayOutcomeGroups([secondReplay, original, firstReplay]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      evidenceRunId: "run-original",
      evidencePromptPreview: "fix failing test",
      evidenceVerificationStatus: "failed",
      failedOutcomeCount: 1,
      passedOutcomeCount: 1,
      unknownOutcomeCount: 0,
      latestOutcome: {
        runId: "run-replay-2",
        verificationStatus: "passed"
      }
    });
    expect(groups[0].outcomes.map((outcome) => outcome.runId)).toEqual(["run-replay-1", "run-replay-2"]);
  });

  it("summarizes approved plan source evidence for plan-derived worktrees", () => {
    const source = taskRun({
      id: "run-plan",
      promptPreview: "plan the UI repair",
      planMode: { enabled: true },
      planReview: {
        status: "approved",
        updatedAt: "2026-06-27T00:01:00.000Z"
      },
      plan: {
        summary: "Repair the composer flow",
        items: [
          { text: "Inspect current composer", status: "completed" },
          { text: "Patch worktree handoff", status: "pending" }
        ],
        updatedAt: "2026-06-27T00:00:30.000Z"
      }
    });
    const worktreeRun = taskRun({
      id: "run-worktree",
      worktree: {
        enabled: true,
        status: "ready",
        plannedFromTaskRunId: "run-plan",
        diff: {
          hasChanges: true,
          files: 1,
          changedPaths: ["desktop/renderer/src/App.tsx"],
          updatedAt: "2026-06-27T00:03:00.000Z"
        },
        patchPreview: {
          text: "diff --git a/desktop/renderer/src/App.tsx b/desktop/renderer/src/App.tsx\n",
          bytes: 72,
          lineCount: 1,
          truncated: false,
          updatedAt: "2026-06-27T00:03:30.000Z"
        }
      },
      verification: verification("failed")
    });

    const review = buildTaskRunPlanSourceReview(worktreeRun, source);

    expect(review).toMatchObject({
      sourceRunId: "run-plan",
      sourceFound: true,
      reviewStatus: "approved",
      planSummary: "Repair the composer flow",
      planStepCount: 2,
      completedPlanStepCount: 1,
      changedPathCount: 1,
      changedPaths: ["desktop/renderer/src/App.tsx"],
      patchPreviewReady: true,
      verificationStatus: "failed",
      completionStatus: "blocked"
    });
    expect(review?.planItems.map((item) => item.text)).toEqual(["Inspect current composer", "Patch worktree handoff"]);
    expect(review?.completionSummary).toContain("blocked by failed verification");
    expect(review?.completionNotes).toEqual([
      {
        text: "Inspect current composer",
        planStatus: "completed",
        status: "blocked",
        matchedPaths: [],
        matchedCommands: [],
        matchedReports: [],
        matchedChecks: [],
        matchedDiagnostics: [],
        matchedCompletionNotes: [],
        matchedCompletionEvidence: [],
        evidence: ["Verification failed: Verification failed.", "1 changed file recorded", "Patch preview ready"]
      },
      {
        text: "Patch worktree handoff",
        planStatus: "pending",
        status: "blocked",
        matchedPaths: [],
        matchedCommands: [],
        matchedReports: [],
        matchedChecks: [],
        matchedDiagnostics: [],
        matchedCompletionNotes: [],
        matchedCompletionEvidence: [],
        evidence: ["Verification failed: Verification failed.", "1 changed file recorded", "Patch preview ready"]
      }
    ]);
    expect(review?.cues.map((cue) => cue.status)).toEqual(["passed", "passed", "passed", "failed"]);
  });

  it("marks approved plan completion notes as supported after passed verified worktree evidence", () => {
    const source = taskRun({
      id: "run-plan",
      planMode: { enabled: true },
      planReview: {
        status: "approved",
        updatedAt: "2026-06-27T00:01:00.000Z"
      },
      plan: {
        summary: "Add the browser tab shell",
        items: [
          { text: "Add tab state", status: "pending" },
          { text: "Render tab controls", status: "pending" }
        ],
        updatedAt: "2026-06-27T00:00:30.000Z"
      }
    });
    const worktreeRun = taskRun({
      id: "run-worktree",
      worktree: {
        enabled: true,
        status: "ready",
        plannedFromTaskRunId: "run-plan",
        diff: {
          hasChanges: true,
          files: 2,
          changedPaths: ["desktop/main/browserTabs.ts", "desktop/renderer/src/BrowserTabControls.tsx"],
          updatedAt: "2026-06-27T00:03:00.000Z"
        },
        patchPreview: {
          text: "diff --git a/desktop/main/browserTabs.ts b/desktop/main/browserTabs.ts\n",
          bytes: 80,
          lineCount: 1,
          truncated: false,
          updatedAt: "2026-06-27T00:03:30.000Z"
        }
      },
      verification: verification("passed")
    });

    const review = buildTaskRunPlanSourceReview(worktreeRun, source);

    expect(review).toMatchObject({
      completionStatus: "supported",
      completionSummary: "All planned steps have item-specific evidence, verification passed, and a patch preview is ready."
    });
    expect(review?.completionNotes.map((note) => note.status)).toEqual(["supported", "supported"]);
    expect(review?.completionNotes[0].matchedPaths).toEqual(["desktop/main/browserTabs.ts", "desktop/renderer/src/BrowserTabControls.tsx"]);
    expect(review?.completionNotes[0].matchedCompletionNotes).toEqual([]);
    expect(review?.completionNotes[0].evidence).toEqual([
      "Verification passed",
      "2 changed files recorded",
      "Patch preview ready",
      "Matched files: desktop/main/browserTabs.ts, desktop/renderer/src/BrowserTabControls.tsx"
    ]);
  });

  it("keeps unmatched plan steps needing evidence even when run-level verification passed", () => {
    const source = taskRun({
      id: "run-plan",
      planMode: { enabled: true },
      planReview: {
        status: "approved",
        updatedAt: "2026-06-27T00:01:00.000Z"
      },
      plan: {
        items: [
          { text: "Update task history evidence", status: "pending" },
          { text: "Document release packaging", status: "pending" }
        ],
        updatedAt: "2026-06-27T00:00:30.000Z"
      }
    });
    const worktreeRun = taskRun({
      id: "run-worktree",
      worktree: {
        enabled: true,
        status: "ready",
        plannedFromTaskRunId: "run-plan",
        diff: {
          hasChanges: true,
          files: 1,
          changedPaths: ["src/agent/taskHistory.ts"],
          updatedAt: "2026-06-27T00:03:00.000Z"
        },
        patchPreview: {
          text: "diff --git a/src/agent/taskHistory.ts b/src/agent/taskHistory.ts\n",
          bytes: 68,
          lineCount: 1,
          truncated: false,
          updatedAt: "2026-06-27T00:03:30.000Z"
        }
      },
      artifacts: [
        {
          id: "command",
          kind: "command_output",
          title: "Command output",
          command: "npm test -- tests/taskHistory.test.ts",
          exitCode: 0,
          createdAt: "2026-06-27T00:04:00.000Z"
        }
      ],
      verification: verification("passed")
    });

    const review = buildTaskRunPlanSourceReview(worktreeRun, source);

    expect(review?.completionStatus).toBe("needs_evidence");
    expect(review?.completionSummary).toBe(
      "1/2 planned steps have item-specific evidence. Remaining steps need matching file, command, report, check, diagnostic, or completion-note evidence before close-out."
    );
    expect(review?.completionNotes.map((note) => note.status)).toEqual(["supported", "needs_evidence"]);
    expect(review?.completionNotes[0].matchedPaths).toEqual(["src/agent/taskHistory.ts"]);
    expect(review?.completionNotes[0].matchedCommands).toEqual(["npm test -- tests/taskHistory.test.ts"]);
    expect(review?.completionNotes[1].evidence).toContain("No item-specific file, command, report, check, diagnostic, or completion note match yet");
  });

  it("uses parsed reports and PR checks as item-specific plan evidence", () => {
    const source = taskRun({
      id: "run-plan",
      planMode: { enabled: true },
      planReview: {
        status: "approved",
        updatedAt: "2026-06-27T00:01:00.000Z"
      },
      plan: {
        items: [
          { text: "Repair checkout flow test", status: "pending" },
          { text: "Satisfy lint check", status: "pending" }
        ],
        updatedAt: "2026-06-27T00:00:30.000Z"
      }
    });
    const worktreeRun = taskRun({
      id: "run-worktree",
      worktree: {
        enabled: true,
        status: "ready",
        plannedFromTaskRunId: "run-plan",
        diff: {
          hasChanges: true,
          files: 1,
          changedPaths: ["src/checkout.ts"],
          updatedAt: "2026-06-27T00:03:00.000Z"
        },
        patchPreview: {
          text: "diff --git a/src/checkout.ts b/src/checkout.ts\n",
          bytes: 68,
          lineCount: 1,
          truncated: false,
          updatedAt: "2026-06-27T00:03:30.000Z"
        },
        pullRequest: {
          title: "Fix checkout",
          body: "Fix checkout",
          branch: "arivu/task-checkout",
          commit: "abc123",
          preparedAt: "2026-06-27T00:04:00.000Z",
          review: {
            checkSummary: "2 checks: 2 passed",
            checks: {
              total: 2,
              passed: 2,
              failed: 0,
              pending: 0,
              skipped: 0,
              cancelled: 0,
              unknown: 0
            },
            checkItems: [{ name: "lint", bucket: "passed", status: "COMPLETED", conclusion: "SUCCESS" }],
            summary: "checks passed",
            updatedAt: "2026-06-27T00:05:00.000Z"
          }
        }
      },
      artifacts: [
        {
          id: "command",
          kind: "command_output",
          title: "Command output",
          command: "npm run verify -- --reporter=junit",
          exitCode: 0,
          testReports: [
            {
              kind: "junit",
              path: "reports/junit.xml",
              summary: "1 failed test before repair: CheckoutFlowTest",
              status: "passed",
              failedTests: [
                {
                  name: "CheckoutFlowTest handles empty carts",
                  classname: "CheckoutFlowTest",
                  file: "src/checkout.test.ts"
                }
              ]
            }
          ],
          createdAt: "2026-06-27T00:04:00.000Z"
        }
      ],
      verification: verification("passed")
    });

    const review = buildTaskRunPlanSourceReview(worktreeRun, source);

    expect(review?.completionStatus).toBe("supported");
    expect(review?.completionNotes.map((note) => note.status)).toEqual(["supported", "supported"]);
    expect(review?.completionNotes[0].matchedReports).toEqual(["reports/junit.xml: 1 failed test before repair: CheckoutFlowTest"]);
    expect(review?.completionNotes[0].matchedCommands).toEqual([]);
    expect(review?.completionNotes[0].evidence).toContain("Matched report: reports/junit.xml: 1 failed test before repair: CheckoutFlowTest");
    expect(review?.completionNotes[1].matchedChecks).toEqual(["lint: passed"]);
    expect(review?.completionNotes[1].evidence).toContain("Matched PR check: lint: passed");
  });

  it("uses command diagnostics as item-specific plan evidence", () => {
    const source = taskRun({
      id: "run-plan",
      planMode: { enabled: true },
      planReview: {
        status: "approved",
        updatedAt: "2026-06-27T00:01:00.000Z"
      },
      plan: {
        items: [
          { text: "Repair taskRuns type diagnostic TS2322", status: "pending" },
          { text: "Fix app console lint no-console", status: "pending" }
        ],
        updatedAt: "2026-06-27T00:00:30.000Z"
      }
    });
    const worktreeRun = taskRun({
      id: "run-worktree",
      worktree: {
        enabled: true,
        status: "ready",
        plannedFromTaskRunId: "run-plan",
        diff: {
          hasChanges: true,
          files: 1,
          changedPaths: ["src/agent/runner.ts"],
          updatedAt: "2026-06-27T00:03:00.000Z"
        },
        patchPreview: {
          text: "diff --git a/src/agent/runner.ts b/src/agent/runner.ts\n",
          bytes: 68,
          lineCount: 1,
          truncated: false,
          updatedAt: "2026-06-27T00:03:30.000Z"
        }
      },
      artifacts: [
        {
          id: "command",
          kind: "command_output",
          title: "Command output",
          command: "npm run typecheck",
          exitCode: 0,
          diagnostics: [
            {
              source: "typescript",
              severity: "error",
              path: "src/agent/taskRuns.ts",
              line: 42,
              column: 9,
              code: "TS2322",
              message: "Type 'string' is not assignable to type 'AgentTaskRunDiagnostic'."
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
          createdAt: "2026-06-27T00:04:00.000Z"
        }
      ],
      verification: verification("passed")
    });

    const review = buildTaskRunPlanSourceReview(worktreeRun, source);

    expect(review?.completionStatus).toBe("supported");
    expect(review?.completionNotes[0].matchedPaths).toEqual([]);
    expect(review?.completionNotes[0].matchedDiagnostics).toEqual([
      "src/agent/taskRuns.ts:42:9: TS2322 Type 'string' is not assignable to type 'AgentTaskRu..."
    ]);
    expect(review?.completionNotes[0].evidence).toContain(
      "Matched diagnostic: src/agent/taskRuns.ts:42:9: TS2322 Type 'string' is not assignable to type 'AgentTaskRu..."
    );
    expect(review?.completionNotes[1].matchedPaths).toEqual([]);
    expect(review?.completionNotes[1].matchedDiagnostics).toEqual(["src/app.ts:7:3: no-console Unexpected console statement"]);
    expect(review?.completionNotes[1].evidence).toContain("Matched diagnostic: src/app.ts:7:3: no-console Unexpected console statement");
  });

  it("uses assistant-authored completion notes as item-specific plan evidence", () => {
    const source = taskRun({
      id: "run-plan",
      planMode: { enabled: true },
      planReview: {
        status: "approved",
        updatedAt: "2026-06-27T00:01:00.000Z"
      },
      plan: {
        items: [
          { text: "Update task history evidence", status: "pending" },
          { text: "Document packaging behavior", status: "pending" }
        ],
        updatedAt: "2026-06-27T00:00:30.000Z"
      }
    });
    const worktreeRun = taskRun({
      id: "run-worktree",
      completion: {
        summary: "close-out",
        items: [
          {
            text: "Update task history evidence matching",
            status: "completed",
            evidence: [
              { kind: "file", value: "src/agent/taskHistory.ts" },
              { kind: "command", value: "npm test -- tests/taskHistory.test.ts" }
            ]
          },
          {
            text: "Document packaging behavior after release scripts exist",
            status: "needs_followup",
            evidence: [{ kind: "note", value: "release scripts are not implemented yet" }]
          }
        ],
        updatedAt: "2026-06-27T00:04:00.000Z"
      },
      worktree: {
        enabled: true,
        status: "ready",
        plannedFromTaskRunId: "run-plan",
        diff: {
          hasChanges: true,
          files: 1,
          changedPaths: ["src/agent/taskHistory.ts"],
          updatedAt: "2026-06-27T00:03:00.000Z"
        },
        patchPreview: {
          text: "diff --git a/src/agent/taskHistory.ts b/src/agent/taskHistory.ts\n",
          bytes: 68,
          lineCount: 1,
          truncated: false,
          updatedAt: "2026-06-27T00:03:30.000Z"
        }
      },
      verification: verification("passed")
    });

    const review = buildTaskRunPlanSourceReview(worktreeRun, source);

    expect(review?.completionStatus).toBe("needs_evidence");
    expect(review?.completionNotes.map((note) => note.status)).toEqual(["supported", "needs_evidence"]);
    expect(review?.completionNotes[0].matchedCompletionNotes).toEqual(["Update task history evidence matching"]);
    expect(review?.completionNotes[0].matchedCompletionEvidence).toEqual([
      "file src/agent/taskHistory.ts",
      "command npm test -- tests/taskHistory.test.ts"
    ]);
    expect(review?.completionNotes[0].evidence).toContain(
      "Assistant evidence labels: file src/agent/taskHistory.ts, command npm test -- tests/taskHistory.test.ts"
    );
    expect(review?.completionNotes[1].matchedCompletionNotes).toEqual(["Document packaging behavior after release scripts exist"]);
    expect(review?.completionNotes[1].matchedCompletionEvidence).toEqual(["note release scripts are not implemented yet"]);
    expect(review?.completionNotes[1].evidence).toContain(
      "Assistant completion note: Document packaging behavior after release scripts exist"
    );
  });

  it("derives pull request readiness from refreshed review and check snapshots", () => {
    expect(
      buildTaskRunPullRequestReadiness({
        state: "OPEN",
        isDraft: false,
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        checkSummary: "2 checks: 2 passed",
        checks: {
          total: 2,
          passed: 2,
          failed: 0,
          pending: 0,
          skipped: 0,
          cancelled: 0,
          unknown: 0
        },
        summary: "open - review approved - merge clean - 2 checks: 2 passed",
        updatedAt: "2026-07-01T00:00:00.000Z"
      })
    ).toEqual({
      status: "ready",
      label: "Ready to merge",
      summary: "Approved, mergeable, and checks are settled.",
      reasons: ["2 checks: 2 passed"]
    });

    expect(
      buildTaskRunPullRequestReadiness({
        state: "OPEN",
        isDraft: false,
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
        summary: "open - review changes requested - merge blocked - 3 checks: 1 passed, 1 failed, 1 pending",
        updatedAt: "2026-07-01T00:00:00.000Z"
      })
    ).toMatchObject({
      status: "blocked",
      label: "Blocked",
      summary: "Review changes are requested."
    });

    expect(buildTaskRunPullRequestReadiness(undefined)).toEqual({
      status: "unknown",
      label: "Refresh needed",
      summary: "Refresh PR to derive review, merge, and check readiness.",
      reasons: ["No refreshed PR snapshot is stored yet."]
    });
  });
});

function taskRun(overrides: Partial<AgentTaskRun>): AgentTaskRun {
  return {
    id: "run",
    userMessageIndex: 0,
    promptPreview: "prompt",
    status: "completed",
    capabilities: [],
    tools: [],
    approvals: [],
    artifacts: [],
    startedAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...overrides
  };
}

function verification(status: "passed" | "failed" | "unknown") {
  return {
    status,
    summary: `Verification ${status}.`,
    commandCount: 1,
    failedCommandCount: status === "failed" ? 1 : 0,
    parsedReportCount: 0,
    failedReportCount: 0,
    passedReportCount: 0,
    unknownReportCount: 0,
    updatedAt: "2026-06-27T00:00:00.000Z"
  };
}

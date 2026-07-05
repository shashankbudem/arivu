import { describe, expect, it } from "vitest";
import { buildTaskRunAuditMarkdown } from "../src/agent/taskRunAudit.js";
import { createAgentTaskRun, finishTaskRun, recordTaskRunApproval, recordTaskRunEvent } from "../src/agent/taskRuns.js";

describe("task run audit summaries", () => {
  it("formats run metadata, tools, approvals, artifacts, and verification", () => {
    const run = createAgentTaskRun({
      userMessageIndex: 4,
      prompt: "run tests and explain the failure",
      model: "test-model",
      providerName: "Test Provider",
      modelSelectionReason: "manual",
      now: "2026-01-01T00:00:00.000Z"
    });

    recordTaskRunApproval(
      run,
      {
        id: "approval-1",
        actionType: "shell",
        capability: "run_command",
        status: "approved",
        trustMode: "ask",
        effect: "prompt",
        label: "Requires approval",
        reason: "shell commands require approval",
        risky: false,
        scope: {
          kind: "command",
          label: "Command",
          value: "npm test"
        },
        summary: "npm test",
        message: "Shell command: npm test"
      },
      "2026-01-01T00:00:01.000Z"
    );
    recordTaskRunEvent(
      run,
      {
        type: "tool_call",
        call: {
          id: "call_1",
          name: "run",
          arguments: { command: "npm test" }
        }
      },
      "2026-01-01T00:00:02.000Z"
    );
    recordTaskRunEvent(
      run,
      {
        type: "tool_result",
        toolCallId: "call_1",
        name: "run",
        result:
          "executionProfile: host\nexecutionIsolation: local host process\nworkingDirectory: /workspace\nexitCode: 1\nstdout:\nsrc/app.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'."
      },
      "2026-01-01T00:00:04.000Z"
    );
    finishTaskRun(run, "completed", undefined, "2026-01-01T00:00:05.000Z");
    run.completion = {
      summary: "closed out",
      items: [
        {
          text: "Run tests and explain the failure",
          status: "completed",
          evidence: [
            { kind: "command", value: "npm test" },
            { kind: "report", value: "reports/junit.xml" }
          ]
        }
      ],
      updatedAt: "2026-01-01T00:00:05.000Z"
    };

    const audit = buildTaskRunAuditMarkdown(run);

    expect(audit).toContain("# Arivu task run audit");
    expect(audit).toContain("- Prompt: run tests and explain the failure");
    expect(audit).toContain("- Model: Test Provider / test-model");
    expect(audit).toContain("- Run command");
    expect(audit).toContain("1. `run` - Run command - Done - 2.0s");
    expect(audit).toContain("- Arguments: `{\"command\":\"npm test\"}`");
    expect(audit).toContain("- Policy: Approved - prompt - ask - scope Command npm test: shell commands require approval");
    expect(audit).toContain("- Approved - Run command - shell - ask - prompt - scope Command npm test: npm test");
    expect(audit).toContain("- Status: Failed");
    expect(audit).toContain("- command_output: Command output - Exit code 1 - 2.0s - 1 diagnostic - exit 1 - 2.0s - 1 diagnostic");
    expect(audit).toContain("- completed: Run tests and explain the failure [evidence: command=npm test; report=reports/junit.xml]");
  });

  it("includes worktree and pull request state when present", () => {
    const run = createAgentTaskRun({
      userMessageIndex: 1,
      prompt: "ship the change",
      worktreeEnabled: true,
      now: "2026-01-01T00:00:00.000Z"
    });
    run.worktree = {
      enabled: true,
      status: "ready",
      path: "/tmp/arivu-task",
      branch: "arivu/task-123",
      baseRef: "abc123",
      diff: {
        hasChanges: true,
        files: 2,
        insertions: 10,
        deletions: 3,
        changedPaths: ["src/app.ts", "tests/app.test.ts"],
        updatedAt: "2026-01-01T00:01:00.000Z"
      },
      patchPreview: {
        text: "diff --git a/src/app.ts b/src/app.ts",
        bytes: 128,
        lineCount: 12,
        truncated: false,
        updatedAt: "2026-01-01T00:02:00.000Z"
      },
      pullRequest: {
        title: "Ship harness change",
        body: "Adds harness behavior.",
        branch: "arivu/task-123",
        baseBranch: "main",
        commit: "def456",
        preparedAt: "2026-01-01T00:03:00.000Z",
        url: "https://github.com/example/repo/pull/1",
        review: {
          checkSummary: "1 passed",
          checks: { total: 1, passed: 1, failed: 0, pending: 0, skipped: 0, cancelled: 0, unknown: 0 },
          checkItems: [
            {
              name: "lint",
              bucket: "failed",
              status: "COMPLETED",
              conclusion: "FAILURE",
              logSource: "github_actions",
              logCommand: "gh run view '123456' --repo 'example/repo' --job '7890' --log-failed",
              logArtifactId: "pr-check-log:lint:123456:7890:command_output"
            }
          ],
          notifications: [
            {
              level: "warning",
              summary: "Review decision changed",
              detail: "review required -> changes requested",
              createdAt: "2026-01-01T00:04:00.000Z"
            }
          ],
          summary: "Ready to merge",
          updatedAt: "2026-01-01T00:04:00.000Z"
        }
      }
    };

    const audit = buildTaskRunAuditMarkdown(run);

    expect(audit).toContain("## Worktree");
    expect(audit).toContain("- Branch: `arivu/task-123`");
    expect(audit).toContain("- Diff: 2 files, +10, -3");
    expect(audit).toContain("- Patch preview: 12 lines");
    expect(audit).toContain("- PR: https://github.com/example/repo/pull/1 (Ship harness change)");
    expect(audit).toContain("- PR review: Ready to merge");
    expect(audit).toContain("- PR updates: warning Review decision changed (review required -> changes requested)");
    expect(audit).toContain(
      "- PR check evidence: lint failed logs gh run view '123456' --repo 'example/repo' --job '7890' --log-failed artifact pr-check-log:lint:123456:7890:command_output"
    );
  });

  it("includes direct write approval preview summaries", () => {
    const run = createAgentTaskRun({
      userMessageIndex: 2,
      prompt: "edit config",
      now: "2026-01-01T00:00:00.000Z"
    });

    recordTaskRunApproval(
      run,
      {
        id: "approval-preview",
        actionType: "write",
        capability: "write_workspace",
        status: "approved",
        trustMode: "trusted",
        effect: "prompt",
        label: "Approval for risky",
        reason: "risky workspace writes require approval",
        risky: true,
        scope: {
          kind: "path",
          label: "Write paths",
          value: "src/app.ts"
        },
        summary: "patch file",
        changePreview: {
          kind: "patch",
          title: "Patch review preview",
          summary: "1 file, +1/-1",
          changedPaths: ["src/app.ts"],
          additions: 1,
          deletions: 1,
          diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n"
        }
      },
      "2026-01-01T00:00:01.000Z"
    );

    const audit = buildTaskRunAuditMarkdown(run);

    expect(run.approvals[0]?.changePreview?.changedPaths).toEqual(["src/app.ts"]);
    expect(audit).toContain("preview: Patch review preview - 1 file, +1/-1 - paths `src/app.ts`");
  });
});

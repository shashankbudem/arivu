import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAgentTaskRun,
  finishTaskRun,
  parseAgentTaskRunCompletion,
  parseAgentTaskRunPlan,
  recordTaskRunApproval,
  recordTaskRunAssistantCompletion,
  recordTaskRunAssistantPlan,
  recordTaskRunEvent,
  capabilityForToolName
} from "../src/agent/taskRuns.js";

describe("agent task runs", () => {
  it("classifies tool names into task-run capabilities", () => {
    expect(capabilityForToolName("read")).toBe("read_repo");
    expect(capabilityForToolName("write_file")).toBe("write_workspace");
    expect(capabilityForToolName("run")).toBe("run_command");
    expect(capabilityForToolName("web_search")).toBe("network_fetch");
    expect(capabilityForToolName("browser_click")).toBe("browser_control");
    expect(capabilityForToolName("mcp_call_tool")).toBe("mcp_call");
    expect(capabilityForToolName("read_skill")).toBe("skill_context");
    expect(capabilityForToolName("current_datetime")).toBe("local_context");
    expect(capabilityForToolName("future_tool")).toBe("unknown");
  });

  it("records tool capabilities and browser screenshot artifacts", () => {
    const run = createAgentTaskRun({
      userMessageIndex: 2,
      prompt: "inspect the page",
      model: "test-model",
      providerName: "Test Provider",
      now: "2026-01-01T00:00:00.000Z"
    });

    recordTaskRunEvent(
      run,
      {
        type: "tool_call",
        call: {
          id: "call_1",
          name: "browser_screenshot",
          arguments: { mode: "visible" }
        }
      },
      "2026-01-01T00:01:00.000Z"
    );
    recordTaskRunEvent(
      run,
      {
        type: "tool_result",
        toolCallId: "call_1",
        name: "browser_screenshot",
        result: JSON.stringify({
          action: "screenshot",
          title: "Arivu",
          screenshotPath: "/tmp/arivu.png",
          size: { width: 1200, height: 800 }
        })
      },
      "2026-01-01T00:02:00.000Z"
    );

    expect(run.status).toBe("running");
    expect(run.capabilities).toEqual(["browser_control"]);
    expect(run.tools).toMatchObject([
      {
        toolCallId: "call_1",
        name: "browser_screenshot",
        capability: "browser_control",
        status: "done",
        artifactIds: ["call_1:browser_screenshot:/tmp/arivu.png"]
      }
    ]);
    expect(run.artifacts).toMatchObject([
      {
        id: "call_1:browser_screenshot:/tmp/arivu.png",
        kind: "browser_screenshot",
        path: "/tmp/arivu.png",
        width: 1200,
        height: 800
      }
    ]);

    finishTaskRun(run, "completed", undefined, "2026-01-01T00:03:00.000Z");
    expect(run.status).toBe("completed");
    expect(run.completedAt).toBe("2026-01-01T00:03:00.000Z");
  });

  it("records approval decisions as durable run state", () => {
    const run = createAgentTaskRun({
      userMessageIndex: 1,
      prompt: "run tests",
      now: "2026-01-01T00:00:00.000Z"
    });

    recordTaskRunApproval(
      run,
      {
        id: "approval-1",
        actionType: "shell",
        capability: "run_command",
        status: "requested",
        trustMode: "ask",
        effect: "prompt",
        label: "Requires approval",
        reason: "shell commands require approval",
        risky: false,
        summary: "npm test",
        message: "Shell command: npm test"
      },
      "2026-01-01T00:00:01.000Z"
    );
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
        summary: "npm test",
        message: "Shell command: npm test"
      },
      "2026-01-01T00:00:05.000Z"
    );

    expect(run.status).toBe("running");
    expect(run.capabilities).toEqual(["run_command"]);
    expect(run.approvals).toEqual([
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
        summary: "npm test",
        message: "Shell command: npm test",
        createdAt: "2026-01-01T00:00:01.000Z",
        requestedAt: "2026-01-01T00:00:01.000Z",
        decidedAt: "2026-01-01T00:00:05.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z"
      }
    ]);
  });

  it("records plan approval mode separately from captured assistant plans", () => {
    const run = createAgentTaskRun({
      userMessageIndex: 1,
      prompt: "plan a risky refactor",
      planModeEnabled: true,
      now: "2026-01-01T00:00:00.000Z"
    });

    expect(run.planMode).toEqual({ enabled: true });
    expect(run.plan).toBeUndefined();
  });

  it("records applied patches as durable artifacts", () => {
    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,3 @@",
      " const name = 'Arivu';",
      "-console.log(name);",
      "+console.info(name);",
      "+console.info('ready');"
    ].join("\n");
    const run = createAgentTaskRun({
      userMessageIndex: 2,
      prompt: "patch app",
      now: "2026-01-01T00:00:00.000Z"
    });

    recordTaskRunEvent(
      run,
      {
        type: "tool_call",
        call: {
          id: "call_patch",
          name: "apply_patch",
          arguments: { diff }
        }
      },
      "2026-01-01T00:00:00.000Z"
    );
    recordTaskRunEvent(
      run,
      {
        type: "tool_result",
        toolCallId: "call_patch",
        name: "apply_patch",
        result: "Applied patch: src/app.ts (1 hunks)"
      },
      "2026-01-01T00:00:01.000Z"
    );

    expect(run.capabilities).toEqual(["write_workspace"]);
    expect(run.tools[0]).toMatchObject({
      toolCallId: "call_patch",
      artifactIds: ["call_patch:patch"]
    });
    expect(run.artifacts).toMatchObject([
      {
        id: "call_patch:patch",
        kind: "patch",
        title: "Patch applied",
        summary: "src/app.ts (1 hunks) (1 file +2 -1)",
        diff,
        changedPaths: ["src/app.ts"],
        additions: 2,
        deletions: 1
      }
    ]);
  });

  it("records direct file writes as durable change artifacts", () => {
    const run = createAgentTaskRun({
      userMessageIndex: 3,
      prompt: "write a file",
      now: "2026-01-01T00:00:00.000Z"
    });

    recordTaskRunEvent(
      run,
      {
        type: "tool_call",
        call: {
          id: "call_write",
          name: "write_file",
          arguments: {
            path: "notes/plan.md",
            mode: "create",
            content: "# Plan\n\nShip the harness.\n"
          }
        }
      },
      "2026-01-01T00:00:00.000Z"
    );
    recordTaskRunEvent(
      run,
      {
        type: "tool_result",
        toolCallId: "call_write",
        name: "write_file",
        result: "Created notes/plan.md"
      },
      "2026-01-01T00:00:01.000Z"
    );
    recordTaskRunEvent(
      run,
      {
        type: "tool_call",
        call: {
          id: "call_replace",
          name: "write_file",
          arguments: {
            path: "notes/plan.md",
            mode: "replace",
            content: "# Plan\n\nShip the harness safely.\n"
          }
        }
      },
      "2026-01-01T00:00:02.000Z"
    );
    recordTaskRunEvent(
      run,
      {
        type: "tool_result",
        toolCallId: "call_replace",
        name: "write_file",
        result: "Replaced notes/plan.md"
      },
      "2026-01-01T00:00:03.000Z"
    );

    expect(run.capabilities).toEqual(["write_workspace"]);
    expect(run.tools[0]).toMatchObject({
      toolCallId: "call_write",
      artifactIds: ["call_write:file_change:notes/plan.md"]
    });
    expect(run.tools[1]).toMatchObject({
      toolCallId: "call_replace",
      artifactIds: ["call_replace:file_change:notes/plan.md"]
    });
    expect(run.artifacts).toMatchObject([
      {
        id: "call_write:file_change:notes/plan.md",
        kind: "file_change",
        title: "File created",
        summary: "Created notes/plan.md (3 lines)",
        path: "notes/plan.md",
        writeMode: "create",
        content: "# Plan\n\nShip the harness.\n",
        lineCount: 3
      },
      {
        id: "call_replace:file_change:notes/plan.md",
        kind: "file_change",
        title: "File replaced",
        summary: "Replaced notes/plan.md (3 lines)",
        path: "notes/plan.md",
        writeMode: "replace",
        content: "# Plan\n\nShip the harness safely.\n",
        lineCount: 3
      }
    ]);
  });

  it("promotes command output and parsed test reports into a run artifact", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "arivu-task-run-"));
    await mkdir(path.join(workspace, "reports"));
    await writeFile(
      path.join(workspace, "reports", "junit.xml"),
      `<testsuites tests="3" failures="1" errors="0" skipped="1" time="1.25">
        <testsuite name="unit" tests="3" failures="1" errors="0" skipped="1" time="1.25">
          <testcase classname="math.add" name="adds positive numbers" file="src/math.test.ts" line="12">
            <failure message="expected 4 to equal 5" />
          </testcase>
          <testcase classname="math.add" name="adds negative numbers" />
          <testcase classname="math.add" name="skips zero" />
        </testsuite>
      </testsuites>`,
      "utf8"
    );
    const run = createAgentTaskRun({
      userMessageIndex: 0,
      prompt: "run tests",
      now: "2026-01-01T00:00:00.000Z"
    });

    recordTaskRunEvent(
      run,
      {
        type: "tool_call",
        call: {
          id: "call_2",
          name: "run",
          arguments: { command: "npm test -- --outputFile reports/junit.xml" }
        }
      },
      "2026-01-01T00:00:00.000Z"
    );
    recordTaskRunEvent(
      run,
      {
        type: "tool_result",
        toolCallId: "call_2",
        name: "run",
        result: `executionProfile: host
executionIsolation: local host process
workingDirectory: ${workspace}
exitCode: 1
stdout:
fail
wrote reports/junit.xml
stderr:
boom`
      },
      "2026-01-01T00:00:02.000Z",
      { workspaceRoot: workspace }
    );

    expect(run.capabilities).toEqual(["run_command"]);
    expect(run.tools[0]).toMatchObject({
      toolCallId: "call_2",
      status: "done",
      durationMs: 2000,
      artifactIds: ["call_2:command_output"]
    });
    expect(run.artifacts).toMatchObject([
      {
        id: "call_2:command_output",
        kind: "command_output",
        summary: "Exit code 1 - 2.0s - 1 parsed report",
        command: "npm test -- --outputFile reports/junit.xml",
        executionProfile: "host",
        executionIsolation: "local host process",
        workingDirectory: workspace,
        exitCode: 1,
        durationMs: 2000,
        stdout: "fail\nwrote reports/junit.xml",
        stderr: "boom",
        reportPaths: ["reports/junit.xml"],
        testReports: [
          {
            kind: "junit",
            path: "reports/junit.xml",
            status: "failed",
            summary: "3 tests, 1 failed, 1 skipped",
            tests: 3,
            failures: 1,
            errors: 0,
            skipped: 1,
            suites: 1,
            durationSeconds: 1.25,
            failedTests: [
              {
                name: "adds positive numbers",
                classname: "math.add",
                file: "src/math.test.ts",
                line: 12,
                message: "expected 4 to equal 5",
                type: "failure"
              }
            ]
          }
        ]
      }
    ]);
    finishTaskRun(run, "completed", undefined, "2026-01-01T00:00:03.000Z");
    expect(run.verification).toMatchObject({
      status: "failed",
      summary: "Verification failed: 1 command, 1 failed exit, 1 parsed report, 1 failed report.",
      commandCount: 1,
      failedCommandCount: 1,
      parsedReportCount: 1,
      failedReportCount: 1,
      passedReportCount: 0,
      unknownReportCount: 0,
      updatedAt: "2026-01-01T00:00:03.000Z"
    });
  });

  it("records passed command verification summaries when commands exit cleanly", () => {
    const run = createAgentTaskRun({
      userMessageIndex: 0,
      prompt: "build",
      now: "2026-01-01T00:00:00.000Z"
    });

    recordTaskRunEvent(
      run,
      {
        type: "tool_call",
        call: {
          id: "call_ok",
          name: "run",
          arguments: { command: "npm run build" }
        }
      },
      "2026-01-01T00:00:00.000Z"
    );
    recordTaskRunEvent(
      run,
      {
        type: "tool_result",
        toolCallId: "call_ok",
        name: "run",
        result: "executionProfile: host\nexecutionIsolation: local host process\nworkingDirectory: /workspace\nexitCode: 0\nstdout:\nok"
      },
      "2026-01-01T00:00:01.000Z"
    );

    finishTaskRun(run, "completed", undefined, "2026-01-01T00:00:02.000Z");

    expect(run.verification).toMatchObject({
      status: "passed",
      summary: "Verification passed: 1 command, no failed exits.",
      commandCount: 1,
      failedCommandCount: 0,
      parsedReportCount: 0
    });
  });

  it("parses SARIF report summaries from command artifacts", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "arivu-task-run-sarif-"));
    await mkdir(path.join(workspace, "reports"));
    await writeFile(
      path.join(workspace, "reports", "scan.sarif"),
      JSON.stringify({
        version: "2.1.0",
        runs: [
          {
            results: [
              {
                ruleId: "no-eval",
                level: "error",
                message: { text: "Avoid eval." },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "src/app.ts" },
                      region: { startLine: 9, startColumn: 13 }
                    }
                  }
                ]
              },
              {
                ruleId: "no-console",
                level: "warning",
                message: { text: "Unexpected console statement." },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "src/logger.ts" },
                      region: { startLine: 4 }
                    }
                  }
                ]
              },
              { ruleId: "docs", level: "note", message: { text: "Add docs." } }
            ]
          }
        ]
      }),
      "utf8"
    );
    const run = createAgentTaskRun({
      userMessageIndex: 0,
      prompt: "scan",
      now: "2026-01-01T00:00:00.000Z"
    });

    recordTaskRunEvent(
      run,
      {
        type: "tool_call",
        call: {
          id: "call_sarif",
          name: "run",
          arguments: { command: "npm run scan -- --sarif reports/scan.sarif" }
        }
      },
      "2026-01-01T00:00:00.000Z"
    );
    recordTaskRunEvent(
      run,
      {
        type: "tool_result",
        toolCallId: "call_sarif",
        name: "run",
        result: "exitCode: 0\nstdout:\nwrote reports/scan.sarif"
      },
      "2026-01-01T00:00:01.000Z",
      { workspaceRoot: workspace }
    );

    expect(run.artifacts[0]).toMatchObject({
      id: "call_sarif:command_output",
      summary: "Exit code 0 - 1.0s - 1 parsed report",
      reportPaths: ["reports/scan.sarif"],
      testReports: [
        {
          kind: "sarif",
          path: "reports/scan.sarif",
          status: "failed",
          summary: "3 findings, 1 errors, 1 warnings, 1 notes",
          findings: 3,
          errorFindings: 1,
          warningFindings: 1,
          noteFindings: 1,
          rules: 3,
          findingDetails: [
            {
              ruleId: "no-eval",
              level: "error",
              message: "Avoid eval.",
              path: "src/app.ts",
              line: 9,
              column: 13
            },
            {
              ruleId: "no-console",
              level: "warning",
              message: "Unexpected console statement.",
              path: "src/logger.ts",
              line: 4
            },
            {
              ruleId: "docs",
              level: "note",
              message: "Add docs."
            }
          ]
        }
      ]
    });
  });

  it("starts worktree-enabled runs with creating metadata", () => {
    const run = createAgentTaskRun({
      userMessageIndex: 0,
      prompt: "fix this safely",
      worktreeEnabled: true,
      now: "2026-01-01T00:00:00.000Z"
    });

    expect(run.worktree).toEqual({ enabled: true, status: "creating" });
  });

  it("records a bounded assistant plan on the task run", () => {
    const run = createAgentTaskRun({
      userMessageIndex: 0,
      prompt: "fix the build",
      now: "2026-01-01T00:00:00.000Z"
    });

    const changed = recordTaskRunAssistantPlan(
      run,
      [
        "Plan: make the smallest safe repair.",
        "- [x] Inspect the failing test output",
        "- [~] Patch the parser edge case",
        "- [ ] Run the focused regression test",
        "",
        "I will start with the failure evidence."
      ].join("\n"),
      "2026-01-01T00:01:00.000Z",
      3
    );

    expect(changed).toBe(true);
    expect(run.updatedAt).toBe("2026-01-01T00:01:00.000Z");
    expect(run.plan).toEqual({
      summary: "make the smallest safe repair.",
      updatedAt: "2026-01-01T00:01:00.000Z",
      sourceMessageIndex: 3,
      items: [
        { text: "Inspect the failing test output", status: "completed" },
        { text: "Patch the parser edge case", status: "in_progress" },
        { text: "Run the focused regression test", status: "pending" }
      ]
    });
  });

  it("does not parse unrelated bullet lists as task plans", () => {
    expect(parseAgentTaskRunPlan("What changed:\n- Updated docs\n- Ran tests")).toBeUndefined();
  });

  it("records bounded assistant completion notes on the task run", () => {
    const run = createAgentTaskRun({
      userMessageIndex: 0,
      prompt: "run the approved plan",
      now: "2026-01-01T00:00:00.000Z"
    });

    const changed = recordTaskRunAssistantCompletion(
      run,
      [
        "Completion notes: execution closed against the approved plan.",
        "- Completed: Update task history evidence matching",
        "- Needs evidence: Document packaging behavior",
        "- Blocked: Create release because signing is missing",
        "",
        "Verification passed."
      ].join("\n"),
      "2026-01-01T00:02:00.000Z",
      4
    );

    expect(changed).toBe(true);
    expect(run.updatedAt).toBe("2026-01-01T00:02:00.000Z");
    expect(run.completion).toEqual({
      summary: "execution closed against the approved plan.",
      updatedAt: "2026-01-01T00:02:00.000Z",
      sourceMessageIndex: 4,
      items: [
        { text: "Update task history evidence matching", status: "completed" },
        { text: "Document packaging behavior", status: "needs_followup" },
        { text: "Create release because signing is missing", status: "blocked" }
      ]
    });
  });

  it("does not parse ordinary summary bullets as completion notes", () => {
    expect(parseAgentTaskRunCompletion("What changed:\n- Updated docs\n- Ran tests")).toBeUndefined();
  });
});

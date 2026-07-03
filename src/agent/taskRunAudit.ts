import type {
  AgentTaskRun,
  AgentTaskRunApprovalStatus,
  AgentTaskRunArtifact,
  AgentTaskRunCapability,
  AgentTaskRunStatus,
  AgentTaskRunToolStatus,
  AgentTaskRunVerificationStatus,
  AgentTaskRunWorktreeStatus
} from "./types.js";

const MAX_INLINE_TEXT = 220;
const MAX_ARGUMENT_TEXT = 600;
const MAX_LIST_ITEMS = 12;

export function buildTaskRunAuditMarkdown(run: AgentTaskRun) {
  const lines = [
    "# Arivu task run audit",
    "",
    `- Run: \`${run.id}\``,
    `- Prompt: ${inlineText(run.promptPreview || "Untitled prompt")}`,
    `- Status: ${taskRunStatusLabel(run.status)}`,
    `- Started: ${run.startedAt}`,
    `- Updated: ${run.updatedAt}`
  ];

  if (run.completedAt) {
    lines.push(`- Completed: ${run.completedAt}`);
  }
  if (run.providerName || run.model) {
    lines.push(`- Model: ${inlineText([run.providerName, run.model].filter(Boolean).join(" / "))}`);
  }
  if (run.modelSelectionReason) {
    lines.push(`- Model selection: ${inlineText(run.modelSelectionReason)}`);
  }

  const modes = [
    run.planMode?.enabled ? "Plan approval" : undefined,
    run.loop?.enabled ? `Loop max ${run.loop.maxIterations}` : undefined,
    run.worktree?.enabled ? `Worktree ${worktreeStatusLabel(run.worktree.status)}` : undefined
  ].filter((mode): mode is string => Boolean(mode));
  if (modes.length > 0) {
    lines.push(`- Modes: ${modes.join(", ")}`);
  }
  if (run.error) {
    lines.push(`- Error: ${inlineText(run.error)}`);
  }

  lines.push("", "## Capabilities", ...bulletList(run.capabilities.map(capabilityLabel)));

  if (run.plan) {
    lines.push("", "## Captured Plan");
    if (run.plan.summary) {
      lines.push(`- Summary: ${inlineText(run.plan.summary)}`);
    }
    lines.push(
      ...bulletList(
        run.plan.items.map((item) => `${item.status ? `${item.status}: ` : ""}${inlineText(item.text)}`)
      )
    );
  }

  if (run.completion) {
    lines.push("", "## Completion Notes");
    if (run.completion.summary) {
      lines.push(`- Summary: ${inlineText(run.completion.summary)}`);
    }
    lines.push(
      ...bulletList(
        run.completion.items.map((item) => `${item.status ? `${item.status}: ` : ""}${inlineText(item.text)}`)
      )
    );
  }

  if (run.verification) {
    lines.push("", "## Verification");
    lines.push(`- Status: ${verificationStatusLabel(run.verification.status)}`);
    lines.push(`- Summary: ${inlineText(run.verification.summary)}`);
    lines.push(
      `- Commands: ${run.verification.commandCount} total, ${run.verification.failedCommandCount} failed exit`
    );
    lines.push(
      `- Reports: ${run.verification.parsedReportCount} parsed, ${run.verification.failedReportCount} failed, ${run.verification.passedReportCount} passed, ${run.verification.unknownReportCount} unknown`
    );
  }

  lines.push("", "## Tools", ...toolLines(run));
  lines.push("", "## Approvals", ...approvalLines(run));
  lines.push("", "## Artifacts", ...artifactLines(run));

  if (run.worktree?.enabled) {
    lines.push("", "## Worktree", ...worktreeLines(run));
  }

  return lines.join("\n").trimEnd();
}

function toolLines(run: AgentTaskRun) {
  if (run.tools.length === 0) {
    return ["- None"];
  }

  return truncateList(
    run.tools.map((tool, index) => {
      const parts = [
        `${index + 1}. \`${tool.name}\``,
        capabilityLabel(tool.capability),
        toolStatusLabel(tool.status)
      ];
      if (tool.durationMs !== undefined) {
        parts.push(formatDurationMs(tool.durationMs));
      }
      const lines = [`${parts.join(" - ")}`];
      if (tool.arguments !== undefined) {
        lines.push(`   - Arguments: \`${inlineText(safeJson(tool.arguments), MAX_ARGUMENT_TEXT)}\``);
      }
      lines.push(`   - Policy: ${toolPolicyLine(run, tool)}`);
      if (tool.resultPreview) {
        lines.push(`   - Result: ${inlineText(tool.resultPreview)}`);
      }
      if (tool.artifactIds?.length) {
        lines.push(`   - Artifacts: ${tool.artifactIds.map((artifactId) => `\`${artifactId}\``).join(", ")}`);
      }
      return lines.join("\n");
    })
  );
}

function toolPolicyLine(run: AgentTaskRun, tool: AgentTaskRun["tools"][number]) {
  const approval = matchingApprovalForTool(run, tool);
  if (!approval) {
    return `${capabilityLabel(tool.capability)} capability recorded; no matching approval audit`;
  }
  const details = [
    approvalStatusLabel(approval.status),
    approval.effect,
    approval.trustMode,
    approval.override ? `workspace override ${approval.override}` : undefined,
    approval.risky ? "risky" : undefined,
    approvalScopeSummary(approval.scope)
  ].filter((item): item is string => Boolean(item));
  return `${details.join(" - ")}: ${inlineText(approval.reason)}`;
}

function matchingApprovalForTool(run: AgentTaskRun, tool: AgentTaskRun["tools"][number]) {
  const approvals = (run.approvals ?? []).filter((approval) => approval.capability === tool.capability);
  if (approvals.length === 0) {
    return undefined;
  }
  return approvals
    .slice()
    .sort((left, right) => {
      const leftRank = approvalMatchRank(left.status);
      const rightRank = approvalMatchRank(right.status);
      if (leftRank !== rightRank) {
        return rightRank - leftRank;
      }
      return approvalTimestamp(right).localeCompare(approvalTimestamp(left));
    })[0];
}

function approvalMatchRank(status: AgentTaskRunApprovalStatus) {
  if (status === "allowed" || status === "approved" || status === "blocked" || status === "denied") {
    return 2;
  }
  return 1;
}

function approvalTimestamp(approval: AgentTaskRun["approvals"][number]) {
  return approval.updatedAt ?? approval.decidedAt ?? approval.requestedAt ?? approval.createdAt;
}

function approvalLines(run: AgentTaskRun) {
  if (run.approvals.length === 0) {
    return ["- None"];
  }

  return truncateList(
    run.approvals.map((approval) => {
      const details = [
        approvalStatusLabel(approval.status),
        capabilityLabel(approval.capability),
        approval.actionType,
        approval.trustMode,
        approval.effect,
        approval.override ? `override ${approval.override}` : undefined,
        approval.risky ? "risky" : undefined,
        approvalScopeSummary(approval.scope)
      ].filter((item): item is string => Boolean(item));
      return `- ${details.join(" - ")}: ${inlineText(approval.summary)} (${inlineText(approval.reason)})`;
    })
  );
}

function approvalScopeSummary(scope: AgentTaskRun["approvals"][number]["scope"]) {
  if (!scope) {
    return undefined;
  }
  return ["scope", scope.label, scope.value].filter(Boolean).join(" ");
}

function artifactLines(run: AgentTaskRun) {
  if (run.artifacts.length === 0) {
    return ["- None"];
  }

  return truncateList(run.artifacts.map(artifactLine));
}

function artifactLine(artifact: AgentTaskRunArtifact) {
  const parts = [`- ${artifact.kind}: ${inlineText(artifact.title)}`];
  if (artifact.summary) {
    parts.push(inlineText(artifact.summary));
  }
  if (artifact.path) {
    parts.push(`path \`${artifact.path}\``);
  }
  if (artifact.changedPaths?.length) {
    parts.push(`paths ${artifact.changedPaths.map((changedPath) => `\`${changedPath}\``).join(", ")}`);
  }
  if (artifact.exitCode !== undefined) {
    parts.push(`exit ${artifact.exitCode}`);
  }
  if (artifact.durationMs !== undefined) {
    parts.push(formatDurationMs(artifact.durationMs));
  }
  if (artifact.testReports?.length) {
    parts.push(`${artifact.testReports.length} report${artifact.testReports.length === 1 ? "" : "s"}`);
  }
  return parts.join(" - ");
}

function worktreeLines(run: AgentTaskRun) {
  const worktree = run.worktree;
  if (!worktree?.enabled) {
    return ["- None"];
  }

  const lines = [`- Status: ${worktreeStatusLabel(worktree.status)}`];
  if (worktree.branch) {
    lines.push(`- Branch: \`${worktree.branch}\``);
  }
  if (worktree.path) {
    lines.push(`- Path: \`${worktree.path}\``);
  }
  if (worktree.baseRef) {
    lines.push(`- Base: \`${worktree.baseRef}\``);
  }
  if (worktree.continuedFromTaskRunId) {
    lines.push(`- Continued from: \`${worktree.continuedFromTaskRunId}\``);
  }
  if (worktree.replayOfTaskRunId) {
    lines.push(`- Replay of: \`${worktree.replayOfTaskRunId}\``);
  }
  if (worktree.plannedFromTaskRunId) {
    lines.push(`- Planned from: \`${worktree.plannedFromTaskRunId}\``);
  }
  if (worktree.diff) {
    const insertions = worktree.diff.insertions !== undefined ? `, +${worktree.diff.insertions}` : "";
    const deletions = worktree.diff.deletions !== undefined ? `, -${worktree.diff.deletions}` : "";
    lines.push(`- Diff: ${worktree.diff.files} file${worktree.diff.files === 1 ? "" : "s"}${insertions}${deletions}`);
  }
  if (worktree.patchPreview) {
    lines.push(
      `- Patch preview: ${worktree.patchPreview.lineCount} line${worktree.patchPreview.lineCount === 1 ? "" : "s"}${worktree.patchPreview.truncated ? " (truncated)" : ""}`
    );
  }
  if (worktree.pullRequest) {
    lines.push(`- PR: ${worktree.pullRequest.url ?? "not created"} (${worktree.pullRequest.title})`);
    if (worktree.pullRequest.review) {
      lines.push(`- PR review: ${inlineText(worktree.pullRequest.review.summary)}`);
    }
  }
  if (worktree.conflict) {
    lines.push(`- Conflict: ${inlineText(worktree.conflict.message)} (${worktree.conflict.files.length} file${worktree.conflict.files.length === 1 ? "" : "s"})`);
  }
  if (worktree.error) {
    lines.push(`- Error: ${inlineText(worktree.error)}`);
  }
  return lines;
}

function bulletList(items: string[]) {
  if (items.length === 0) {
    return ["- None"];
  }
  return truncateList(items.map((item) => `- ${item}`));
}

function truncateList(items: string[]) {
  if (items.length <= MAX_LIST_ITEMS) {
    return items;
  }
  return [...items.slice(0, MAX_LIST_ITEMS), `- ... ${items.length - MAX_LIST_ITEMS} more`];
}

function inlineText(value: string, maxLength = MAX_INLINE_TEXT) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized || "(empty)";
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function capabilityLabel(capability: AgentTaskRunCapability) {
  switch (capability) {
    case "read_repo":
      return "Read repo";
    case "write_workspace":
      return "Write workspace";
    case "run_command":
      return "Run command";
    case "network_fetch":
      return "Network fetch";
    case "browser_control":
      return "Browser control";
    case "mcp_call":
      return "MCP call";
    case "skill_context":
      return "Skill context";
    case "local_context":
      return "Local context";
    case "unknown":
      return "Unknown";
  }
}

function taskRunStatusLabel(status: AgentTaskRunStatus) {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "blocked":
      return "Blocked";
    case "max_iterations":
      return "Max iterations";
  }
}

function toolStatusLabel(status: AgentTaskRunToolStatus) {
  switch (status) {
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
  }
}

function approvalStatusLabel(status: AgentTaskRunApprovalStatus) {
  switch (status) {
    case "allowed":
      return "Allowed";
    case "requested":
      return "Requested";
    case "approved":
      return "Approved";
    case "denied":
      return "Denied";
    case "blocked":
      return "Blocked";
  }
}

function verificationStatusLabel(status: AgentTaskRunVerificationStatus) {
  switch (status) {
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "unknown":
      return "Unknown";
  }
}

function worktreeStatusLabel(status: AgentTaskRunWorktreeStatus) {
  switch (status) {
    case "creating":
      return "Creating";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "merged":
      return "Merged";
    case "discarded":
      return "Discarded";
    case "cleaned":
      return "Cleaned";
  }
}

function formatDurationMs(durationMs: number) {
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

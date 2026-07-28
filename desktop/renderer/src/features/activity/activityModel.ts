import { basename, formatDateTime, formatDurationMs } from "../../format";
import { buildReportRemediationPrompt } from "../../../../../src/agent/reportRemediation";
import { capabilityForToolName } from "../../../../../src/agent/toolCapabilities";
import { chatContentTextOnly, chatContentToText } from "../chat/chatContent";
import { agentLoopStatusLabel } from "../sessions/agentLoopPresentation";
import { isSessionRunning } from "../sessions/sessionState";
import { capabilityLabel, trustModeLabel } from "./capabilityPresentation";
import type {
  ActivityEvidenceLink,
  ActivityGroup,
  ActivityGroupStatus,
  ActivityItem,
  ActivityModel,
  ActivityPolicyDetail,
  ToolRunEntry
} from "./activityTypes";
import { parseUnifiedDiffPreview, splitLines, type DiffPreview } from "../../shared/diff";
import { shortRunId } from "../../shared/id";
import { parseMaybeJson, safeJson } from "../../shared/json";
import { isRecord } from "../../shared/typeGuards";
import { truncateMiddle } from "../../shared/text";
import { verificationStatusLabel } from "../worktrees/worktreePresentation";

export const MAX_ACTIVITY_EVIDENCE_LINKS = 8;

export function findLatestActivityScreenshot(activity: ActivityItem[]) {
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    const item = activity[index];
    if (item?.imagePreview) {
      return item;
    }
  }
  return null;
}

export function deriveActivityModel(messages: ChatMessage[], state: DesktopState | null): ActivityModel {
  const systemItems: ActivityItem[] = [];
  const groups: ActivityGroup[] = [];
  const groupsByUserMessageIndex = new Map<number, ActivityGroup>();
  const taskRuns = state?.taskRuns ?? [];
  const taskRunsById = new Map(taskRuns.map((run) => [run.id, run]));
  const taskRunsByUserMessageIndex = new Map<number, AgentTaskRun[]>();
  for (const run of taskRuns) {
    const runs = taskRunsByUserMessageIndex.get(run.userMessageIndex) ?? [];
    runs.push(run);
    taskRunsByUserMessageIndex.set(run.userMessageIndex, runs);
  }
  const latestRunForUserMessage = (index: number) => taskRunsByUserMessageIndex.get(index)?.at(-1);
  const sourceRunFor = (run: AgentTaskRun | undefined) => {
    const sourceRunId = run?.worktree?.continuedFromTaskRunId;
    return sourceRunId ? taskRunsById.get(sourceRunId) : undefined;
  };
  const planSourceRunFor = (run: AgentTaskRun | undefined) => {
    const sourceRunId = run?.worktree?.plannedFromTaskRunId;
    return sourceRunId ? taskRunsById.get(sourceRunId) : undefined;
  };
  const worktreeAttemptRunsFor = (run: AgentTaskRun | undefined) => buildWorktreeAttemptRuns(run, taskRunsById);
  const completedToolCallIds = new Set(
    messages.flatMap((message) => (message.role === "tool" && message.toolCallId ? [message.toolCallId] : []))
  );
  const currentSessionRunning = state ? isSessionRunning(state, state.sessionId) : false;
  if (state) {
    systemItems.push({
      id: "workspace",
      kind: "system",
      title: "workspace",
      detail: `${state.workspace.root}\n${state.workspace.dirty ? "git: dirty" : "git: clean"}`
    });
    if (state.agentLoop) {
      systemItems.push({
        id: "agent-loop",
        kind: "system",
        title: "agent loop",
        detail: [
          agentLoopStatusLabel(state.agentLoop),
          `Goal: ${state.agentLoop.goal}`,
          `Started: ${formatDateTime(state.agentLoop.startedAt)}`,
          `Updated: ${formatDateTime(state.agentLoop.updatedAt)}`
        ].join("\n"),
        summary: state.agentLoop.lastDecision
          ? `${agentLoopStatusLabel(state.agentLoop)}; last decision: ${state.agentLoop.lastDecision}`
          : agentLoopStatusLabel(state.agentLoop),
        status: state.agentLoop.status === "running" || state.agentLoop.status === "stopping" ? "running" : "done"
      });
    }
  }

  let currentGroup: ActivityGroup | null = null;
  let detachedGroup: ActivityGroup | null = null;
  const getDetachedGroup = () => {
    if (!detachedGroup) {
      detachedGroup = {
        id: "activity-group-session",
        userMessageIndex: null,
        title: "Session activity",
        detail: "Tool activity that was restored without a visible user query.",
        items: [],
        status: "done"
      };
      groups.push(detachedGroup);
    }
    return detachedGroup;
  };
  const activeGroup = () => currentGroup ?? getDetachedGroup();

  messages.forEach((message, index) => {
    if (message.role === "user") {
      const group: ActivityGroup = {
        id: `activity-group-${index}`,
        userMessageIndex: index,
        title: queryActivityTitle(message.content),
        detail: chatContentToText(message.content),
        items: [],
        status: "done",
        run: latestRunForUserMessage(index)
      };
      group.sourceRun = sourceRunFor(group.run);
      group.planSourceRun = planSourceRunFor(group.run);
      group.worktreeAttemptRuns = worktreeAttemptRunsFor(group.run);
      currentGroup = group;
      groups.push(group);
      groupsByUserMessageIndex.set(index, group);
      return;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      const group = activeGroup();
      for (const call of message.toolCalls) {
        const complete = completedToolCallIds.has(call.id);
        const policy = activityPolicyForToolActivity(group.run, call.id, call.name);
        group.items.push({
          id: `call-${index}-${call.id}`,
          kind: "call",
          toolCallId: call.id,
          title: call.name,
          detail: safeJson(call.arguments),
          summary: summarizeToolCall(call),
          status: complete ? "done" : currentSessionRunning ? "running" : "waiting",
          policy
        });
      }
    }
    if (message.role === "tool") {
      const group = activeGroup();
      const toolResult = buildToolResultActivity(message);
      const policy = message.name ? activityPolicyForToolActivity(group.run, message.toolCallId, message.name) : undefined;
      group.items.push({
        id: `tool-${index}-${message.toolCallId ?? message.name}`,
        kind: "result",
        toolCallId: message.toolCallId,
        title: message.name ?? "tool",
        detail: toolResult.detail,
        summary: toolResult.summary,
        imagePreview: toolResult.imagePreview,
        policy
      });
    }
  });

  const groupedRunIds = new Set(groups.flatMap((group) => (group.run ? [group.run.id] : [])));
  for (const group of groups) {
    if (!group.run) {
      continue;
    }
    if (group.items.length === 0) {
      group.items.push(...activityItemsFromTaskRun(group.run));
    } else {
      group.items.unshift(...approvalActivityItemsFromTaskRun(group.run));
    }
  }
  for (const run of taskRuns) {
    if (groupedRunIds.has(run.id)) {
      continue;
    }
    groups.push({
      id: `activity-group-run-${run.id}`,
      userMessageIndex: run.userMessageIndex,
      title: run.promptPreview || "Restored run",
      detail: run.promptPreview,
      items: activityItemsFromTaskRun(run),
      status: activityStatusForTaskRun(run),
      run,
      sourceRun: sourceRunFor(run),
      planSourceRun: planSourceRunFor(run),
      worktreeAttemptRuns: worktreeAttemptRunsFor(run)
    });
  }

  for (const group of groups) {
    group.status = group.run
      ? mergeActivityGroupStatus(group.run, deriveActivityGroupStatus(group.items))
      : deriveActivityGroupStatus(group.items);
  }

  if (currentSessionRunning) {
    const runningCallCount = groups.flatMap((group) => group.items).filter((item) => item.status === "running").length;
    systemItems.push({
      id: "agent-progress",
      kind: "system",
      title: runningCallCount > 0 ? "agent progress" : "agent working",
      detail: "This panel shows visible progress from streamed messages and tool calls. Private model reasoning is not displayed.",
      summary:
        runningCallCount > 0
          ? `${runningCallCount} tool ${runningCallCount === 1 ? "call is" : "calls are"} running.`
          : "Waiting for the next streamed response or tool call."
    });
  }

  const items = [...systemItems, ...groups.flatMap((group) => group.items)];
  return {
    items,
    systemItems,
    groups,
    groupsByUserMessageIndex
  };
}

export function buildWorktreeAttemptRuns(run: AgentTaskRun | undefined, runsById: Map<string, AgentTaskRun>) {
  if (!run?.worktree?.enabled) {
    return [];
  }

  const reversed: AgentTaskRun[] = [];
  const seen = new Set<string>();
  let current: AgentTaskRun | undefined = run;
  while (current?.worktree?.enabled && !seen.has(current.id)) {
    seen.add(current.id);
    reversed.push(current);
    const previousId: string | undefined = current.worktree.continuedFromTaskRunId;
    current = previousId ? runsById.get(previousId) : undefined;
  }
  return reversed.reverse();
}

export function activityItemsFromTaskRun(run: AgentTaskRun): ActivityItem[] {
  const items: ActivityItem[] = [...approvalActivityItemsFromTaskRun(run)];
  for (const tool of run.tools) {
    const artifacts =
      tool.artifactIds
        ?.map((artifactId) => run.artifacts.find((candidate) => candidate.id === artifactId))
        .filter((candidate): candidate is AgentTaskRunArtifact => Boolean(candidate)) ?? [];
    const screenshotArtifact = artifacts.find((candidate) => candidate.kind === "browser_screenshot" && Boolean(candidate.path));
    const commandArtifact = artifacts.find((candidate) => candidate.kind === "command_output");
    const patchArtifact = artifacts.find((candidate) => candidate.kind === "patch");
    const fileChangeArtifact = artifacts.find((candidate) => candidate.kind === "file_change");
    const artifact = commandArtifact ?? patchArtifact ?? fileChangeArtifact ?? screenshotArtifact ?? artifacts[0];
    const resultDetail = commandArtifact
      ? commandArtifactDetail(commandArtifact)
      : patchArtifact
        ? patchArtifactDetail(patchArtifact)
        : fileChangeArtifact
          ? fileChangeArtifactDetail(fileChangeArtifact)
          : (tool.resultPreview ?? artifact?.summary ?? "");
    const resultSummary =
      commandArtifactSummary(commandArtifact) ??
      patchArtifactSummary(patchArtifact) ??
      fileChangeArtifactSummary(fileChangeArtifact) ??
      artifact?.summary;
    const resultStatus =
      tool.status === "failed" ||
      (commandArtifact?.exitCode !== undefined && commandArtifact.exitCode !== 0) ||
      commandArtifact?.testReports?.some((report) => report.status === "failed")
        ? "failed"
        : "done";
    const imagePreview = screenshotArtifact?.path
      ? {
          path: screenshotArtifact.path,
          width: screenshotArtifact.width,
          height: screenshotArtifact.height,
          caption: screenshotArtifact.summary ?? "Browser screenshot"
        }
      : undefined;
    const diffPreview = patchArtifact?.diff
      ? patchArtifactDiffPreview(patchArtifact)
      : fileChangeArtifact?.content !== undefined
        ? fileChangeArtifactDiffPreview(fileChangeArtifact)
        : undefined;
    const policy = activityPolicyForRunTool(run, tool);

    items.push({
      id: `run-call-${run.id}-${tool.toolCallId}`,
      kind: "call",
      toolCallId: tool.toolCallId,
      title: tool.name,
      detail: safeJson(tool.arguments ?? {}),
      summary: capabilityLabel(tool.capability),
      status: tool.status === "done" ? "done" : tool.status === "failed" ? "failed" : "running",
      policy
    });
    if (tool.resultPreview || artifact) {
      items.push({
        id: `run-result-${run.id}-${tool.toolCallId}`,
        kind: "result",
        toolCallId: tool.toolCallId,
        title: tool.name,
        detail: resultDetail,
        summary: resultSummary,
        status: resultStatus,
        imagePreview,
        diffPreview,
        evidenceLinks: commandArtifact ? commandArtifactEvidenceLinks(run.id, commandArtifact) : undefined,
        remediationPrompt: commandArtifact ? buildReportRemediationPrompt(commandArtifact) : undefined,
        rollbackPrompt: buildEditRollbackPrompt(run, patchArtifact, fileChangeArtifact),
        policy
      });
    }
  }
  return items;
}

export function approvalActivityItemsFromTaskRun(run: AgentTaskRun): ActivityItem[] {
  return (run.approvals ?? []).map((approval) => ({
    id: `run-approval-${run.id}-${approval.id}`,
    kind: "approval" as const,
    title: approvalTitle(approval),
    detail: approvalDetail(approval),
    summary: approvalSummary(approval),
    status: approvalActivityStatus(approval.status),
    diffPreview: approvalChangePreviewDiffPreview(approval.changePreview),
    policy: activityPolicyFromApproval(approval)
  }));
}

export function activityPolicyForToolActivity(
  run: AgentTaskRun | undefined,
  toolCallId: string | undefined,
  name: string
): ActivityPolicyDetail {
  const tool = taskRunToolForActivity(run, toolCallId, name);
  if (run && tool) {
    return activityPolicyForRunTool(run, tool);
  }
  return inferredActivityPolicyForTool(name);
}

export function taskRunToolForActivity(run: AgentTaskRun | undefined, toolCallId: string | undefined, name: string) {
  if (!run) {
    return undefined;
  }
  if (toolCallId) {
    const byId = run.tools.find((tool) => tool.toolCallId === toolCallId);
    if (byId) {
      return byId;
    }
  }
  return run.tools.find((tool) => tool.name === name);
}

export function activityPolicyForRunTool(run: AgentTaskRun, tool: AgentTaskRunToolCall): ActivityPolicyDetail {
  const approval = matchingApprovalForTool(run, tool);
  if (approval) {
    return activityPolicyFromApproval(approval);
  }
  return {
    capability: tool.capability,
    capabilityLabel: capabilityLabel(tool.capability),
    source: "tool",
    label: "Recorded capability",
    reason: "This tool call has a saved capability record, but no matching approval audit was recorded on the task run.",
    summary: `Tool ${tool.name} was classified as ${capabilityLabel(tool.capability)}.`
  };
}

export function matchingApprovalForTool(run: AgentTaskRun, tool: AgentTaskRunToolCall) {
  const approvals = (run.approvals ?? []).filter((approval) => approval.capability === tool.capability);
  if (approvals.length === 0) {
    return undefined;
  }
  return approvals.slice().sort((left, right) => {
    const leftRank = approvalMatchRank(left.status);
    const rightRank = approvalMatchRank(right.status);
    if (leftRank !== rightRank) {
      return rightRank - leftRank;
    }
    return approvalTimestamp(right).localeCompare(approvalTimestamp(left));
  })[0];
}

export function approvalMatchRank(status: AgentTaskRunApprovalStatus) {
  if (status === "allowed" || status === "approved" || status === "blocked" || status === "denied") {
    return 2;
  }
  return 1;
}

export function approvalTimestamp(approval: AgentTaskRunApproval) {
  return approval.updatedAt ?? approval.decidedAt ?? approval.requestedAt ?? approval.createdAt;
}

export function activityPolicyFromApproval(approval: AgentTaskRunApproval): ActivityPolicyDetail {
  return {
    capability: approval.capability,
    capabilityLabel: capabilityLabel(approval.capability),
    source: "approval",
    label: approval.label,
    reason: approval.reason,
    effect: approval.effect,
    status: approval.status,
    trustMode: approval.trustMode,
    risky: approval.risky,
    override: approval.override,
    scope: approval.scope,
    summary: approval.summary
  };
}

export function inferredActivityPolicyForTool(name: string): ActivityPolicyDetail {
  const capability = capabilityForToolName(name);
  return {
    capability,
    capabilityLabel: capabilityLabel(capability),
    source: "inferred",
    label: "Inferred capability",
    reason: "This row was restored from transcript tool protocol, so Arivu inferred the capability from the tool name.",
    summary: `Tool ${name} maps to ${capabilityLabel(capability)}.`
  };
}

export function approvalTitle(approval: AgentTaskRunApproval) {
  return `${approvalActionLabel(approval.actionType)} ${approvalStatusLabel(approval.status).toLowerCase()}`;
}

export function approvalSummary(approval: AgentTaskRunApproval) {
  return `${approvalStatusLabel(approval.status)}: ${capabilityLabel(approval.capability)} - ${approval.summary}`;
}

export function approvalDetail(approval: AgentTaskRunApproval) {
  const lines = [
    `status: ${approvalStatusLabel(approval.status)}`,
    `action: ${approval.actionType}`,
    `capability: ${capabilityLabel(approval.capability)}`,
    `trust mode: ${trustModeLabel(approval.trustMode)}`,
    `policy: ${approval.effect}${approval.override ? ` (workspace override: ${approval.override})` : ""}`,
    `risk: ${approval.risky ? "risky" : "standard"}`,
    approval.scope ? `scope: ${approvalScopeDetail(approval.scope)}` : undefined,
    `reason: ${approval.reason}`,
    approval.requestedAt ? `requested: ${formatDateTime(approval.requestedAt)}` : undefined,
    approval.decidedAt ? `decided: ${formatDateTime(approval.decidedAt)}` : undefined,
    `summary: ${approval.summary}`,
    approval.changePreview ? `change preview:\n${approvalChangePreviewDetail(approval.changePreview)}` : undefined,
    approval.message ? `prompt:\n${approval.message}` : undefined
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

export function approvalChangePreviewDetail(preview: AgentTaskRunApprovalChangePreview) {
  const lines = [
    `kind: ${preview.kind}`,
    `title: ${preview.title}`,
    preview.summary ? `summary: ${preview.summary}` : undefined,
    preview.path ? `path: ${preview.path}` : undefined,
    preview.writeMode ? `mode: ${preview.writeMode}` : undefined,
    preview.changedPaths?.length ? `changedPaths:\n${preview.changedPaths.map((changedPath) => `- ${changedPath}`).join("\n")}` : undefined,
    preview.additions !== undefined || preview.deletions !== undefined
      ? `stats: +${preview.additions ?? 0} -${preview.deletions ?? 0}`
      : undefined,
    preview.lineCount !== undefined ? `lines: ${preview.lineCount}` : undefined,
    preview.bytes !== undefined ? `bytes: ${preview.bytes}` : undefined,
    preview.diffTruncated ? "diff: truncated" : undefined,
    preview.contentTruncated ? "content: truncated" : undefined,
    preview.originalTruncated ? "original: truncated" : undefined
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

export function approvalChangePreviewDiffPreview(preview?: AgentTaskRunApprovalChangePreview): DiffPreview | undefined {
  if (!preview) {
    return undefined;
  }
  if (preview.kind === "patch" && preview.diff) {
    return {
      ...parseUnifiedDiffPreview(preview.diff),
      title: preview.diffTruncated ? "Proposed patch (truncated)" : "Proposed patch"
    };
  }
  if (preview.kind === "file_change" && preview.content !== undefined) {
    const title = preview.path
      ? `${preview.writeMode === "replace" ? "Proposed replacement" : "Proposed file"} ${preview.path}`
      : "Proposed file write";
    return {
      title: preview.contentTruncated ? `${title} (truncated)` : title,
      lines: splitLines(preview.content).map((text, index) => ({
        kind: "add",
        newNumber: index + 1,
        text
      }))
    };
  }
  return undefined;
}

export function approvalScopeDetail(scope: AgentTaskRunApprovalScope) {
  const pieces = [scope.label, scope.value].filter(Boolean);
  if (scope.detail) {
    pieces.push(scope.detail);
  }
  return pieces.join(" - ");
}

export function approvalActivityStatus(status: AgentTaskRunApprovalStatus): ActivityItem["status"] {
  if (status === "requested") {
    return "waiting";
  }
  if (status === "denied" || status === "blocked") {
    return "failed";
  }
  return "done";
}

export function approvalStatusLabel(status: AgentTaskRunApprovalStatus) {
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

export function approvalActionLabel(actionType: AgentTaskRunApproval["actionType"]) {
  switch (actionType) {
    case "read":
      return "Read approval";
    case "write":
      return "Write approval";
    case "shell":
      return "Command approval";
    case "mcp":
      return "MCP approval";
    case "network":
      return "Network approval";
    case "browser":
      return "Browser approval";
  }
}

export function commandArtifactSummary(artifact?: AgentTaskRunArtifact) {
  if (!artifact || artifact.kind !== "command_output") {
    return undefined;
  }
  const parts = [
    artifact.timedOut ? "Timed out" : undefined,
    artifact.exitCode === undefined ? undefined : `Exit code ${artifact.exitCode}`,
    artifact.commandMode ? `Mode ${artifact.commandMode}` : undefined,
    artifact.commandRisk ? `Risk ${artifact.commandRisk}` : undefined,
    artifact.timeoutMs === undefined ? undefined : `Timeout ${formatDurationMs(artifact.timeoutMs)}`,
    artifact.signal === undefined ? undefined : `Signal ${artifact.signal}`,
    artifact.durationMs === undefined ? undefined : formatDurationMs(artifact.durationMs),
    testReportSummary(artifact.testReports) ??
      (artifact.reportPaths?.length
        ? `${artifact.reportPaths.length} report path${artifact.reportPaths.length === 1 ? "" : "s"}`
        : undefined),
    diagnosticSummary(artifact.diagnostics)
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" - ") : artifact.summary;
}

export function commandArtifactDetail(artifact: AgentTaskRunArtifact) {
  const metadata = [
    artifact.command === undefined ? undefined : `command: ${artifact.command}`,
    artifact.commandMode === undefined ? undefined : `commandMode: ${artifact.commandMode}`,
    artifact.commandRisk === undefined ? undefined : `commandRisk: ${artifact.commandRisk}`,
    artifact.commandAnalysis === undefined ? undefined : `commandAnalysis: ${artifact.commandAnalysis}`,
    artifact.executionProfile === undefined ? undefined : `executionProfile: ${artifact.executionProfile}`,
    artifact.executionIsolation === undefined ? undefined : `executionIsolation: ${artifact.executionIsolation}`,
    artifact.workingDirectory === undefined ? undefined : `workingDirectory: ${artifact.workingDirectory}`,
    artifact.timeoutMs === undefined ? undefined : `timeoutMs: ${artifact.timeoutMs}`,
    artifact.timedOut === undefined ? undefined : `timedOut: ${artifact.timedOut}`,
    artifact.signal === undefined ? undefined : `signal: ${artifact.signal}`,
    artifact.exitCode === undefined ? undefined : `exitCode: ${artifact.exitCode}`,
    artifact.durationMs === undefined ? undefined : `duration: ${formatDurationMs(artifact.durationMs)}`
  ].filter((part): part is string => Boolean(part));
  const sections = metadata.length > 0 ? [metadata.join("\n")] : [];

  if (artifact.testReports?.length) {
    sections.push(`test reports:\n${artifact.testReports.map(formatTestReportDetail).join("\n")}`);
  }
  const parsedReportPaths = new Set(artifact.testReports?.map((report) => report.path) ?? []);
  const unparsedReportPaths = artifact.reportPaths?.filter((path) => !parsedReportPaths.has(path)) ?? [];
  if (unparsedReportPaths.length) {
    sections.push(`report paths:\n${unparsedReportPaths.map((path) => `- ${path}`).join("\n")}`);
  }
  if (artifact.diagnostics?.length) {
    sections.push(`diagnostics:\n${artifact.diagnostics.map(formatDiagnosticLine).join("\n")}`);
  }
  if (artifact.stdout !== undefined) {
    sections.push(`stdout${artifact.stdoutTruncated ? " (truncated)" : ""}:\n${artifact.stdout || "(empty)"}`);
  }
  if (artifact.stderr !== undefined) {
    sections.push(`stderr${artifact.stderrTruncated ? " (truncated)" : ""}:\n${artifact.stderr || "(empty)"}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : (artifact.summary ?? "");
}

export function patchArtifactSummary(artifact?: AgentTaskRunArtifact) {
  if (!artifact || artifact.kind !== "patch") {
    return undefined;
  }
  const stats = [
    artifact.changedPaths?.length ? `${artifact.changedPaths.length} file${artifact.changedPaths.length === 1 ? "" : "s"}` : undefined,
    artifact.additions ? `+${artifact.additions}` : undefined,
    artifact.deletions ? `-${artifact.deletions}` : undefined,
    artifact.diffTruncated ? "truncated" : undefined
  ].filter((part): part is string => Boolean(part));
  return stats.length > 0 ? `${artifact.summary ?? "Patch applied"} - ${stats.join(" ")}` : artifact.summary;
}

export function patchArtifactDetail(artifact: AgentTaskRunArtifact) {
  const metadata = [
    artifact.changedPaths?.length ? `changedPaths:\n${artifact.changedPaths.map((path) => `- ${path}`).join("\n")}` : undefined,
    artifact.additions !== undefined || artifact.deletions !== undefined
      ? `stats: +${artifact.additions ?? 0} -${artifact.deletions ?? 0}`
      : undefined,
    artifact.diffTruncated ? "diff: truncated" : undefined
  ].filter((part): part is string => Boolean(part));
  return metadata.length > 0 ? metadata.join("\n\n") : (artifact.summary ?? "");
}

export function patchArtifactDiffPreview(artifact: AgentTaskRunArtifact): DiffPreview | undefined {
  if (!artifact.diff) {
    return undefined;
  }
  return {
    ...parseUnifiedDiffPreview(artifact.diff),
    title: artifact.diffTruncated ? "Applied patch (truncated)" : "Applied patch"
  };
}

export function buildEditRollbackPrompt(
  run: AgentTaskRun,
  patchArtifact?: AgentTaskRunArtifact,
  fileChangeArtifact?: AgentTaskRunArtifact
) {
  const artifact = patchArtifact ?? fileChangeArtifact;
  if (!artifact || (artifact.kind !== "patch" && artifact.kind !== "file_change")) {
    return undefined;
  }

  const paths = editArtifactPaths(artifact);
  const intro =
    artifact.kind === "patch"
      ? `Review and revert the direct patch artifact from Arivu task run ${run.id}.`
      : `Review and revert the direct file-change artifact from Arivu task run ${run.id}.`;
  const lines = [
    intro,
    "Before editing, inspect the current files and preserve any later user or agent changes that are unrelated to this artifact.",
    "Prefer the smallest safe reverse patch. If the change cannot be reverted cleanly, explain what blocks it and ask before doing anything destructive.",
    run.promptPreview ? `Original request: ${run.promptPreview}` : undefined,
    artifact.summary ? `Artifact summary: ${artifact.summary}` : undefined,
    paths.length ? `Changed path${paths.length === 1 ? "" : "s"}:\n${paths.map((filePath) => `- ${filePath}`).join("\n")}` : undefined,
    artifact.kind === "patch" && (artifact.additions !== undefined || artifact.deletions !== undefined)
      ? `Patch stats: +${artifact.additions ?? 0} -${artifact.deletions ?? 0}`
      : undefined,
    artifact.kind === "file_change" && artifact.writeMode
      ? `File-change mode: ${artifact.writeMode}${artifact.lineCount !== undefined ? `, ${artifact.lineCount} lines` : ""}`
      : undefined,
    "",
    editArtifactEvidenceSection(artifact),
    "",
    "After reverting, run the first focused verification that fits the affected files and summarize the result."
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

export function editArtifactPaths(artifact: AgentTaskRunArtifact) {
  if (artifact.kind === "patch") {
    return artifact.changedPaths ?? [];
  }
  return artifact.path ? [artifact.path] : [];
}

export function editArtifactEvidenceSection(artifact: AgentTaskRunArtifact) {
  if (artifact.kind === "patch" && artifact.diff) {
    const suffix = artifact.diffTruncated ? " (truncated)" : "";
    return `Applied diff evidence${suffix}:\n\`\`\`diff\n${artifact.diff}\n\`\`\``;
  }
  if (artifact.kind === "file_change" && artifact.content !== undefined) {
    const suffix = artifact.contentTruncated ? " (truncated)" : "";
    return `Written content evidence${suffix}:\n\`\`\`\n${artifact.content}\n\`\`\``;
  }
  return "No bounded diff/content evidence was saved on this artifact. Use the changed paths and current git state to identify the smallest safe revert.";
}

export function fileChangeArtifactSummary(artifact?: AgentTaskRunArtifact) {
  if (!artifact || artifact.kind !== "file_change") {
    return undefined;
  }
  const stats = [
    artifact.lineCount !== undefined ? `${artifact.lineCount} line${artifact.lineCount === 1 ? "" : "s"}` : undefined,
    artifact.contentTruncated ? "truncated" : undefined
  ].filter((part): part is string => Boolean(part));
  return stats.length > 0 ? `${artifact.summary ?? "File changed"} - ${stats.join(" ")}` : artifact.summary;
}

export function fileChangeArtifactDetail(artifact: AgentTaskRunArtifact) {
  const metadata = [
    artifact.path ? `path: ${artifact.path}` : undefined,
    artifact.writeMode ? `mode: ${artifact.writeMode}` : undefined,
    artifact.lineCount !== undefined ? `lines: ${artifact.lineCount}` : undefined,
    artifact.contentTruncated ? "content: truncated" : undefined
  ].filter((part): part is string => Boolean(part));
  return metadata.length > 0 ? metadata.join("\n") : (artifact.summary ?? "");
}

export function fileChangeArtifactDiffPreview(artifact: AgentTaskRunArtifact): DiffPreview | undefined {
  if (artifact.content === undefined) {
    return undefined;
  }
  const title = artifact.path ? `${artifact.writeMode === "replace" ? "Replaced" : "Created"} ${artifact.path}` : "File change";
  return {
    title: artifact.contentTruncated ? `${title} (truncated)` : title,
    lines: splitLines(artifact.content).map((text, index) => ({
      kind: "add",
      newNumber: index + 1,
      text
    }))
  };
}

export function commandArtifactEvidenceLinks(taskRunId: string, artifact: AgentTaskRunArtifact) {
  if (artifact.kind !== "command_output") {
    return undefined;
  }

  const links: ActivityEvidenceLink[] = [];
  const seen = new Set<string>();
  const addLink = (kind: ActivityEvidenceLink["kind"], path: string | undefined, line?: number) => {
    if (!path || links.length >= MAX_ACTIVITY_EVIDENCE_LINKS) {
      return;
    }
    const key = `${kind}:${path}:${line ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const suffix = line ? `:${line}` : "";
    const name = basename(path);
    links.push({
      id: `${taskRunId}:${artifact.id}:${key}`,
      kind,
      taskRunId,
      artifactId: artifact.id,
      path,
      line,
      label: kind === "report" ? `Open ${name}` : `Open ${name}${suffix}`,
      title: kind === "report" ? `Open report ${path}` : `Open evidence ${path}${suffix}`
    });
  };

  for (const reportPath of artifact.reportPaths ?? []) {
    addLink("report", reportPath);
  }
  for (const report of artifact.testReports ?? []) {
    addLink("report", report.path);
    for (const failure of report.failedTests ?? []) {
      addLink("source", failure.file, failure.line);
    }
    for (const finding of report.findingDetails ?? []) {
      addLink("source", finding.path, finding.line);
    }
  }
  for (const diagnostic of artifact.diagnostics ?? []) {
    addLink("diagnostic", diagnostic.path, diagnostic.line);
  }

  return links.length > 0 ? links : undefined;
}

export function diagnosticSummary(diagnostics?: AgentTaskRunDiagnostic[]) {
  if (!diagnostics?.length) {
    return undefined;
  }
  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  return errorCount > 0
    ? `${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"} (${errorCount} error${errorCount === 1 ? "" : "s"})`
    : `${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}`;
}

export function testReportSummary(reports?: AgentTaskRunTestReport[]) {
  if (!reports?.length) {
    return undefined;
  }
  const failedReports = reports.filter((report) => report.status === "failed").length;
  const first = reports[0];
  const suffix = reports.length > 1 ? ` + ${reports.length - 1} more` : "";
  const status = failedReports > 0 ? `${failedReports} failed report${failedReports === 1 ? "" : "s"}` : undefined;
  return `${first.summary}${suffix}${status ? ` (${status})` : ""}`;
}

export function formatTestReportLine(report: AgentTaskRunTestReport) {
  const kind = report.kind.toUpperCase();
  return `- ${report.path}: ${kind} ${report.summary} (${report.status})`;
}

export function formatTestReportDetail(report: AgentTaskRunTestReport) {
  const lines = [formatTestReportLine(report)];
  if (report.failedTests?.length) {
    lines.push(...report.failedTests.map((failure) => `  failed: ${formatFailedTestLine(failure)}`));
  }
  if (report.findingDetails?.length) {
    lines.push(...report.findingDetails.map((finding) => `  finding: ${formatFindingLine(finding)}`));
  }
  return lines.join("\n");
}

export function formatFailedTestLine(failure: NonNullable<AgentTaskRunTestReport["failedTests"]>[number]) {
  const label = [failure.classname, failure.name].filter(Boolean).join(".");
  const location = failure.file ? ` ${failure.file}${failure.line ? `:${failure.line}` : ""}` : "";
  const message = failure.message ? ` - ${failure.message}` : "";
  return `${label || failure.name}${location}${message}`;
}

export function formatFindingLine(finding: NonNullable<AgentTaskRunTestReport["findingDetails"]>[number]) {
  const rule = finding.ruleId ? `${finding.ruleId}` : "finding";
  const level = finding.level ? ` ${finding.level}` : "";
  const location = finding.path
    ? ` ${finding.path}${finding.line ? `:${finding.line}${finding.column ? `:${finding.column}` : ""}` : ""}`
    : "";
  const message = finding.message ? ` - ${finding.message}` : "";
  return `${rule}${level}${location}${message}`;
}

export function formatDiagnosticLine(diagnostic: AgentTaskRunDiagnostic) {
  const code = diagnostic.code ? `${diagnostic.code} ` : "";
  const location = diagnostic.path
    ? ` ${diagnostic.path}${diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : ""}`
    : "";
  return `- ${diagnostic.source} ${diagnostic.severity}${location} - ${code}${diagnostic.message}`;
}

export function mergeActivityGroupStatus(run: AgentTaskRun, itemStatus: ActivityGroupStatus): ActivityGroupStatus {
  const runStatus = activityStatusForTaskRun(run);
  if (runStatus === "running" || runStatus === "failed") {
    return runStatus;
  }
  if (itemStatus === "running" || itemStatus === "failed" || itemStatus === "waiting") {
    return itemStatus;
  }
  return runStatus;
}

export function activityStatusForTaskRun(run: AgentTaskRun): ActivityGroupStatus {
  if (run.status === "queued" || run.status === "running") {
    return "running";
  }
  if (run.status === "failed" || run.status === "blocked") {
    return "failed";
  }
  return "done";
}

export function deriveActivityGroupStatus(items: ActivityItem[]): ActivityGroupStatus {
  if (items.some((item) => item.status === "running")) {
    return "running";
  }
  if (items.some((item) => item.status === "failed")) {
    return "failed";
  }
  if (items.some((item) => item.status === "waiting")) {
    return "waiting";
  }
  return "done";
}

export function queryActivityTitle(content: ChatContent) {
  const text = chatContentTextOnly(content).replace(/\s+/g, " ").trim();
  return text ? truncateMiddle(text, 74) : "Image or attachment query";
}

export function toolRunSummaryLabel(group: ActivityGroup) {
  const label = toolActivityCountLabel(group.items);
  if (group.status === "running") {
    return `${label} running`;
  }
  if (group.status === "failed") {
    return `${label} failed`;
  }
  if (group.status === "waiting") {
    return `${label} waiting`;
  }
  return `${label} done`;
}

export function toolActivityCountLabel(items: ActivityItem[]) {
  const entries = toolRunEntriesFromItems(items);
  const toolCount = entries.filter((entry) => entry.kind === "tool").length;
  if (toolCount > 0) {
    return `${toolCount} tool ${toolCount === 1 ? "step" : "steps"}`;
  }
  return `${entries.length} activity ${entries.length === 1 ? "step" : "steps"}`;
}

export function activityGroupEyebrow(group: ActivityGroup) {
  if (group.run) {
    return `Query tools - ${shortRunId(group.run.id)}`;
  }
  if (group.userMessageIndex !== null) {
    return "Query tools";
  }
  return "Session tools";
}

export function toolRunEntriesFromItems(items: ActivityItem[]): ToolRunEntry[] {
  const entries: ToolRunEntry[] = [];
  const byToolCallId = new Map<string, ToolRunEntry>();
  for (const item of items) {
    if (item.kind === "system") {
      continue;
    }
    if ((item.kind === "call" || item.kind === "result") && item.toolCallId) {
      const existing = byToolCallId.get(item.toolCallId);
      if (existing) {
        if (item.kind === "call") {
          existing.call = item;
        } else {
          existing.result = item;
        }
        existing.title = existing.call?.title ?? existing.result?.title ?? existing.title;
        existing.status = mergeToolRunEntryStatus(existing.call, existing.result);
        existing.policy = existing.call?.policy ?? existing.result?.policy;
        existing.imagePreview = existing.result?.imagePreview ?? existing.call?.imagePreview;
        continue;
      }

      const entry: ToolRunEntry = {
        id: `tool-entry-${item.toolCallId}`,
        kind: "tool",
        title: item.title,
        status: mergeToolRunEntryStatus(item.kind === "call" ? item : undefined, item.kind === "result" ? item : undefined),
        call: item.kind === "call" ? item : undefined,
        result: item.kind === "result" ? item : undefined,
        policy: item.policy,
        imagePreview: item.imagePreview
      };
      byToolCallId.set(item.toolCallId, entry);
      entries.push(entry);
      continue;
    }

    entries.push({
      id: `tool-entry-${item.id}`,
      kind: item.kind === "approval" ? "approval" : "event",
      title: item.title,
      status: item.status,
      item,
      policy: item.policy,
      imagePreview: item.imagePreview
    });
  }
  return entries;
}

export function mergeToolRunEntryStatus(call: ActivityItem | undefined, result: ActivityItem | undefined): ActivityItem["status"] {
  if (result?.status === "failed" || call?.status === "failed") {
    return "failed";
  }
  if (result) {
    return result.status ?? "done";
  }
  return call?.status;
}

export function toolRunEntryKindLabel(entry: ToolRunEntry) {
  if (entry.kind === "tool") {
    return entry.result ? "Tool" : "Call";
  }
  if (entry.kind === "approval") {
    return "Approval";
  }
  return "Event";
}

export function taskRunStatusLabel(status: AgentTaskRunStatus) {
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
    default:
      return status;
  }
}

export function verificationMetaLabel(verification: AgentTaskRunVerification) {
  if (verification.status === "unknown") {
    return "Verification unknown";
  }
  return `Verification ${verificationStatusLabel(verification.status).toLowerCase()}`;
}

export function planItemStatusLabel(status: NonNullable<AgentTaskRun["plan"]>["items"][number]["status"]) {
  switch (status) {
    case "completed":
      return "Done";
    case "in_progress":
      return "Doing";
    case "pending":
      return "Next";
    default:
      return "Step";
  }
}

export function planReviewStatusLabel(status: NonNullable<AgentTaskRun["planReview"]>["status"]) {
  switch (status) {
    case "approved":
      return "Approved";
    case "revision_requested":
      return "Revision requested";
    case "cancelled":
      return "Cancelled";
    default:
      return "Plan review";
  }
}

export function toolRunDetailPreview(item: ActivityItem) {
  const detail = item.detail.trim();
  if (!detail || item.imagePreview) {
    return undefined;
  }
  if (item.summary && detail === item.summary) {
    return undefined;
  }
  const maxLength = item.kind === "call" ? 360 : 260;
  return detail.length > maxLength ? `${detail.slice(0, maxLength)}...` : detail;
}

export function summarizeToolCall(call: ToolCall) {
  const args = call.arguments;
  if (call.name.startsWith("browser_") && isRecord(args)) {
    return summarizeBrowserToolCall(call.name, args);
  }

  return undefined;
}

export function summarizeBrowserToolCall(name: string, args: Record<string, unknown>) {
  const mode = stringValue(args.mode) ?? "active";
  const tabLabel = browserTabLabel(args);
  if (name === "browser_state") {
    return "Inspect browser tabs and active page state.";
  }
  if (name === "browser_select_tab") {
    return `Select browser tab ${stringValue(args.tabId) ?? "tab"}.`;
  }
  if (name === "browser_open") {
    if (args.newTab === true) {
      return `Open ${stringValue(args.url) ?? "URL"} in a new ${mode} browser tab.`;
    }
    return `Open ${stringValue(args.url) ?? "URL"} in ${mode} browser${tabLabel}.`;
  }
  if (name === "browser_screenshot") {
    return `Capture a screenshot from the ${mode} browser${tabLabel}.`;
  }
  if (name === "browser_snapshot") {
    return `Read a page snapshot from the ${mode} browser${tabLabel}.`;
  }
  if (name === "browser_console") {
    return `Read console output from the ${mode} browser${tabLabel}.`;
  }
  if (name === "browser_click") {
    return `Click ${quoteActivityTarget(stringValue(args.target))} in the ${mode} browser${tabLabel}.`;
  }
  if (name === "browser_click_at") {
    const x = numberValue(args.x);
    const y = numberValue(args.y);
    const coordinateSpace = stringValue(args.coordinateSpace) ?? "css";
    const target = x !== undefined && y !== undefined ? `${Math.round(x)}, ${Math.round(y)} ${coordinateSpace}` : "coordinates";
    return `Click ${target} in the ${mode} browser${tabLabel}.`;
  }
  if (name === "browser_type") {
    const submit = args.submit === true ? " and submit" : "";
    return `Type into ${quoteActivityTarget(stringValue(args.target))}${submit} in the ${mode} browser${tabLabel}.`;
  }
  return undefined;
}

export function browserTabLabel(args: Record<string, unknown>) {
  const tabId = stringValue(args.tabId);
  return tabId ? ` tab ${tabId}` : "";
}

export function buildToolResultActivity(message: ChatMessage): Pick<ActivityItem, "detail" | "summary" | "imagePreview"> {
  const detail = chatContentToText(message.content);
  const parsed = parseMaybeJson(detail);
  if (!isRecord(parsed)) {
    return { detail };
  }

  const action = stringValue(parsed.action);
  const mode = stringValue(parsed.mode);
  const tabId = stringValue(parsed.tabId);
  const title = stringValue(parsed.title);
  const url = stringValue(parsed.url);
  const screenshotPath = stringValue(parsed.screenshotPath);
  const size = isRecord(parsed.size) ? parsed.size : undefined;
  const width = numberValue(size?.width);
  const height = numberValue(size?.height);

  const summaryParts: string[] = [];
  if (action) {
    summaryParts.push(browserActionLabel(action));
  }
  if (mode) {
    summaryParts.push(`${mode} browser`);
  }
  if (tabId && tabId !== mode) {
    summaryParts.push(`tab ${tabId}`);
  }
  if (title) {
    summaryParts.push(title);
  } else if (url) {
    summaryParts.push(url);
  }
  const summary = summaryParts.length > 0 ? summaryParts.join(" - ") : undefined;

  if (screenshotPath) {
    const dimensions = width && height ? `${width} x ${height}` : "preview";
    return {
      detail,
      summary: summary ?? "Browser screenshot captured.",
      imagePreview: {
        path: screenshotPath,
        width,
        height,
        caption: `Browser screenshot - ${dimensions}`
      }
    };
  }

  return { detail, summary };
}

export function browserActionLabel(action: string) {
  switch (action) {
    case "state":
      return "Read browser state";
    case "select_tab":
      return "Selected tab";
    case "open":
      return "Opened page";
    case "screenshot":
      return "Captured screenshot";
    case "snapshot":
      return "Read page snapshot";
    case "console":
      return "Read console";
    case "click":
      return "Clicked page";
    case "click_at":
      return "Clicked coordinates";
    case "type":
      return "Typed into page";
    default:
      return action;
  }
}

export function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function quoteActivityTarget(value?: string) {
  return value ? `"${truncateMiddle(value, 52)}"` : "target";
}

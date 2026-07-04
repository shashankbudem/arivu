import { randomUUID } from "node:crypto";
import { realpathSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CommandExecutionProfile } from "../execution/profile.js";
import { chatContentToText, type ChatContent } from "./content.js";
import { capabilityForToolName } from "./toolCapabilities.js";
import type {
  AgentLoopState,
  AgentRunEvent,
  AgentTaskRunFailedTest,
  AgentTaskRun,
  AgentTaskRunApprovalEvent,
  AgentTaskRunArtifact,
  AgentTaskRunCapability,
  AgentTaskRunCompletion,
  AgentTaskRunCompletionItem,
  AgentTaskRunCompletionItemStatus,
  AgentTaskRunPlan,
  AgentTaskRunPlanItem,
  AgentTaskRunPlanItemStatus,
  AgentTaskRunReportFinding,
  AgentTaskRunVerification,
  AgentTaskRunTestReport,
  AgentTaskRunStatus
} from "./types.js";

export { capabilityForToolName } from "./toolCapabilities.js";

export const MAX_TASK_RUNS_PER_SESSION = 100;
const MAX_COMMAND_STREAM_LENGTH = 8_000;
const MAX_PATCH_ARTIFACT_DIFF_LENGTH = 40_000;
const MAX_FILE_CHANGE_CONTENT_LENGTH = 40_000;
const MAX_COMMAND_REPORT_PATHS = 10;
const MAX_REPORT_FILE_BYTES = 2_000_000;
const MAX_REPORT_DETAIL_ITEMS = 10;
const MAX_REPORT_DETAIL_TEXT = 240;
const MAX_PLAN_ITEMS = 8;
const MAX_PLAN_ITEM_TEXT = 180;
const MAX_PLAN_SUMMARY_TEXT = 280;
const MAX_COMPLETION_ITEMS = 8;
const MAX_COMPLETION_ITEM_TEXT = 220;
const MAX_COMPLETION_SUMMARY_TEXT = 280;

type CreateAgentTaskRunOptions = {
  userMessageIndex: number;
  prompt: ChatContent;
  model?: string;
  providerName?: string;
  modelSelectionReason?: string;
  loop?: AgentLoopState;
  planModeEnabled?: boolean;
  worktreeEnabled?: boolean;
  now?: string;
};

type RecordTaskRunEventOptions = {
  workspaceRoot?: string;
};

type CommandArtifactInput = {
  id: string;
  title?: string;
  command: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  workingDirectory?: string;
  executionProfile?: CommandExecutionProfile;
  executionIsolation?: string;
  workspaceRoot?: string;
  now?: string;
};

export function createAgentTaskRun(options: CreateAgentTaskRunOptions): AgentTaskRun {
  const now = options.now ?? new Date().toISOString();
  return {
    id: randomUUID(),
    userMessageIndex: options.userMessageIndex,
    promptPreview: truncateRunText(chatContentToText(options.prompt), 180),
    status: "queued",
    model: options.model,
    providerName: options.providerName,
    modelSelectionReason: options.modelSelectionReason,
    loop: options.loop
      ? {
          enabled: true,
          maxIterations: options.loop.maxIterations
        }
      : undefined,
    planMode: options.planModeEnabled
      ? {
          enabled: true
        }
      : undefined,
    worktree: options.worktreeEnabled
      ? {
          enabled: true,
          status: "creating"
        }
      : undefined,
    capabilities: [],
    tools: [],
    approvals: [],
    artifacts: [],
    startedAt: now,
    updatedAt: now
  };
}

export function trimTaskRuns(runs: AgentTaskRun[] | undefined): AgentTaskRun[] | undefined {
  if (!runs || runs.length <= MAX_TASK_RUNS_PER_SESSION) {
    return runs;
  }
  return runs.slice(-MAX_TASK_RUNS_PER_SESSION);
}

export function markTaskRunRunning(run: AgentTaskRun, now = new Date().toISOString()) {
  if (run.status === "queued") {
    run.status = "running";
  }
  run.updatedAt = now;
}

export function recordTaskRunEvent(
  run: AgentTaskRun,
  event: AgentRunEvent,
  now = new Date().toISOString(),
  options: RecordTaskRunEventOptions = {}
): boolean {
  if (event.type === "tool_call_delta" || event.type === "assistant_delta") {
    return false;
  }

  markTaskRunRunning(run, now);

  if (event.type === "tool_call") {
    const capability = capabilityForToolName(event.call.name);
    const existing = run.tools.find((tool) => tool.toolCallId === event.call.id);
    if (existing) {
      existing.name = event.call.name;
      existing.arguments = event.call.arguments;
      existing.capability = capability;
      existing.status = existing.status === "done" ? "done" : "running";
      existing.startedAt = existing.startedAt || now;
    } else {
      run.tools.push({
        id: randomUUID(),
        toolCallId: event.call.id,
        name: event.call.name,
        arguments: event.call.arguments,
        capability,
        status: "running",
        startedAt: now
      });
    }
    addCapability(run, capability);
    run.updatedAt = now;
    return true;
  }

  const capability = capabilityForToolName(event.name);
  const existing = run.tools.find((tool) => tool.toolCallId === event.toolCallId);
  const tool =
    existing ??
    {
      id: randomUUID(),
      toolCallId: event.toolCallId,
      name: event.name,
      capability,
      status: "running" as const,
      startedAt: now
    };
  if (!existing) {
    run.tools.push(tool);
  }
  tool.name = event.name;
  tool.capability = capability;
  tool.status = "done";
  tool.completedAt = now;
  tool.durationMs = durationMsBetween(tool.startedAt, now);
  tool.resultPreview = truncateRunText(event.result, 700);
  addCapability(run, capability);

  const artifact = artifactFromToolResult(event.toolCallId, event.name, event.result, now, tool, options);
  if (artifact && !run.artifacts.some((candidate) => candidate.id === artifact.id)) {
    run.artifacts.push(artifact);
    tool.artifactIds = [...(tool.artifactIds ?? []), artifact.id];
  }

  run.updatedAt = now;
  return true;
}

export function upsertTaskRunCommandArtifact(run: AgentTaskRun, input: CommandArtifactInput): AgentTaskRunArtifact {
  const now = input.now ?? new Date().toISOString();
  const result = [
    input.exitCode === undefined ? undefined : `exitCode: ${input.exitCode}`,
    input.executionProfile ? `executionProfile: ${input.executionProfile}` : undefined,
    input.executionIsolation ? `executionIsolation: ${input.executionIsolation}` : undefined,
    input.workingDirectory ? `workingDirectory: ${input.workingDirectory}` : undefined,
    input.stdout !== undefined ? `stdout:\n${input.stdout}` : undefined,
    input.stderr !== undefined ? `stderr:\n${input.stderr}` : undefined
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  const artifact = {
    ...commandArtifactFromToolResult(input.id, result, now, {
      command: input.command,
      durationMs: input.durationMs,
      workspaceRoot: input.workspaceRoot
    }),
    title: input.title ?? "Command output"
  };
  const existingIndex = run.artifacts.findIndex((candidate) => candidate.id === artifact.id);
  if (existingIndex >= 0) {
    run.artifacts[existingIndex] = artifact;
  } else {
    run.artifacts.push(artifact);
  }
  run.updatedAt = now;
  return artifact;
}

export function finishTaskRun(run: AgentTaskRun, status: AgentTaskRunStatus, error?: string, now = new Date().toISOString()) {
  run.status = status;
  run.updatedAt = now;
  run.completedAt = now;
  if (error) {
    run.error = error;
    for (const tool of run.tools) {
      if (tool.status === "running") {
        tool.status = "failed";
        tool.completedAt = now;
      }
    }
  }
  run.verification = verificationFromTaskRun(run, now);
}

export function recordTaskRunApproval(run: AgentTaskRun, event: AgentTaskRunApprovalEvent, now = new Date().toISOString()): boolean {
  markTaskRunRunning(run, now);
  addCapability(run, event.capability);
  run.approvals ??= [];

  const timestamp = event.createdAt ?? now;
  const existing = run.approvals.find((approval) => approval.id === event.id);
  const isDecision = event.status === "allowed" || event.status === "approved" || event.status === "denied" || event.status === "blocked";

  if (existing) {
    existing.actionType = event.actionType;
    existing.capability = event.capability;
    existing.status = event.status;
    existing.trustMode = event.trustMode;
    existing.effect = event.effect;
    existing.label = event.label;
    existing.reason = event.reason;
    existing.risky = event.risky;
    existing.override = event.override;
    existing.scope = event.scope;
    existing.changePreview = event.changePreview;
    existing.summary = event.summary;
    existing.message = event.message;
    if (event.status === "requested") {
      existing.requestedAt = existing.requestedAt ?? timestamp;
    }
    if (isDecision) {
      existing.decidedAt = timestamp;
    }
    existing.updatedAt = now;
  } else {
    run.approvals.push({
      ...event,
      createdAt: timestamp,
      requestedAt: event.status === "requested" ? timestamp : undefined,
      decidedAt: isDecision ? timestamp : undefined,
      updatedAt: now
    });
  }

  run.updatedAt = now;
  return true;
}

export function recordTaskRunAssistantPlan(
  run: AgentTaskRun,
  content: ChatContent,
  now = new Date().toISOString(),
  sourceMessageIndex?: number
): boolean {
  const plan = parseAgentTaskRunPlan(chatContentToText(content), now, sourceMessageIndex);
  if (!plan) {
    return false;
  }
  run.plan = plan;
  run.updatedAt = now;
  return true;
}

export function recordTaskRunAssistantCompletion(
  run: AgentTaskRun,
  content: ChatContent,
  now = new Date().toISOString(),
  sourceMessageIndex?: number
): boolean {
  const completion = parseAgentTaskRunCompletion(chatContentToText(content), now, sourceMessageIndex);
  if (!completion) {
    return false;
  }
  run.completion = completion;
  run.updatedAt = now;
  return true;
}

export function parseAgentTaskRunPlan(
  text: string,
  now = new Date().toISOString(),
  sourceMessageIndex?: number
): AgentTaskRunPlan | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const heading = parsePlanHeading(lines[index]);
    if (!heading) {
      continue;
    }
    const parsed = collectPlanAfterHeading(lines, index + 1, heading.summary);
    if (parsed.items.length === 0) {
      continue;
    }
    return {
      summary: parsed.summary,
      items: parsed.items,
      sourceMessageIndex,
      updatedAt: now
    };
  }
  return undefined;
}

export function parseAgentTaskRunCompletion(
  text: string,
  now = new Date().toISOString(),
  sourceMessageIndex?: number
): AgentTaskRunCompletion | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const heading = parseCompletionHeading(lines[index]);
    if (!heading) {
      continue;
    }
    const parsed = collectCompletionAfterHeading(lines, index + 1, heading.summary);
    if (parsed.items.length === 0) {
      continue;
    }
    return {
      summary: parsed.summary,
      items: parsed.items,
      sourceMessageIndex,
      updatedAt: now
    };
  }
  return undefined;
}

function parsePlanHeading(line: string | undefined): { summary?: string } | undefined {
  const trimmed = stripMarkdownEmphasis(line?.trim() ?? "");
  if (!trimmed) {
    return undefined;
  }
  const match = /^(?:#{1,6}\s*)?(plan|approach|implementation plan|next steps|what i(?:'|\u2019)ll do)\s*:?\s*(.*)$/i.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const summary = truncatePlanText(cleanPlanText(match[2] ?? ""), MAX_PLAN_SUMMARY_TEXT);
  return { summary: summary || undefined };
}

function parseCompletionHeading(line: string | undefined): { summary?: string } | undefined {
  const trimmed = stripMarkdownEmphasis(line?.trim() ?? "");
  if (!trimmed) {
    return undefined;
  }
  const match = /^(?:#{1,6}\s*)?(completion notes?|plan completion|close-?out|closeout|completion)\s*:?\s*(.*)$/i.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const summary = truncatePlanText(cleanPlanText(match[2] ?? ""), MAX_COMPLETION_SUMMARY_TEXT);
  return { summary: summary || undefined };
}

function collectPlanAfterHeading(
  lines: string[],
  startIndex: number,
  initialSummary?: string
): { summary?: string; items: AgentTaskRunPlanItem[] } {
  const items: AgentTaskRunPlanItem[] = [];
  let summary = initialSummary;
  let sawContent = Boolean(initialSummary);

  for (let index = startIndex; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (!trimmed) {
      if (items.length > 0 || sawContent) {
        break;
      }
      continue;
    }
    if (items.length > 0 && isMarkdownHeading(trimmed)) {
      break;
    }

    const item = parsePlanItem(raw);
    if (item) {
      items.push(item);
      sawContent = true;
      if (items.length >= MAX_PLAN_ITEMS) {
        break;
      }
      continue;
    }

    if (!summary && items.length === 0) {
      summary = truncatePlanText(cleanPlanText(trimmed), MAX_PLAN_SUMMARY_TEXT);
      sawContent = true;
      continue;
    }

    if (items.length > 0) {
      break;
    }
  }

  return { summary, items };
}

function parsePlanItem(line: string): AgentTaskRunPlanItem | undefined {
  const match = /^\s*(?:[-*+]\s+(?:\[([ xX~\-])\]\s*)?|\d+[.)]\s+)(.+)$/.exec(line);
  if (!match) {
    return undefined;
  }
  const markerStatus = statusFromCheckbox(match[1]);
  const cleaned = cleanPlanText(match[2] ?? "");
  const status = markerStatus ?? statusFromPrefix(cleaned);
  const text = truncatePlanText(cleanPlanStatusPrefix(cleaned), MAX_PLAN_ITEM_TEXT);
  return text ? { text, status } : undefined;
}

function collectCompletionAfterHeading(
  lines: string[],
  startIndex: number,
  initialSummary?: string
): { summary?: string; items: AgentTaskRunCompletionItem[] } {
  const items: AgentTaskRunCompletionItem[] = [];
  let summary = initialSummary;
  let sawContent = Boolean(initialSummary);

  for (let index = startIndex; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (!trimmed) {
      if (items.length > 0 || sawContent) {
        break;
      }
      continue;
    }
    if (items.length > 0 && isMarkdownHeading(trimmed)) {
      break;
    }

    const item = parseCompletionItem(raw);
    if (item) {
      items.push(item);
      sawContent = true;
      if (items.length >= MAX_COMPLETION_ITEMS) {
        break;
      }
      continue;
    }

    if (!summary && items.length === 0) {
      summary = truncatePlanText(cleanPlanText(trimmed), MAX_COMPLETION_SUMMARY_TEXT);
      sawContent = true;
      continue;
    }

    if (items.length > 0) {
      break;
    }
  }

  return { summary, items };
}

function parseCompletionItem(line: string): AgentTaskRunCompletionItem | undefined {
  const match = /^\s*(?:[-*+]\s+(?:\[([ xX~!\-])\]\s*)?|\d+[.)]\s+)(.+)$/.exec(line);
  if (!match) {
    return undefined;
  }
  const markerStatus = completionStatusFromCheckbox(match[1]);
  const cleaned = cleanPlanText(match[2] ?? "");
  const status = markerStatus ?? completionStatusFromPrefix(cleaned);
  const text = truncatePlanText(cleanCompletionStatusPrefix(cleaned), MAX_COMPLETION_ITEM_TEXT);
  return text ? { text, status } : undefined;
}

function statusFromCheckbox(value: string | undefined): AgentTaskRunPlanItemStatus | undefined {
  if (!value) {
    return undefined;
  }
  if (/x/i.test(value)) {
    return "completed";
  }
  if (value === "~" || value === "-") {
    return "in_progress";
  }
  return "pending";
}

function completionStatusFromCheckbox(value: string | undefined): AgentTaskRunCompletionItemStatus | undefined {
  if (!value) {
    return undefined;
  }
  if (/x/i.test(value)) {
    return "completed";
  }
  if (value === "!" || value === "-") {
    return "blocked";
  }
  return "needs_followup";
}

function statusFromPrefix(value: string): AgentTaskRunPlanItemStatus | undefined {
  if (/^(?:done|completed)\s*:/i.test(value)) {
    return "completed";
  }
  if (/^(?:doing|in progress|working)\s*:/i.test(value)) {
    return "in_progress";
  }
  if (/^(?:todo|next|pending)\s*:/i.test(value)) {
    return "pending";
  }
  return undefined;
}

function completionStatusFromPrefix(value: string): AgentTaskRunCompletionItemStatus | undefined {
  if (/^(?:done|completed|supported)\s*:/i.test(value)) {
    return "completed";
  }
  if (/^(?:blocked|failed)\s*:/i.test(value)) {
    return "blocked";
  }
  if (/^(?:needs evidence|needs follow-?up|follow-?up|pending|todo|next)\s*:/i.test(value)) {
    return "needs_followup";
  }
  return undefined;
}

function cleanPlanStatusPrefix(value: string) {
  return value.replace(/^(?:done|completed|doing|in progress|working|todo|next|pending)\s*:\s*/i, "").trim();
}

function cleanCompletionStatusPrefix(value: string) {
  return value
    .replace(/^(?:done|completed|supported|blocked|failed|needs evidence|needs follow-?up|follow-?up|todo|next|pending)\s*:\s*/i, "")
    .trim();
}

function isMarkdownHeading(value: string) {
  return /^#{1,6}\s+\S/.test(value) || /^[A-Z][A-Za-z ]{0,40}:$/.test(stripMarkdownEmphasis(value));
}

function stripMarkdownEmphasis(value: string) {
  return value.replace(/^\*{1,2}(.+?)\*{1,2}$/g, "$1").trim();
}

function cleanPlanText(value: string) {
  return stripMarkdownEmphasis(value)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function truncatePlanText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function addCapability(run: AgentTaskRun, capability: AgentTaskRunCapability) {
  if (!run.capabilities.includes(capability)) {
    run.capabilities.push(capability);
  }
}

function artifactFromToolResult(
  toolCallId: string,
  toolName: string,
  result: string,
  now: string,
  tool?: { startedAt?: string; arguments?: unknown },
  options: RecordTaskRunEventOptions = {}
): AgentTaskRunArtifact | undefined {
  if (toolName === "run") {
    return commandArtifactFromToolResult(toolCallId, result, now, {
      command: commandTextFromArguments(tool?.arguments),
      durationMs: durationMsBetween(tool?.startedAt, now),
      workspaceRoot: options.workspaceRoot
    });
  }
  if (toolName === "apply_patch") {
    return patchArtifactFromToolResult(toolCallId, result, now, {
      diff: diffTextFromArguments(tool?.arguments)
    });
  }
  if (toolName === "write_file") {
    return fileChangeArtifactFromToolResult(toolCallId, result, now, writeFileArgsFromArguments(tool?.arguments));
  }

  const parsed = parseJsonObject(result);
  if (!parsed) {
    return undefined;
  }

  const screenshotPath = stringValue(parsed.screenshotPath);
  if (!screenshotPath) {
    return undefined;
  }

  const size = isRecord(parsed.size) ? parsed.size : undefined;
  const width = numberValue(size?.width);
  const height = numberValue(size?.height);
  const title = stringValue(parsed.title) ?? stringValue(parsed.url) ?? toolName;
  return {
    id: `${toolCallId}:browser_screenshot:${screenshotPath}`,
    kind: "browser_screenshot",
    title: "Browser screenshot",
    summary: title,
    path: screenshotPath,
    width,
    height,
    toolCallId,
    createdAt: now
  };
}

function fileChangeArtifactFromToolResult(
  toolCallId: string,
  result: string,
  now: string,
  args?: { path: string; content: string; mode: "create" | "replace" }
): AgentTaskRunArtifact | undefined {
  if (!args) {
    return undefined;
  }
  const resultMode = result.startsWith("Created ") ? "create" : result.startsWith("Replaced ") ? "replace" : undefined;
  if (!resultMode || resultMode !== args.mode) {
    return undefined;
  }

  const boundedContent = boundFileChangeContent(args.content);
  const lineCount = countContentLines(args.content);
  const modeLabel = args.mode === "create" ? "Created" : "Replaced";
  return {
    id: `${toolCallId}:file_change:${args.path}`,
    kind: "file_change",
    title: args.mode === "create" ? "File created" : "File replaced",
    summary: `${modeLabel} ${args.path} (${lineCount} line${lineCount === 1 ? "" : "s"}${boundedContent.truncated ? ", truncated" : ""})`,
    path: args.path,
    writeMode: args.mode,
    content: boundedContent.text,
    contentTruncated: boundedContent.truncated || undefined,
    lineCount,
    toolCallId,
    createdAt: now
  };
}

function patchArtifactFromToolResult(
  toolCallId: string,
  result: string,
  now: string,
  options: { diff?: string } = {}
): AgentTaskRunArtifact | undefined {
  const summary = result.match(/^Applied patch:\s*(.+)$/m)?.[1]?.trim();
  if (!summary || !options.diff) {
    return undefined;
  }

  const boundedDiff = boundPatchDiff(options.diff);
  const stats = patchStatsFromDiff(options.diff);
  return {
    id: `${toolCallId}:patch`,
    kind: "patch",
    title: "Patch applied",
    summary: patchArtifactSummary(summary, stats),
    diff: boundedDiff.text,
    diffTruncated: boundedDiff.truncated || undefined,
    changedPaths: stats.changedPaths.length > 0 ? stats.changedPaths : undefined,
    additions: stats.additions || undefined,
    deletions: stats.deletions || undefined,
    toolCallId,
    createdAt: now
  };
}

function commandArtifactFromToolResult(
  toolCallId: string,
  result: string,
  now: string,
  options: { command?: string; durationMs?: number; workspaceRoot?: string } = {}
): AgentTaskRunArtifact {
  const exitCode = numberFromMatch(result.match(/^exitCode:\s*(-?\d+)/m)?.[1]);
  const executionProfile = commandExecutionProfileFromResult(result);
  const executionIsolation = stringFromMatch(result.match(/^executionIsolation:\s*(.+)$/m)?.[1]);
  const workingDirectory = stringFromMatch(result.match(/^workingDirectory:\s*(.+)$/m)?.[1]);
  const stdout = extractCommandSection(result, "stdout");
  const stderr = extractCommandSection(result, "stderr");
  const boundedStdout = stdout === undefined ? undefined : boundCommandStream(stdout);
  const boundedStderr = stderr === undefined ? undefined : boundCommandStream(stderr);
  const reportPaths = detectReportPaths([options.command, stdout, stderr, result]);
  const testReports = parseTestReports(options.workspaceRoot, reportPaths);
  const summaryParts = [
    exitCode === undefined ? undefined : `Exit code ${exitCode}`,
    options.durationMs === undefined ? undefined : formatDuration(options.durationMs),
    testReports.length > 0
      ? `${testReports.length} parsed report${testReports.length === 1 ? "" : "s"}`
      : reportPaths.length > 0
        ? `${reportPaths.length} report path${reportPaths.length === 1 ? "" : "s"}`
        : undefined
  ].filter((part): part is string => Boolean(part));

  return {
    id: `${toolCallId}:command_output`,
    kind: "command_output",
    title: "Command output",
    summary: summaryParts.length > 0 ? summaryParts.join(" - ") : "Command output captured.",
    command: options.command,
    executionProfile,
    executionIsolation,
    workingDirectory,
    exitCode,
    durationMs: options.durationMs,
    stdout: boundedStdout?.text,
    stderr: boundedStderr?.text,
    stdoutTruncated: boundedStdout?.truncated || undefined,
    stderrTruncated: boundedStderr?.truncated || undefined,
    reportPaths: reportPaths.length > 0 ? reportPaths : undefined,
    testReports: testReports.length > 0 ? testReports : undefined,
    toolCallId,
    createdAt: now
  };
}

function commandExecutionProfileFromResult(result: string): CommandExecutionProfile | undefined {
  const value = stringFromMatch(result.match(/^executionProfile:\s*(.+)$/m)?.[1]);
  if (value === "host" || value === "container" || value === "sandbox") {
    return value;
  }
  return undefined;
}

function commandTextFromArguments(argumentsValue: unknown): string | undefined {
  if (!isRecord(argumentsValue)) {
    return undefined;
  }
  return stringValue(argumentsValue.command);
}

function diffTextFromArguments(argumentsValue: unknown): string | undefined {
  if (!isRecord(argumentsValue)) {
    return undefined;
  }
  return stringValue(argumentsValue.diff);
}

function writeFileArgsFromArguments(argumentsValue: unknown): { path: string; content: string; mode: "create" | "replace" } | undefined {
  if (!isRecord(argumentsValue)) {
    return undefined;
  }
  const filePath = stringValue(argumentsValue.path);
  const content = typeof argumentsValue.content === "string" ? argumentsValue.content : undefined;
  const mode = argumentsValue.mode;
  if (!filePath || content === undefined || (mode !== "create" && mode !== "replace")) {
    return undefined;
  }
  return { path: filePath, content, mode };
}

function boundPatchDiff(diff: string) {
  if (diff.length <= MAX_PATCH_ARTIFACT_DIFF_LENGTH) {
    return { text: diff, truncated: false };
  }
  return {
    text: Buffer.from(diff, "utf8").subarray(0, MAX_PATCH_ARTIFACT_DIFF_LENGTH).toString("utf8"),
    truncated: true
  };
}

function boundFileChangeContent(content: string) {
  if (content.length <= MAX_FILE_CHANGE_CONTENT_LENGTH) {
    return { text: content, truncated: false };
  }
  return {
    text: Buffer.from(content, "utf8").subarray(0, MAX_FILE_CHANGE_CONTENT_LENGTH).toString("utf8"),
    truncated: true
  };
}

function countContentLines(content: string) {
  if (content.length === 0) {
    return 0;
  }
  return content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
}

function patchStatsFromDiff(diff: string) {
  const changedPaths: string[] = [];
  let additions = 0;
  let deletions = 0;
  const lines = diff.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("--- ")) {
      const oldPath = cleanPatchArtifactPath(line.slice(4).trim());
      const next = lines[index + 1];
      if (next?.startsWith("+++ ")) {
        const newPath = cleanPatchArtifactPath(next.slice(4).trim());
        const changedPath = newPath === "/dev/null" ? oldPath : newPath;
        if (changedPath && changedPath !== "/dev/null" && !changedPaths.includes(changedPath)) {
          changedPaths.push(changedPath);
        }
      }
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { changedPaths, additions, deletions };
}

function cleanPatchArtifactPath(filePath: string) {
  if (filePath === "/dev/null") {
    return filePath;
  }
  return filePath.replace(/^[ab]\//, "");
}

function patchArtifactSummary(summary: string, stats: { changedPaths: string[]; additions: number; deletions: number }) {
  const statParts = [
    stats.changedPaths.length > 0 ? `${stats.changedPaths.length} file${stats.changedPaths.length === 1 ? "" : "s"}` : undefined,
    stats.additions > 0 ? `+${stats.additions}` : undefined,
    stats.deletions > 0 ? `-${stats.deletions}` : undefined
  ].filter((part): part is string => Boolean(part));
  return statParts.length > 0 ? `${summary} (${statParts.join(" ")})` : summary;
}

function verificationFromTaskRun(run: AgentTaskRun, now: string): AgentTaskRunVerification {
  const commandArtifacts = run.artifacts.filter((artifact) => artifact.kind === "command_output");
  const reports = commandArtifacts.flatMap((artifact) => artifact.testReports ?? []);
  const failedCommandCount = commandArtifacts.filter((artifact) => artifact.exitCode !== undefined && artifact.exitCode !== 0).length;
  const failedReportCount = reports.filter((report) => report.status === "failed").length;
  const passedReportCount = reports.filter((report) => report.status === "passed").length;
  const unknownReportCount = reports.filter((report) => report.status === "unknown").length;
  const status =
    failedCommandCount > 0 || failedReportCount > 0
      ? "failed"
      : commandArtifacts.length > 0 || reports.length > 0
        ? "passed"
        : "unknown";

  return {
    status,
    summary: verificationSummary({
      status,
      commandCount: commandArtifacts.length,
      failedCommandCount,
      parsedReportCount: reports.length,
      failedReportCount,
      passedReportCount,
      unknownReportCount
    }),
    commandCount: commandArtifacts.length,
    failedCommandCount,
    parsedReportCount: reports.length,
    failedReportCount,
    passedReportCount,
    unknownReportCount,
    updatedAt: now
  };
}

function verificationSummary(stats: Omit<AgentTaskRunVerification, "summary" | "updatedAt">) {
  if (stats.commandCount === 0 && stats.parsedReportCount === 0) {
    return "No command verification evidence captured.";
  }
  const parts = [
    `${stats.commandCount} command${stats.commandCount === 1 ? "" : "s"}`,
    stats.failedCommandCount > 0
      ? `${stats.failedCommandCount} failed exit${stats.failedCommandCount === 1 ? "" : "s"}`
      : stats.commandCount > 0
        ? "no failed exits"
        : undefined,
    stats.parsedReportCount > 0
      ? `${stats.parsedReportCount} parsed report${stats.parsedReportCount === 1 ? "" : "s"}`
      : undefined,
    stats.failedReportCount > 0
      ? `${stats.failedReportCount} failed report${stats.failedReportCount === 1 ? "" : "s"}`
      : undefined,
    stats.passedReportCount > 0
      ? `${stats.passedReportCount} passed report${stats.passedReportCount === 1 ? "" : "s"}`
      : undefined,
    stats.unknownReportCount > 0
      ? `${stats.unknownReportCount} unknown report${stats.unknownReportCount === 1 ? "" : "s"}`
      : undefined
  ].filter((part): part is string => Boolean(part));
  return `${verificationStatusLabel(stats.status)}: ${parts.join(", ")}.`;
}

function verificationStatusLabel(status: AgentTaskRunVerification["status"]) {
  switch (status) {
    case "passed":
      return "Verification passed";
    case "failed":
      return "Verification failed";
    case "unknown":
      return "Verification unknown";
  }
}

function stringFromMatch(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function durationMsBetween(startedAt?: string, completedAt?: string): number | undefined {
  if (!startedAt || !completedAt) {
    return undefined;
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }
  return end - start;
}

function numberFromMatch(value?: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractCommandSection(result: string, label: "stdout" | "stderr"): string | undefined {
  const marker = `${label}:\n`;
  const start = result.indexOf(marker);
  if (start < 0) {
    return undefined;
  }
  const contentStart = start + marker.length;
  const nextMarkers = ["\nstdout:\n", "\nstderr:\n"]
    .map((nextMarker) => result.indexOf(nextMarker, contentStart))
    .filter((index) => index >= 0);
  const end = nextMarkers.length > 0 ? Math.min(...nextMarkers) : result.length;
  return result.slice(contentStart, end).trimEnd();
}

function boundCommandStream(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_COMMAND_STREAM_LENGTH) {
    return { text: value, truncated: false };
  }
  return {
    text: value.slice(0, MAX_COMMAND_STREAM_LENGTH).trimEnd(),
    truncated: true
  };
}

function detectReportPaths(values: Array<string | undefined>): string[] {
  const found = new Set<string>();
  const text = values.filter((value): value is string => Boolean(value)).join("\n");
  const flagPattern =
    /--(?:junitxml|sarif|sarif-output|outputFile|output-file|reporter-output|report|report-dir|reportDir|coverageDirectory|coverage-directory|coverage-dir)(?:=|\s+)(["']?)([^"'\s]+)/gi;
  const reportPattern =
    /(?:^|[\s"'`(=:])([A-Za-z0-9._~/-]*(?:(?:junit|sarif|test-results|surefire-reports|reports|coverage|playwright-report|vitest-results)[A-Za-z0-9._~/-]*|TEST-[A-Za-z0-9._~-]+)\.(?:xml|json|html|lcov|info|txt|sarif))(?:$|[\s"'`),])/gim;

  for (const pattern of [flagPattern, reportPattern]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match && found.size < MAX_COMMAND_REPORT_PATHS) {
      const candidate = cleanReportPath(match[2] ?? match[1]);
      if (candidate) {
        found.add(candidate);
      }
      match = pattern.exec(text);
    }
  }

  return [...found];
}

function cleanReportPath(value?: string): string | undefined {
  const cleaned = value?.trim().replace(/^[("'`]+|[)"'`,.;:]+$/g, "");
  if (!cleaned || cleaned.length > 300 || /^https?:\/\//i.test(cleaned)) {
    return undefined;
  }
  if (/^(default|dot|html|json|junit|spec|tap|verbose)$/i.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}

function parseTestReports(workspaceRoot: string | undefined, reportPaths: string[]): AgentTaskRunTestReport[] {
  if (!workspaceRoot || reportPaths.length === 0) {
    return [];
  }

  const reports: AgentTaskRunTestReport[] = [];
  for (const reportPath of reportPaths) {
    if (reports.length >= MAX_COMMAND_REPORT_PATHS) {
      break;
    }
    const resolved = resolveReportFile(workspaceRoot, reportPath);
    if (!resolved) {
      continue;
    }
    const file = readBoundedReportFile(resolved);
    if (!file) {
      continue;
    }
    const parsed = parseReportContent(reportPath, file.content);
    if (parsed) {
      reports.push(parsed);
    }
  }
  return reports;
}

function resolveReportFile(workspaceRoot: string, reportPath: string): string | undefined {
  try {
    const rootRealPath = realpathSync(path.resolve(workspaceRoot));
    const resolved = path.resolve(rootRealPath, reportPath);
    const resolvedRealPath = realpathSync(resolved);
    if (resolvedRealPath !== rootRealPath && !resolvedRealPath.startsWith(`${rootRealPath}${path.sep}`)) {
      return undefined;
    }
    return resolvedRealPath;
  } catch {
    return undefined;
  }
}

function readBoundedReportFile(filePath: string): { content: string } | undefined {
  try {
    const fileStat = statSync(filePath);
    if (!fileStat.isFile() || fileStat.size > MAX_REPORT_FILE_BYTES) {
      return undefined;
    }
    return { content: readFileSync(filePath, "utf8") };
  } catch {
    return undefined;
  }
}

function parseReportContent(reportPath: string, content: string): AgentTaskRunTestReport | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }
  if (looksLikeSarif(reportPath, trimmed)) {
    return parseSarifReport(reportPath, trimmed);
  }
  if (looksLikeJUnit(reportPath, trimmed)) {
    return parseJUnitReport(reportPath, trimmed);
  }
  return undefined;
}

function looksLikeSarif(reportPath: string, content: string) {
  return /\.sarif(?:\.json)?$/i.test(reportPath) || /"version"\s*:\s*"2\.1\.0"/.test(content) || /"\$schema"\s*:\s*"[^"]*sarif/i.test(content);
}

function looksLikeJUnit(reportPath: string, content: string) {
  return /\.xml$/i.test(reportPath) && /<testsuites?\b/i.test(content);
}

function parseJUnitReport(reportPath: string, content: string): AgentTaskRunTestReport | undefined {
  const suiteAttrs = collectXmlTagAttributes(content, "testsuite");
  const rootAttrs = collectXmlTagAttributes(content, "testsuites")[0];
  const attrs = rootAttrs ?? undefined;
  const tests = attrs ? xmlNumberAttr(attrs, "tests") : sumXmlNumberAttrs(suiteAttrs, "tests");
  const failures = attrs ? xmlNumberAttr(attrs, "failures") : sumXmlNumberAttrs(suiteAttrs, "failures");
  const errors = attrs ? xmlNumberAttr(attrs, "errors") : sumXmlNumberAttrs(suiteAttrs, "errors");
  const skipped = attrs ? xmlNumberAttr(attrs, "skipped") : sumXmlNumberAttrs(suiteAttrs, "skipped");
  const durationSeconds = attrs ? xmlNumberAttr(attrs, "time") : sumXmlNumberAttrs(suiteAttrs, "time");
  const suites = rootAttrs ? xmlNumberAttr(rootAttrs, "testsuites") ?? suiteAttrs.length : suiteAttrs.length || undefined;

  if (tests === undefined && failures === undefined && errors === undefined && skipped === undefined) {
    return undefined;
  }

  const safeTests = tests ?? 0;
  const safeFailures = failures ?? 0;
  const safeErrors = errors ?? 0;
  const safeSkipped = skipped ?? 0;
  const status = safeFailures > 0 || safeErrors > 0 ? "failed" : safeTests > 0 ? "passed" : "unknown";
  const failedTests = collectJUnitFailedTests(content);
  const summaryParts = [
    `${safeTests} ${safeTests === 1 ? "test" : "tests"}`,
    safeFailures > 0 ? `${safeFailures} failed` : undefined,
    safeErrors > 0 ? `${safeErrors} errors` : undefined,
    safeSkipped > 0 ? `${safeSkipped} skipped` : undefined
  ].filter((part): part is string => Boolean(part));

  return {
    kind: "junit",
    path: reportPath,
    status,
    summary: summaryParts.join(", "),
    tests: safeTests,
    failures: safeFailures,
    errors: safeErrors,
    skipped: safeSkipped,
    suites,
    durationSeconds,
    failedTests: failedTests.length > 0 ? failedTests : undefined
  };
}

function collectJUnitFailedTests(content: string): AgentTaskRunFailedTest[] {
  const failedTests: AgentTaskRunFailedTest[] = [];
  const testcasePattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi;
  let match = testcasePattern.exec(content);
  while (match && failedTests.length < MAX_REPORT_DETAIL_ITEMS) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const failure = body.match(/<(failure|error)\b([^>]*)>/i);
    if (failure) {
      const name = xmlStringAttr(attrs, "name") ?? "(unnamed test)";
      const failureAttrs = failure[2] ?? "";
      failedTests.push({
        name: truncateDetailText(name),
        classname: truncateOptionalDetailText(xmlStringAttr(attrs, "classname") ?? xmlStringAttr(attrs, "class")),
        file: truncateOptionalDetailText(xmlStringAttr(attrs, "file")),
        line: positiveIntegerStringValue(xmlStringAttr(attrs, "line")),
        message: truncateOptionalDetailText(xmlStringAttr(failureAttrs, "message") ?? xmlStringAttr(failureAttrs, "type")),
        type: failure[1]?.toLowerCase() === "error" ? "error" : "failure"
      });
    }
    match = testcasePattern.exec(content);
  }
  return failedTests;
}

function collectXmlTagAttributes(content: string, tagName: string): string[] {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  const attrs: string[] = [];
  let match = pattern.exec(content);
  while (match) {
    attrs.push(match[1] ?? "");
    match = pattern.exec(content);
  }
  return attrs;
}

function xmlNumberAttr(attrs: string, name: string): number | undefined {
  const parsed = Number(xmlStringAttr(attrs, name));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function xmlStringAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match ? decodeXmlEntities(match[1]) : undefined;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function sumXmlNumberAttrs(attrs: string[], name: string): number | undefined {
  let sawValue = false;
  let total = 0;
  for (const attr of attrs) {
    const value = xmlNumberAttr(attr, name);
    if (value !== undefined) {
      sawValue = true;
      total += value;
    }
  }
  return sawValue ? total : undefined;
}

function parseSarifReport(reportPath: string, content: string): AgentTaskRunTestReport | undefined {
  const parsed = parseJsonObject(content);
  if (!parsed) {
    return undefined;
  }
  const runs = Array.isArray(parsed.runs) ? parsed.runs : [];
  let findings = 0;
  let errorFindings = 0;
  let warningFindings = 0;
  let noteFindings = 0;
  const rules = new Set<string>();
  const findingDetails: AgentTaskRunReportFinding[] = [];

  for (const run of runs) {
    if (!isRecord(run)) {
      continue;
    }
    const results = Array.isArray(run.results) ? run.results : [];
    for (const result of results) {
      if (!isRecord(result)) {
        continue;
      }
      findings += 1;
      const level = stringValue(result.level) ?? "warning";
      if (level === "error") {
        errorFindings += 1;
      } else if (level === "note" || level === "none") {
        noteFindings += 1;
      } else {
        warningFindings += 1;
      }
      const ruleId = stringValue(result.ruleId);
      if (ruleId) {
        rules.add(ruleId);
      }
      if (findingDetails.length < MAX_REPORT_DETAIL_ITEMS) {
        findingDetails.push(sarifFindingDetail(result, level));
      }
    }
  }

  const summaryParts = [
    `${findings} ${findings === 1 ? "finding" : "findings"}`,
    errorFindings > 0 ? `${errorFindings} errors` : undefined,
    warningFindings > 0 ? `${warningFindings} warnings` : undefined,
    noteFindings > 0 ? `${noteFindings} notes` : undefined
  ].filter((part): part is string => Boolean(part));

  return {
    kind: "sarif",
    path: reportPath,
    status: findings > 0 ? "failed" : "passed",
    summary: summaryParts.join(", "),
    findings,
    errorFindings,
    warningFindings,
    noteFindings,
    rules: rules.size,
    findingDetails: findingDetails.length > 0 ? findingDetails : undefined
  };
}

function sarifFindingDetail(result: Record<string, unknown>, levelValue: string): AgentTaskRunReportFinding {
  const location = firstSarifLocation(result);
  return {
    ruleId: truncateOptionalDetailText(stringValue(result.ruleId)),
    level: sarifLevel(levelValue),
    message: truncateOptionalDetailText(sarifMessageText(result.message)),
    path: truncateOptionalDetailText(location.path),
    line: location.line,
    column: location.column
  };
}

function firstSarifLocation(result: Record<string, unknown>): { path?: string; line?: number; column?: number } {
  const locations = Array.isArray(result.locations) ? result.locations : [];
  const firstLocation = locations.find(isRecord);
  const physicalLocation = isRecord(firstLocation?.physicalLocation) ? firstLocation.physicalLocation : undefined;
  const artifactLocation = isRecord(physicalLocation?.artifactLocation) ? physicalLocation.artifactLocation : undefined;
  const region = isRecord(physicalLocation?.region) ? physicalLocation.region : undefined;
  return {
    path: stringValue(artifactLocation?.uri),
    line: positiveIntegerValue(region?.startLine),
    column: positiveIntegerValue(region?.startColumn)
  };
}

function sarifMessageText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return stringValue(value.text) ?? stringValue(value.markdown);
}

function sarifLevel(value: string): AgentTaskRunReportFinding["level"] {
  if (value === "error" || value === "warning" || value === "note" || value === "none") {
    return value;
  }
  return undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function positiveIntegerStringValue(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function truncateOptionalDetailText(value?: string): string | undefined {
  return value ? truncateDetailText(value) : undefined;
}

function truncateDetailText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_REPORT_DETAIL_TEXT) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_REPORT_DETAIL_TEXT - 1).trimEnd()}...`;
}

function formatDuration(durationMs: number): string {
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

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncateRunText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

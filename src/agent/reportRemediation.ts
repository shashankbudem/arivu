import { chatContentToText } from "./content.js";
import type {
  AgentTaskRun,
  AgentTaskRunArtifact,
  AgentTaskRunReportFinding,
  AgentTaskRunTestReport,
  AgentTaskRunWorktreePullRequestReview,
  ChatMessage
} from "./types.js";

const MAX_REMEDIATION_REPORTS = 4;
const MAX_REMEDIATION_ITEMS_PER_REPORT = 6;
const MAX_REMEDIATION_TEXT = 360;
const MAX_REMEDIATION_STREAM_TEXT = 900;
const MAX_VERIFICATION_COMMANDS = 3;
export const REPORT_REMEDIATION_MARKER_PREFIX = "Arivu report remediation evidence artifact:";

export function buildReportRemediationPrompt(artifact: AgentTaskRunArtifact): string | undefined {
  if (artifact.kind !== "command_output" || !artifact.testReports?.length) {
    return undefined;
  }

  const reports = artifact.testReports.filter(reportHasRemediationEvidence).slice(0, MAX_REMEDIATION_REPORTS);
  if (!reports.length) {
    return undefined;
  }

  const lines = [
    "Use the report evidence below from the previous Arivu task run or loop iteration to fix the failing checks.",
    "Inspect the referenced files before editing. Keep the change narrowly scoped, then rerun the relevant test, lint, build, or scan command if possible.",
    "",
    "Report evidence:"
  ];

  for (const report of reports) {
    lines.push(...formatReportEvidence(report));
  }

  const stderr = boundedText(artifact.stderr, MAX_REMEDIATION_STREAM_TEXT);
  if (stderr) {
    lines.push("", "Relevant stderr excerpt:", stderr);
  }

  lines.push("", "When you reply, summarize the root cause, files changed, and verification result.");
  return lines.join("\n");
}

export function buildTaskRunReportRemediationInstruction(taskRun: AgentTaskRun | undefined, messages: ChatMessage[]): string | undefined {
  if (!taskRun?.artifacts.length) {
    return undefined;
  }

  const usedMarkers = new Set(
    messages
      .map((message) => chatContentToText(message.content))
      .filter((text) => text.includes(REPORT_REMEDIATION_MARKER_PREFIX))
  );
  const latest = [...taskRun.artifacts]
    .reverse()
    .map((artifact) => ({ artifact, prompt: buildReportRemediationPrompt(artifact) }))
    .find((candidate): candidate is { artifact: AgentTaskRunArtifact; prompt: string } => Boolean(candidate.prompt));
  if (!latest) {
    return undefined;
  }
  const marker = `${REPORT_REMEDIATION_MARKER_PREFIX} ${latest.artifact.id}`;
  if ([...usedMarkers].some((text) => text.includes(marker))) {
    return undefined;
  }
  return [
    marker,
    "",
    "The previous loop iteration produced failing structured report evidence.",
    "Use this evidence in the next iteration before deciding whether to continue, finish, or block.",
    "",
    latest.prompt
  ].join("\n");
}

export function buildTaskRunVerificationRepairPrompt(taskRun: AgentTaskRun): string | undefined {
  if (taskRun.verification?.status !== "failed" || !taskRun.worktree?.enabled || !taskRun.worktree.path || !taskRun.worktree.branch) {
    return undefined;
  }

  const commandArtifacts = taskRun.artifacts.filter((artifact) => artifact.kind === "command_output");
  const failedCommands = commandArtifacts.filter(
    (artifact) => (artifact.exitCode !== undefined && artifact.exitCode !== 0) || artifact.testReports?.some(reportHasRemediationEvidence)
  );
  const commandEvidence = failedCommands.slice(-MAX_VERIFICATION_COMMANDS);
  const reportPrompt = [...commandEvidence]
    .reverse()
    .map((artifact) => buildReportRemediationPrompt(artifact))
    .find((prompt): prompt is string => Boolean(prompt));

  const lines = [
    "Continue fixing the existing Arivu task worktree whose verification failed.",
    "Use the same isolated worktree for all reads, edits, and verification. Do not start a new task branch for this repair.",
    "",
    "Task worktree:",
    `- Previous run: ${taskRun.id}`,
    `- Branch: ${taskRun.worktree.branch}`,
    `- Path: ${taskRun.worktree.path}`,
    taskRun.worktree.originalRoot ? `- Original project: ${taskRun.worktree.originalRoot}` : undefined,
    taskRun.promptPreview ? `- Original request: ${boundedText(taskRun.promptPreview)}` : undefined,
    "",
    "Verification failure:",
    `- ${taskRun.verification.summary}`,
    "",
    "Repair steps:",
    "1. Inspect the failed command/report evidence below.",
    "2. Make the smallest necessary fix in the task worktree.",
    "3. Rerun the relevant test, lint, build, scan, or command.",
    "4. Summarize the root cause, files changed, and verification result."
  ].filter((line): line is string => line !== undefined);

  if (reportPrompt) {
    lines.push("", "Structured report evidence:", reportPrompt);
  } else if (commandEvidence.length > 0) {
    lines.push("", "Command evidence:");
    for (const artifact of commandEvidence) {
      lines.push(...formatCommandEvidence(artifact));
    }
  }

  return lines.join("\n");
}

export function buildTaskRunVerificationRerunPrompt(taskRun: AgentTaskRun, sourceRun?: AgentTaskRun): string | undefined {
  if (
    !taskRun.worktree?.enabled ||
    taskRun.worktree.status !== "ready" ||
    !taskRun.worktree.path ||
    !taskRun.worktree.branch ||
    !taskRun.worktree.continuedFromTaskRunId ||
    ["queued", "running"].includes(taskRun.status)
  ) {
    return undefined;
  }

  const verificationStatus = taskRun.verification?.status;
  if (verificationStatus && verificationStatus !== "unknown") {
    return undefined;
  }

  const commands = verificationCommandsFromRuns(taskRun, sourceRun);
  const sourceVerification = sourceRun?.verification;
  const lines = [
    "Continue the existing Arivu task worktree and rerun verification for the repair.",
    "Use the same isolated worktree for all reads and commands. Do not start a new task branch.",
    "",
    "Task worktree:",
    `- Current run: ${taskRun.id}`,
    `- Continued from: ${taskRun.worktree.continuedFromTaskRunId}`,
    sourceRun ? `- Original failed run: ${sourceRun.id}` : undefined,
    `- Branch: ${taskRun.worktree.branch}`,
    `- Path: ${taskRun.worktree.path}`,
    taskRun.worktree.originalRoot ? `- Original project: ${taskRun.worktree.originalRoot}` : undefined,
    "",
    "Why this is needed:",
    `- ${taskRun.verification?.summary ?? "No verification summary was captured for the repair run."}`,
    sourceVerification ? `- Previous verification: ${sourceVerification.summary}` : undefined,
    "",
    "Verification steps:",
    "1. Inspect the current task worktree changes if needed.",
    commands.length > 0
      ? "2. Rerun the relevant command(s) below, updating them only if the repo's scripts changed."
      : "2. Identify and run the smallest relevant test, lint, build, scan, or command for the repair.",
    "3. If verification fails, make the smallest necessary fix and rerun the failing check.",
    "4. Summarize the verification command, result, and any remaining risk."
  ].filter((line): line is string => line !== undefined);

  if (commands.length > 0) {
    lines.push("", "Suggested verification commands:");
    for (const command of commands) {
      lines.push(`- ${command}`);
    }
  }

  return lines.join("\n");
}

export function buildTaskRunVerificationReplayPrompt(evidenceRun: AgentTaskRun, targetRun: AgentTaskRun = evidenceRun): string | undefined {
  if (
    !targetRun.worktree?.enabled ||
    targetRun.worktree.status !== "ready" ||
    !targetRun.worktree.path ||
    !targetRun.worktree.branch ||
    ["queued", "running"].includes(targetRun.status)
  ) {
    return undefined;
  }

  const commands = verificationCommandsFromRuns(evidenceRun);
  if (!commands.length) {
    return undefined;
  }

  const lines = [
    "Continue the existing Arivu task worktree and replay verification from a prior repair attempt.",
    "Use the current managed worktree for all reads and commands. Do not start a new task branch.",
    "",
    "Task worktree:",
    `- Current run: ${targetRun.id}`,
    evidenceRun.id === targetRun.id ? undefined : `- Evidence run: ${evidenceRun.id}`,
    targetRun.worktree.continuedFromTaskRunId ? `- Current continued from: ${targetRun.worktree.continuedFromTaskRunId}` : undefined,
    `- Branch: ${targetRun.worktree.branch}`,
    `- Path: ${targetRun.worktree.path}`,
    targetRun.worktree.originalRoot ? `- Original project: ${targetRun.worktree.originalRoot}` : undefined,
    "",
    "Evidence attempt:",
    `- Prompt: ${boundedText(evidenceRun.promptPreview) || "(no prompt preview)"}`,
    evidenceRun.verification ? `- Verification: ${evidenceRun.verification.summary}` : "- Verification: none captured",
    "",
    "Replay steps:",
    "1. Inspect the current task worktree state if needed.",
    "2. Rerun the prior verification command(s) below, updating them only if the repo's scripts changed.",
    "3. If a command fails, make the smallest necessary fix and rerun the failing check.",
    "4. Summarize what changed since the evidence attempt, the command results, and any remaining risk.",
    "",
    "Verification commands:"
  ].filter((line): line is string => line !== undefined);

  for (const command of commands) {
    lines.push(`- ${command}`);
  }

  return lines.join("\n");
}

export function buildTaskRunPullRequestReviewPrompt(taskRun: AgentTaskRun): string | undefined {
  const worktree = taskRun.worktree;
  const pullRequest = worktree?.pullRequest;
  if (
    !worktree?.enabled ||
    worktree.status !== "ready" ||
    !worktree.path ||
    !worktree.branch ||
    !pullRequest?.url ||
    ["queued", "running"].includes(taskRun.status)
  ) {
    return undefined;
  }

  const commands = verificationCommandsFromRuns(taskRun);
  const lines = [
    "Continue the existing Arivu task worktree and review the created pull request.",
    "Use the same managed worktree for all reads, edits, and verification. Do not start a new task branch.",
    "",
    "Task worktree:",
    `- Current run: ${taskRun.id}`,
    worktree.continuedFromTaskRunId ? `- Continued from: ${worktree.continuedFromTaskRunId}` : undefined,
    `- Branch: ${worktree.branch}`,
    `- Path: ${worktree.path}`,
    worktree.originalRoot ? `- Original project: ${worktree.originalRoot}` : undefined,
    taskRun.promptPreview ? `- Original request: ${boundedText(taskRun.promptPreview)}` : undefined,
    "",
    "Pull request:",
    `- Title: ${pullRequest.title}`,
    `- URL: ${pullRequest.url}`,
    pullRequest.baseBranch ? `- Base branch: ${pullRequest.baseBranch}` : undefined,
    pullRequest.baseRef ? `- Base ref: ${pullRequest.baseRef}` : undefined,
    pullRequest.remoteName ? `- Remote: ${pullRequest.remoteName}` : undefined,
    pullRequest.remoteUrl ? `- Remote URL: ${pullRequest.remoteUrl}` : undefined,
    `- Commit: ${pullRequest.commit}`,
    "",
    "Last refreshed PR status:",
    ...(pullRequest.review
      ? formatPullRequestReviewEvidence(pullRequest.review)
      : ["- No Refresh PR snapshot is stored yet. Refresh or inspect the live PR before deciding whether feedback exists."]),
    "",
    "Current verification:",
    taskRun.verification ? `- ${taskRun.verification.summary}` : "- No verification summary was captured for this run.",
    "",
    "Review handoff steps:",
    "1. Use the last refreshed PR status as a starting point, then inspect live PR review comments and check results if GitHub access is available.",
    "2. Classify the outcome as requested changes, failed checks, informational comments, or no actionable review.",
    "3. If there is actionable feedback, make the smallest necessary fix in the existing task worktree.",
    "4. Rerun the focused checks that cover the feedback or failed status.",
    "5. Summarize the PR state, review outcome, files changed, verification result, and any remaining review risk."
  ].filter((line): line is string => line !== undefined);

  if (commands.length > 0) {
    lines.push("", "Suggested verification commands:");
    for (const command of commands) {
      lines.push(`- ${command}`);
    }
  } else {
    lines.push("", "Suggested verification:", "- Identify and run the smallest relevant test, lint, build, scan, or command for any PR feedback.");
  }

  lines.push("", "If PR or GitHub review details are not accessible, open or cite the PR URL and report the access blocker clearly.");
  return lines.join("\n");
}

function formatPullRequestReviewEvidence(review: AgentTaskRunWorktreePullRequestReview) {
  const counts = review.checks;
  return [
    `- Summary: ${review.summary}`,
    review.state ? `- State: ${review.state}` : undefined,
    review.isDraft !== undefined ? `- Draft: ${review.isDraft ? "yes" : "no"}` : undefined,
    review.reviewDecision ? `- Review decision: ${review.reviewDecision}` : undefined,
    review.mergeStateStatus ? `- Merge state: ${review.mergeStateStatus}` : undefined,
    `- Checks: ${review.checkSummary}`,
    `- Check counts: ${counts.passed} passed, ${counts.failed} failed, ${counts.pending} pending, ${counts.skipped} skipped, ${counts.cancelled} cancelled, ${counts.unknown} unknown, ${counts.total} total`,
    ...(review.checkItems?.length
      ? [
          "- Check evidence:",
          ...review.checkItems.map((item) => {
            const meta = [
              item.bucket,
              item.conclusion ? `conclusion ${item.conclusion}` : undefined,
              item.state ? `state ${item.state}` : undefined,
              item.status ? `status ${item.status}` : undefined
            ]
              .filter(Boolean)
              .join(", ");
            return `  - ${item.name}: ${meta}${item.detailsUrl ? ` (${item.detailsUrl})` : ""}`;
          })
        ]
      : []),
    review.feedback ? `- ${review.feedback.summary}` : undefined,
    review.feedback?.threadFetchError ? `- Review thread fetch unavailable: ${review.feedback.threadFetchError}` : undefined,
    ...(review.feedback?.items.length
      ? [
          "- Latest review feedback:",
          ...review.feedback.items.map((item) => {
            const meta = [
              item.kind,
              item.state,
              item.author ? `by ${item.author}` : undefined,
              item.path ? `at ${item.path}${item.line !== undefined ? `:${item.line}` : ""}` : undefined
            ]
              .filter(Boolean)
              .join(" ");
            return `  - ${meta}${item.body ? `: ${item.body}` : ""}`;
          })
        ]
      : []),
    `- Refreshed: ${review.updatedAt}`
  ].filter((line): line is string => line !== undefined);
}

export function buildTaskRunReplayFailureReviewPrompt(
  evidenceRun: AgentTaskRun,
  replayRuns: AgentTaskRun[],
  targetRun: AgentTaskRun
): string | undefined {
  if (
    !targetRun.worktree?.enabled ||
    targetRun.worktree.status !== "ready" ||
    !targetRun.worktree.path ||
    !targetRun.worktree.branch ||
    ["queued", "running"].includes(targetRun.status)
  ) {
    return undefined;
  }

  const failedReplayRuns = replayRuns
    .filter((run) => run.worktree?.replayOfTaskRunId === evidenceRun.id && run.verification?.status === "failed")
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
  if (failedReplayRuns.length < 2) {
    return undefined;
  }

  const commands = verificationCommandsFromRuns(failedReplayRuns.at(-1) ?? evidenceRun, evidenceRun);
  const commandEvidence = failedReplayRuns
    .flatMap((run) => run.artifacts.filter((artifact) => artifact.kind === "command_output"))
    .filter((artifact) => (artifact.exitCode !== undefined && artifact.exitCode !== 0) || artifact.testReports?.some(reportHasRemediationEvidence))
    .slice(-MAX_VERIFICATION_COMMANDS);
  const failingCommands = repeatedFailedCommands(failedReplayRuns);
  const latestFailure = failedReplayRuns.at(-1);

  const lines = [
    "Continue the existing Arivu task worktree and review repeated replay verification failures.",
    "Use the current managed worktree for all reads, edits, and commands. Do not start a new task branch.",
    "",
    "Task worktree:",
    `- Current run: ${targetRun.id}`,
    `- Evidence run: ${evidenceRun.id}`,
    targetRun.worktree.continuedFromTaskRunId ? `- Current continued from: ${targetRun.worktree.continuedFromTaskRunId}` : undefined,
    `- Branch: ${targetRun.worktree.branch}`,
    `- Path: ${targetRun.worktree.path}`,
    targetRun.worktree.originalRoot ? `- Original project: ${targetRun.worktree.originalRoot}` : undefined,
    "",
    "Evidence attempt:",
    `- Prompt: ${boundedText(evidenceRun.promptPreview) || "(no prompt preview)"}`,
    evidenceRun.verification ? `- Verification: ${evidenceRun.verification.summary}` : "- Verification: none captured",
    "",
    "Repeated replay failures:",
    ...failedReplayRuns.slice(-4).map((run) => `- ${run.id}: ${run.verification?.summary ?? "Verification failed without a summary."}`),
    "",
    "Failure pattern summary:",
    `- Failed replay attempts: ${failedReplayRuns.length}`,
    latestFailure ? `- Latest failed replay: ${latestFailure.id} - ${latestFailure.verification?.summary ?? "Verification failed without a summary."}` : undefined,
    failingCommands.length > 0 ? `- Repeated failing command(s): ${failingCommands.join(", ")}` : undefined,
    commands.length > 0 ? `- Best first command to reproduce: ${commands[0]}` : undefined,
    "",
    "Review steps:",
    "1. Compare the current worktree state against the evidence attempt and failed replay outcomes.",
    "2. Inspect the command/report evidence for the repeated failure.",
    "3. Decide whether this is a real remaining defect, a stale verification command, an environment issue, or a missing precondition.",
    "4. Make the smallest necessary fix when the failure is real; otherwise rerun the corrected verification and explain the adjustment.",
    "5. Summarize the root cause, files changed, verification command/result, and any remaining risk.",
    "",
    "Minimal verification plan:",
    commands.length > 0
      ? `1. Reproduce once with the smallest relevant command: ${commands[0]}`
      : "1. Identify and run the smallest relevant verification command for this failure.",
    "2. If it fails for a stale command, environment issue, or missing precondition, adjust that condition and rerun once.",
    "3. If it is a real defect, make the smallest fix and rerun the same command.",
    "4. Run broader checks only after the focused command passes or after explaining why it cannot be run."
  ].filter((line): line is string => line !== undefined);

  if (commands.length > 0) {
    lines.push("", "Suggested verification commands:");
    for (const command of commands) {
      lines.push(`- ${command}`);
    }
  }

  if (commandEvidence.length > 0) {
    lines.push("", "Failed replay command evidence:");
    for (const artifact of commandEvidence) {
      lines.push(...formatCommandEvidence(artifact));
    }
  }

  return lines.join("\n");
}

function repeatedFailedCommands(runs: AgentTaskRun[]) {
  const commands: string[] = [];
  for (const run of runs) {
    for (const artifact of run.artifacts) {
      if (
        artifact.kind !== "command_output" ||
        !artifact.command ||
        !((artifact.exitCode !== undefined && artifact.exitCode !== 0) || artifact.testReports?.some(reportHasRemediationEvidence))
      ) {
        continue;
      }
      const command = artifact.command.trim();
      if (command && !commands.includes(command)) {
        commands.push(command);
      }
      if (commands.length >= MAX_VERIFICATION_COMMANDS) {
        return commands;
      }
    }
  }
  return commands;
}

function reportHasRemediationEvidence(report: AgentTaskRunTestReport) {
  return report.status === "failed" || Boolean(report.failedTests?.length) || Boolean(report.findingDetails?.length);
}

function formatReportEvidence(report: AgentTaskRunTestReport) {
  const lines = [`- ${report.path}: ${report.kind.toUpperCase()} ${report.summary} (${report.status})`];
  for (const failure of report.failedTests?.slice(0, MAX_REMEDIATION_ITEMS_PER_REPORT) ?? []) {
    const label = [failure.classname, failure.name].filter(Boolean).join(".") || failure.name;
    const location = failure.file ? ` at ${failure.file}${failure.line ? `:${failure.line}` : ""}` : "";
    const message = boundedText(failure.message);
    lines.push(`  - failed test: ${label}${location}${message ? ` - ${message}` : ""}`);
  }
  for (const finding of report.findingDetails?.slice(0, MAX_REMEDIATION_ITEMS_PER_REPORT) ?? []) {
    lines.push(`  - finding: ${formatFinding(finding)}`);
  }
  return lines;
}

function formatFinding(finding: AgentTaskRunReportFinding) {
  const rule = finding.ruleId ?? "finding";
  const level = finding.level ? ` ${finding.level}` : "";
  const location = finding.path ? ` at ${finding.path}${finding.line ? `:${finding.line}${finding.column ? `:${finding.column}` : ""}` : ""}` : "";
  const message = boundedText(finding.message);
  return `${rule}${level}${location}${message ? ` - ${message}` : ""}`;
}

function formatCommandEvidence(artifact: AgentTaskRunArtifact) {
  const lines = [
    `- ${artifact.command ?? artifact.title}`,
    artifact.exitCode !== undefined ? `  - exit code: ${artifact.exitCode}` : undefined,
    artifact.workingDirectory ? `  - cwd: ${artifact.workingDirectory}` : undefined
  ].filter((line): line is string => line !== undefined);
  const stderr = boundedText(artifact.stderr, MAX_REMEDIATION_STREAM_TEXT);
  const stdout = boundedText(artifact.stdout, MAX_REMEDIATION_STREAM_TEXT);
  if (stderr) {
    lines.push(`  - stderr: ${stderr}`);
  }
  if (stdout) {
    lines.push(`  - stdout: ${stdout}`);
  }
  return lines;
}

function verificationCommandsFromRuns(taskRun: AgentTaskRun, sourceRun?: AgentTaskRun) {
  const artifacts = [...(sourceRun?.artifacts ?? []), ...taskRun.artifacts].filter((artifact) => artifact.kind === "command_output" && artifact.command);
  const prioritized = [
    ...artifacts.filter(
      (artifact) => (artifact.exitCode !== undefined && artifact.exitCode !== 0) || artifact.testReports?.some(reportHasRemediationEvidence)
    ),
    ...artifacts
  ];
  const commands: string[] = [];
  for (const artifact of prioritized) {
    const command = artifact.command?.trim();
    if (!command || commands.includes(command)) {
      continue;
    }
    commands.push(command);
    if (commands.length >= MAX_VERIFICATION_COMMANDS) {
      break;
    }
  }
  return commands;
}

function boundedText(value: string | undefined, limit = MAX_REMEDIATION_TEXT) {
  if (!value) {
    return "";
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

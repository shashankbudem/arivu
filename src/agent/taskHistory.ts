import type {
  AgentTaskRun,
  AgentTaskRunCompletionEvidenceKind,
  AgentTaskRunPlanItemStatus,
  AgentTaskRunPlanReviewStatus,
  AgentTaskRunVerificationStatus,
  AgentTaskRunWorktreePullRequestCheckItem
} from "./types.js";

export type AgentTaskRunChangeSummary = {
  pathCount: number;
  paths: string[];
  insertions?: number;
  deletions?: number;
  patchPreviewBytes?: number;
  patchPreviewTruncated?: boolean;
  patchArtifactCount: number;
  fileChangeArtifactCount: number;
  sourcesByPath: Record<string, string[]>;
};

export type AgentTaskRunPathDelta = {
  path: string;
  state: "added" | "removed" | "shared";
  leftSources: string[];
  rightSources: string[];
};

export type AgentTaskRunDiffComparison = {
  left: AgentTaskRunChangeSummary;
  right: AgentTaskRunChangeSummary;
  added: string[];
  removed: string[];
  shared: string[];
  pathDeltas: AgentTaskRunPathDelta[];
};

export type AgentTaskRunReplayOutcome = {
  runId: string;
  promptPreview?: string;
  status: AgentTaskRun["status"];
  verificationStatus?: AgentTaskRunVerificationStatus;
  verificationSummary?: string;
  updatedAt: string;
};

export type AgentTaskRunReplayOutcomeGroup = {
  evidenceRunId: string;
  evidencePromptPreview?: string;
  evidenceVerificationStatus?: AgentTaskRunVerificationStatus;
  outcomes: AgentTaskRunReplayOutcome[];
  failedOutcomeCount: number;
  passedOutcomeCount: number;
  unknownOutcomeCount: number;
  latestOutcome?: AgentTaskRunReplayOutcome;
};

export type AgentTaskRunPullRequestReadinessStatus = "ready" | "blocked" | "waiting" | "unknown";

export type AgentTaskRunPullRequestReadiness = {
  status: AgentTaskRunPullRequestReadinessStatus;
  label: string;
  summary: string;
  reasons: string[];
};

export type AgentTaskRunPlanSourceCueStatus = "passed" | "warning" | "failed";

export type AgentTaskRunPlanSourceCue = {
  status: AgentTaskRunPlanSourceCueStatus;
  text: string;
};

export type AgentTaskRunPlanCompletionStatus = "supported" | "needs_evidence" | "blocked";

export type AgentTaskRunPlanCompletionNote = {
  text: string;
  planStatus?: AgentTaskRunPlanItemStatus;
  status: AgentTaskRunPlanCompletionStatus;
  matchedPaths: string[];
  matchedCommands: string[];
  matchedReports: string[];
  matchedChecks: string[];
  matchedCompletionNotes: string[];
  matchedCompletionEvidence: string[];
  evidence: string[];
};

export type AgentTaskRunPlanSourceReview = {
  sourceRunId: string;
  sourceFound: boolean;
  sourcePromptPreview?: string;
  reviewStatus?: AgentTaskRunPlanReviewStatus;
  reviewUpdatedAt?: string;
  planSummary?: string;
  planItems: Array<{ text: string; status?: string }>;
  planStepCount: number;
  completedPlanStepCount: number;
  changedPathCount: number;
  changedPaths: string[];
  patchPreviewReady: boolean;
  verificationStatus?: AgentTaskRunVerificationStatus;
  verificationSummary?: string;
  completionStatus: AgentTaskRunPlanCompletionStatus;
  completionSummary: string;
  completionNotes: AgentTaskRunPlanCompletionNote[];
  cues: AgentTaskRunPlanSourceCue[];
};

export function buildTaskRunDiffComparison(leftRun: AgentTaskRun, rightRun: AgentTaskRun): AgentTaskRunDiffComparison {
  const left = taskRunChangeSummary(leftRun);
  const right = taskRunChangeSummary(rightRun);
  const leftPaths = new Set(left.paths);
  const rightPaths = new Set(right.paths);
  const added = right.paths.filter((changedPath) => !leftPaths.has(changedPath));
  const removed = left.paths.filter((changedPath) => !rightPaths.has(changedPath));
  const shared = right.paths.filter((changedPath) => leftPaths.has(changedPath));
  const allPaths = [...new Set([...added, ...removed, ...shared])].sort((a, b) => a.localeCompare(b));

  return {
    left,
    right,
    added,
    removed,
    shared,
    pathDeltas: allPaths.map((changedPath) => ({
      path: changedPath,
      state: leftPaths.has(changedPath) && rightPaths.has(changedPath) ? "shared" : rightPaths.has(changedPath) ? "added" : "removed",
      leftSources: left.sourcesByPath[changedPath] ?? [],
      rightSources: right.sourcesByPath[changedPath] ?? []
    }))
  };
}

export function buildTaskRunPullRequestReadiness(
  review: NonNullable<NonNullable<AgentTaskRun["worktree"]>["pullRequest"]>["review"] | undefined
): AgentTaskRunPullRequestReadiness {
  if (!review) {
    return {
      status: "unknown",
      label: "Refresh needed",
      summary: "Refresh PR to derive review, merge, and check readiness.",
      reasons: ["No refreshed PR snapshot is stored yet."]
    };
  }

  const state = normalizePrToken(review.state);
  const reviewDecision = normalizePrToken(review.reviewDecision);
  const mergeState = normalizePrToken(review.mergeStateStatus);
  const checks = review.checks;
  const reasons: string[] = [];

  if (state && state !== "OPEN") {
    if (state === "MERGED") {
      return {
        status: "ready",
        label: "Merged",
        summary: "This pull request is already merged.",
        reasons: ["PR state is merged."]
      };
    }
    return {
      status: "blocked",
      label: "Not mergeable",
      summary: `PR is ${formatPrReadinessToken(state)}, not open.`,
      reasons: [`PR state is ${formatPrReadinessToken(state)}.`]
    };
  }

  if (review.isDraft === true) {
    reasons.push("PR is still a draft.");
  }
  if (reviewDecision === "CHANGES_REQUESTED") {
    reasons.push("Review changes are requested.");
  } else if (reviewDecision === "REVIEW_REQUIRED") {
    reasons.push("Review approval is still required.");
  } else if (reviewDecision && reviewDecision !== "APPROVED") {
    reasons.push(`Review decision is ${formatPrReadinessToken(reviewDecision)}.`);
  }
  if (mergeState && ["BLOCKED", "DIRTY", "BEHIND", "DRAFT", "UNKNOWN"].includes(mergeState)) {
    reasons.push(`Merge state is ${formatPrReadinessToken(mergeState)}.`);
  } else if (mergeState && !["CLEAN", "HAS_HOOKS"].includes(mergeState)) {
    reasons.push(`Merge state is ${formatPrReadinessToken(mergeState)}.`);
  }
  if (checks.failed > 0) {
    reasons.push(`${checks.failed} check${checks.failed === 1 ? "" : "s"} failed.`);
  }
  if (checks.cancelled > 0) {
    reasons.push(`${checks.cancelled} check${checks.cancelled === 1 ? "" : "s"} cancelled.`);
  }
  if (checks.pending > 0) {
    reasons.push(`${checks.pending} check${checks.pending === 1 ? "" : "s"} pending.`);
  }
  if (checks.unknown > 0) {
    reasons.push(`${checks.unknown} check${checks.unknown === 1 ? "" : "s"} unknown.`);
  }
  if (checks.total === 0) {
    reasons.push("No checks were reported.");
  }

  const blockingReasons = reasons.filter(
    (reason) =>
      reason.includes("failed") ||
      reason.includes("cancelled") ||
      reason.includes("changes are requested") ||
      reason.includes("Merge state is blocked") ||
      reason.includes("Merge state is dirty") ||
      reason.includes("Merge state is behind") ||
      reason.includes("Merge state is draft")
  );
  if (blockingReasons.length > 0) {
    return {
      status: "blocked",
      label: "Blocked",
      summary: blockingReasons[0],
      reasons
    };
  }

  if (reasons.length > 0) {
    return {
      status: "waiting",
      label: "Waiting",
      summary: reasons[0],
      reasons
    };
  }

  if (reviewDecision === "APPROVED" && (mergeState === "CLEAN" || mergeState === "HAS_HOOKS")) {
    return {
      status: "ready",
      label: "Ready to merge",
      summary: "Approved, mergeable, and checks are settled.",
      reasons: [review.checkSummary]
    };
  }

  return {
    status: "unknown",
    label: "Needs review",
    summary: "Refresh or inspect the PR before deciding whether it is ready to merge.",
    reasons: [review.summary]
  };
}

function normalizePrToken(value?: string) {
  return value?.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function formatPrReadinessToken(value: string) {
  return value.toLowerCase().replace(/_/g, " ");
}

export function buildTaskRunPlanSourceReview(run: AgentTaskRun, sourceRun?: AgentTaskRun): AgentTaskRunPlanSourceReview | undefined {
  const sourceRunId = run.worktree?.plannedFromTaskRunId;
  if (!sourceRunId) {
    return undefined;
  }

  const changeSummary = taskRunChangeSummary(run);
  const planItems = sourceRun?.plan?.items ?? [];
  const cues: AgentTaskRunPlanSourceCue[] = [];

  if (!sourceRun) {
    cues.push({ status: "failed", text: "Approved plan source is missing from this saved session." });
  } else if (sourceRun.planReview?.status !== "approved") {
    cues.push({ status: "failed", text: "Source plan is not currently approved." });
  } else {
    cues.push({ status: "passed", text: "Source plan was approved before this worktree started." });
  }

  if (sourceRun && !sourceRun.plan) {
    cues.push({ status: "warning", text: "Source run does not include a captured plan." });
  } else if (planItems.length === 0) {
    cues.push({ status: "warning", text: "Source plan has no checklist items." });
  }

  if (changeSummary.pathCount === 0) {
    cues.push({ status: "warning", text: "No changed files have been recorded yet." });
  } else {
    cues.push({ status: "passed", text: `${changeSummary.pathCount} changed file${changeSummary.pathCount === 1 ? "" : "s"} recorded.` });
  }

  if (run.worktree?.patchPreview) {
    cues.push({ status: "passed", text: "Patch preview is available for review." });
  } else {
    cues.push({ status: "warning", text: "Generate a patch preview before promotion." });
  }

  if (run.verification?.status === "passed") {
    cues.push({ status: "passed", text: "Verification passed for this worktree run." });
  } else if (run.verification?.status === "failed") {
    cues.push({ status: "failed", text: "Verification failed for this worktree run." });
  } else {
    cues.push({ status: "warning", text: "Verification has not passed yet." });
  }

  const completion = buildPlanCompletionReview(run, sourceRun, changeSummary);

  return {
    sourceRunId,
    sourceFound: Boolean(sourceRun),
    sourcePromptPreview: sourceRun?.promptPreview || undefined,
    reviewStatus: sourceRun?.planReview?.status,
    reviewUpdatedAt: sourceRun?.planReview?.updatedAt,
    planSummary: sourceRun?.plan?.summary,
    planItems: planItems.map((item) => ({ text: item.text, status: item.status })),
    planStepCount: planItems.length,
    completedPlanStepCount: planItems.filter((item) => item.status === "completed").length,
    changedPathCount: changeSummary.pathCount,
    changedPaths: changeSummary.paths,
    patchPreviewReady: Boolean(run.worktree?.patchPreview),
    verificationStatus: run.verification?.status,
    verificationSummary: run.verification?.summary,
    completionStatus: completion.status,
    completionSummary: completion.summary,
    completionNotes: completion.notes,
    cues
  };
}

function buildPlanCompletionReview(
  run: AgentTaskRun,
  sourceRun: AgentTaskRun | undefined,
  changeSummary: AgentTaskRunChangeSummary
): { status: AgentTaskRunPlanCompletionStatus; summary: string; notes: AgentTaskRunPlanCompletionNote[] } {
  if (!sourceRun) {
    return {
      status: "needs_evidence",
      summary: "Cannot close out the approved plan because the source task run is missing.",
      notes: []
    };
  }

  const planItems = sourceRun.plan?.items ?? [];
  if (planItems.length === 0) {
    return {
      status: "needs_evidence",
      summary: "Source plan has no checklist items to close out.",
      notes: []
    };
  }

  const patchPreviewReady = Boolean(run.worktree?.patchPreview);
  const baseStatus = planCompletionBaseStatus(run, changeSummary, patchPreviewReady);
  const runEvidence = planCompletionEvidence(run, changeSummary, patchPreviewReady);
  const notes = planItems.map((item) => {
    const matches = matchPlanItemEvidence(item.text, run, changeSummary);
    const status = planCompletionItemStatus(baseStatus, matches);
    return {
      text: item.text,
      planStatus: item.status,
      status,
      matchedPaths: matches.paths,
      matchedCommands: matches.commands,
      matchedReports: matches.reports,
      matchedChecks: matches.checks,
      matchedCompletionNotes: matches.completionNotes,
      matchedCompletionEvidence: matches.completionEvidence,
      evidence: planCompletionNoteEvidence(runEvidence, matches, baseStatus)
    };
  });
  const status = planCompletionOverallStatus(baseStatus, notes);

  return {
    status,
    summary: planCompletionSummary(status, baseStatus, run, changeSummary, patchPreviewReady, notes),
    notes
  };
}

function planCompletionBaseStatus(
  run: AgentTaskRun,
  changeSummary: AgentTaskRunChangeSummary,
  patchPreviewReady: boolean
): AgentTaskRunPlanCompletionStatus {
  if (run.verification?.status === "failed") {
    return "blocked";
  }
  if (run.verification?.status !== "passed") {
    return "needs_evidence";
  }
  if (changeSummary.pathCount === 0 || !patchPreviewReady) {
    return "needs_evidence";
  }
  return "supported";
}

function planCompletionItemStatus(
  baseStatus: AgentTaskRunPlanCompletionStatus,
  matches: {
    paths: string[];
    commands: string[];
    reports: string[];
    checks: string[];
    completionNotes: string[];
    completionEvidence: string[];
    completionStatus?: NonNullable<AgentTaskRun["completion"]>["items"][number]["status"];
  }
): AgentTaskRunPlanCompletionStatus {
  if (baseStatus !== "supported") {
    return baseStatus;
  }
  if (matches.completionStatus === "blocked") {
    return "blocked";
  }
  if (matches.completionStatus === "needs_followup") {
    return "needs_evidence";
  }
  return matches.paths.length > 0 ||
    matches.commands.length > 0 ||
    matches.reports.length > 0 ||
    matches.checks.length > 0 ||
    matches.completionNotes.length > 0 ||
    matches.completionEvidence.length > 0
    ? "supported"
    : "needs_evidence";
}

function planCompletionOverallStatus(
  baseStatus: AgentTaskRunPlanCompletionStatus,
  notes: AgentTaskRunPlanCompletionNote[]
): AgentTaskRunPlanCompletionStatus {
  if (baseStatus !== "supported") {
    return baseStatus;
  }
  return notes.every((note) => note.status === "supported") ? "supported" : "needs_evidence";
}

function planCompletionSummary(
  status: AgentTaskRunPlanCompletionStatus,
  baseStatus: AgentTaskRunPlanCompletionStatus,
  run: AgentTaskRun,
  changeSummary: AgentTaskRunChangeSummary,
  patchPreviewReady: boolean,
  notes: AgentTaskRunPlanCompletionNote[]
) {
  if (baseStatus === "blocked") {
    return "Plan completion is blocked by failed verification. Fix or rerun checks before promotion.";
  }
  if (run.verification?.status !== "passed") {
    return "Plan completion needs passed verification evidence before promotion.";
  }
  if (changeSummary.pathCount === 0) {
    return "Verification passed, but no changed files are recorded for this plan-derived worktree.";
  }
  if (!patchPreviewReady) {
    return "Verification passed, but generate a patch preview before closing out the approved plan.";
  }
  const supportedCount = notes.filter((note) => note.status === "supported").length;
  if (status === "supported") {
    return "All planned steps have item-specific evidence, verification passed, and a patch preview is ready.";
  }
  if (supportedCount > 0) {
    return `${supportedCount}/${notes.length} planned step${notes.length === 1 ? "" : "s"} have item-specific evidence. Remaining steps need matching file, command, report, check, or completion-note evidence before close-out.`;
  }
  return "Verification passed and the patch preview is ready, but no planned step has item-specific evidence yet.";
}

function planCompletionEvidence(run: AgentTaskRun, changeSummary: AgentTaskRunChangeSummary, patchPreviewReady: boolean) {
  const verification = run.verification;
  const evidence: string[] = [];

  if (verification?.status === "passed") {
    evidence.push("Verification passed");
  } else if (verification?.status === "failed") {
    evidence.push(`Verification failed: ${verification.summary}`);
  } else if (verification?.status === "unknown") {
    evidence.push(`Verification unknown: ${verification.summary}`);
  } else {
    evidence.push("No verification summary captured");
  }

  evidence.push(
    changeSummary.pathCount === 0
      ? "No changed files recorded"
      : `${changeSummary.pathCount} changed file${changeSummary.pathCount === 1 ? "" : "s"} recorded`
  );
  evidence.push(patchPreviewReady ? "Patch preview ready" : "Patch preview not generated");
  return evidence;
}

function planCompletionNoteEvidence(
  runEvidence: string[],
  matches: {
    paths: string[];
    commands: string[];
    reports: string[];
    checks: string[];
    completionNotes: string[];
    completionEvidence: string[];
  },
  baseStatus: AgentTaskRunPlanCompletionStatus
) {
  const evidence = [...runEvidence];
  if (matches.paths.length > 0) {
    evidence.push(`${matches.paths.length === 1 ? "Matched file" : "Matched files"}: ${matches.paths.slice(0, 3).join(", ")}`);
  }
  if (matches.commands.length > 0) {
    evidence.push(`${matches.commands.length === 1 ? "Matched command" : "Matched commands"}: ${matches.commands.slice(0, 2).join(", ")}`);
  }
  if (matches.reports.length > 0) {
    evidence.push(`${matches.reports.length === 1 ? "Matched report" : "Matched reports"}: ${matches.reports.slice(0, 2).join(", ")}`);
  }
  if (matches.checks.length > 0) {
    evidence.push(`${matches.checks.length === 1 ? "Matched PR check" : "Matched PR checks"}: ${matches.checks.slice(0, 2).join(", ")}`);
  }
  if (matches.completionNotes.length > 0) {
    evidence.push(
      `${matches.completionNotes.length === 1 ? "Assistant completion note" : "Assistant completion notes"}: ${matches.completionNotes
        .slice(0, 2)
        .join(", ")}`
    );
  }
  if (matches.completionEvidence.length > 0) {
    evidence.push(
      `${matches.completionEvidence.length === 1 ? "Assistant evidence label" : "Assistant evidence labels"}: ${matches.completionEvidence
        .slice(0, 3)
        .join(", ")}`
    );
  }
  if (
    baseStatus === "supported" &&
    matches.paths.length === 0 &&
    matches.commands.length === 0 &&
    matches.reports.length === 0 &&
    matches.checks.length === 0 &&
    matches.completionNotes.length === 0 &&
    matches.completionEvidence.length === 0
  ) {
    evidence.push("No item-specific file, command, report, check, or completion note match yet");
  }
  return evidence;
}

function matchPlanItemEvidence(itemText: string, run: AgentTaskRun, changeSummary: AgentTaskRunChangeSummary) {
  const itemTokens = planEvidenceTokens(itemText);
  if (itemTokens.length === 0) {
    return { paths: [], commands: [], reports: [], checks: [], completionNotes: [], completionEvidence: [] };
  }

  const paths = changeSummary.paths.filter((changedPath) => evidenceTextMatches(itemTokens, changedPath)).slice(0, 4);
  const commands = run.artifacts
    .filter((artifact) => artifact.kind === "command_output")
    .filter((artifact) => evidenceTextMatches(itemTokens, commandEvidenceText(artifact)))
    .map((artifact) => truncateEvidenceLabel(artifact.command ?? artifact.title))
    .filter((command): command is string => Boolean(command))
    .slice(0, 3);
  const reports = run.artifacts
    .filter((artifact) => artifact.kind === "command_output")
    .flatMap((artifact) => reportEvidenceCandidates(artifact))
    .filter((candidate) => evidenceTextMatches(itemTokens, candidate.text))
    .map((candidate) => candidate.label)
    .slice(0, 3);
  const checks = (run.worktree?.pullRequest?.review?.checkItems ?? [])
    .filter((check) => evidenceTextMatches(itemTokens, pullRequestCheckEvidenceText(check)))
    .map((check) => truncateEvidenceLabel(`${check.name}: ${check.bucket}`))
    .filter((check): check is string => Boolean(check))
    .slice(0, 3);
  const completionItems = (run.completion?.items ?? []).filter((item) => evidenceTextMatches(itemTokens, item.text)).slice(0, 3);
  const completionNotes = completionItems.map((item) => truncateEvidenceLabel(item.text)).filter((note): note is string => Boolean(note));
  const completionEvidence = completionItems
    .flatMap((item) => item.evidence ?? [])
    .map((item) => completionEvidenceLabel(item.kind, item.value))
    .filter((label): label is string => Boolean(label))
    .slice(0, 6);
  const completionStatus = completionStatusFromItems(completionItems);

  return { paths, commands, reports, checks, completionNotes, completionEvidence, completionStatus };
}

function completionEvidenceLabel(kind: AgentTaskRunCompletionEvidenceKind, value: string) {
  return truncateEvidenceLabel(`${kind} ${value}`);
}

function completionStatusFromItems(
  items: NonNullable<AgentTaskRun["completion"]>["items"]
): NonNullable<AgentTaskRun["completion"]>["items"][number]["status"] | undefined {
  if (items.some((item) => item.status === "blocked")) {
    return "blocked";
  }
  if (items.some((item) => item.status === "needs_followup")) {
    return "needs_followup";
  }
  if (items.some((item) => item.status === "completed")) {
    return "completed";
  }
  return undefined;
}

function commandEvidenceText(artifact: AgentTaskRun["artifacts"][number]) {
  return [artifact.command, artifact.title, artifact.summary, ...(artifact.reportPaths ?? [])].filter(Boolean).join(" ");
}

function reportEvidenceCandidates(artifact: AgentTaskRun["artifacts"][number]) {
  return (artifact.testReports ?? [])
    .map((report) => {
      const details = [
        report.path,
        report.summary,
        ...(report.failedTests ?? []).flatMap((test) => [test.name, test.classname, test.file, test.message]),
        ...(report.findingDetails ?? []).flatMap((finding) => [finding.ruleId, finding.message, finding.path])
      ]
        .filter((part): part is string => Boolean(part))
        .join(" ");
      const label = truncateEvidenceLabel(`${report.path}: ${report.summary}`);
      return label ? { label, text: details } : undefined;
    })
    .filter((candidate): candidate is { label: string; text: string } => Boolean(candidate));
}

function pullRequestCheckEvidenceText(check: AgentTaskRunWorktreePullRequestCheckItem) {
  return [
    check.name,
    check.bucket,
    check.status,
    check.conclusion,
    check.state,
    check.detailsUrl,
    check.logCommand,
    check.logArtifactId,
    check.logError
  ]
    .filter(Boolean)
    .join(" ");
}

function evidenceTextMatches(itemTokens: string[], sourceText: string) {
  const sourceTokens = new Set(planEvidenceTokens(sourceText));
  const source = normalizeEvidenceText(sourceText);
  return itemTokens.some((token) => sourceTokens.has(token) || source.includes(token));
}

function planEvidenceTokens(value: string) {
  const normalized = normalizeEvidenceText(value);
  return [
    ...new Set(
      normalized
        .split(/\s+/)
        .map((token) => singularizeEvidenceToken(token))
        .filter((token) => token.length >= 3 && !PLAN_EVIDENCE_STOP_WORDS.has(token))
    )
  ];
}

function normalizeEvidenceText(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function singularizeEvidenceToken(token: string) {
  return token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function truncateEvidenceLabel(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length <= 90 ? trimmed : `${trimmed.slice(0, 87).trimEnd()}...`;
}

const PLAN_EVIDENCE_STOP_WORDS = new Set([
  "add",
  "after",
  "and",
  "before",
  "build",
  "change",
  "check",
  "code",
  "create",
  "current",
  "ensure",
  "file",
  "fix",
  "for",
  "from",
  "implement",
  "into",
  "make",
  "new",
  "patch",
  "render",
  "run",
  "show",
  "state",
  "step",
  "support",
  "the",
  "this",
  "todo",
  "update",
  "use",
  "verify",
  "with",
  "work"
]);

export function buildTaskRunReplayOutcomeGroups(runs: AgentTaskRun[]): AgentTaskRunReplayOutcomeGroup[] {
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const groups = new Map<string, AgentTaskRunReplayOutcomeGroup>();

  for (const run of runs) {
    const evidenceRunId = run.worktree?.replayOfTaskRunId;
    if (!evidenceRunId) {
      continue;
    }
    const evidenceRun = runsById.get(evidenceRunId);
    const group =
      groups.get(evidenceRunId) ??
      {
        evidenceRunId,
        evidencePromptPreview: evidenceRun?.promptPreview,
        evidenceVerificationStatus: evidenceRun?.verification?.status,
        outcomes: [],
        failedOutcomeCount: 0,
        passedOutcomeCount: 0,
        unknownOutcomeCount: 0
      };
    group.outcomes.push({
      runId: run.id,
      promptPreview: run.promptPreview || undefined,
      status: run.status,
      verificationStatus: run.verification?.status,
      verificationSummary: run.verification?.summary,
      updatedAt: run.updatedAt
    });
    groups.set(evidenceRunId, group);
  }

  return [...groups.values()]
    .map((group) => {
      const outcomes = [...group.outcomes].sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
      return {
        ...group,
        outcomes,
        failedOutcomeCount: outcomes.filter((outcome) => outcome.verificationStatus === "failed").length,
        passedOutcomeCount: outcomes.filter((outcome) => outcome.verificationStatus === "passed").length,
        unknownOutcomeCount: outcomes.filter((outcome) => !outcome.verificationStatus || outcome.verificationStatus === "unknown").length,
        latestOutcome: outcomes.at(-1)
      };
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.latestOutcome?.updatedAt ?? "");
      const rightTime = Date.parse(right.latestOutcome?.updatedAt ?? "");
      return rightTime - leftTime;
    });
}

function taskRunChangeSummary(run: AgentTaskRun): AgentTaskRunChangeSummary {
  const sourcesByPath = new Map<string, Set<string>>();
  const patchArtifacts = run.artifacts.filter((artifact) => artifact.kind === "patch");
  const fileChangeArtifacts = run.artifacts.filter((artifact) => artifact.kind === "file_change");
  const worktreeDiff = run.worktree?.diff;
  const patchPreview = run.worktree?.patchPreview;
  const artifactInsertions = patchArtifacts.reduce((total, artifact) => total + (artifact.additions ?? 0), 0);
  const artifactDeletions = patchArtifacts.reduce((total, artifact) => total + (artifact.deletions ?? 0), 0);

  for (const changedPath of worktreeDiff?.changedPaths ?? []) {
    addPathSource(sourcesByPath, changedPath, "worktree diff");
  }
  if (patchPreview?.text) {
    for (const changedPath of extractUnifiedDiffPaths(patchPreview.text)) {
      addPathSource(sourcesByPath, changedPath, "patch preview");
    }
  }
  for (const artifact of patchArtifacts) {
    for (const changedPath of artifact.changedPaths ?? []) {
      addPathSource(sourcesByPath, changedPath, artifact.title || "patch artifact");
    }
    if (artifact.diff) {
      for (const changedPath of extractUnifiedDiffPaths(artifact.diff)) {
        addPathSource(sourcesByPath, changedPath, artifact.title || "patch artifact");
      }
    }
  }
  for (const artifact of fileChangeArtifacts) {
    if (artifact.path) {
      addPathSource(sourcesByPath, artifact.path, artifact.title || "file write");
    }
    for (const changedPath of artifact.changedPaths ?? []) {
      addPathSource(sourcesByPath, changedPath, artifact.title || "file write");
    }
  }

  const paths = [...sourcesByPath.keys()].sort((left, right) => left.localeCompare(right));
  return {
    pathCount: paths.length,
    paths,
    insertions: worktreeDiff?.insertions ?? (artifactInsertions || undefined),
    deletions: worktreeDiff?.deletions ?? (artifactDeletions || undefined),
    patchPreviewBytes: patchPreview?.bytes,
    patchPreviewTruncated: patchPreview?.truncated,
    patchArtifactCount: patchArtifacts.length,
    fileChangeArtifactCount: fileChangeArtifacts.length,
    sourcesByPath: Object.fromEntries(paths.map((changedPath) => [changedPath, [...(sourcesByPath.get(changedPath) ?? [])].sort()]))
  };
}

function addPathSource(sourcesByPath: Map<string, Set<string>>, path: string, source: string) {
  const normalizedPath = normalizeRecordedPath(path);
  if (!normalizedPath) {
    return;
  }
  const sources = sourcesByPath.get(normalizedPath) ?? new Set<string>();
  sources.add(source);
  sourcesByPath.set(normalizedPath, sources);
}

function extractUnifiedDiffPaths(diff: string) {
  const paths: string[] = [];
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    const oldLine = lines[index];
    const newLine = lines[index + 1];
    if (!oldLine.startsWith("--- ") || !newLine.startsWith("+++ ")) {
      continue;
    }
    const oldPath = normalizeDiffHeaderPath(oldLine.slice(4));
    const newPath = normalizeDiffHeaderPath(newLine.slice(4));
    const changedPath = newPath || oldPath;
    if (changedPath) {
      paths.push(changedPath);
    }
  }
  return [...new Set(paths)];
}

function normalizeDiffHeaderPath(value: string) {
  return normalizeRecordedPath(value)?.replace(/^[ab]\//, "");
}

function normalizeRecordedPath(value: string) {
  const trimmed = value.trim().replace(/^"|"$/g, "").split(/\t/)[0]?.trim();
  if (!trimmed || trimmed === "/dev/null" || trimmed === "dev/null") {
    return undefined;
  }
  return trimmed;
}

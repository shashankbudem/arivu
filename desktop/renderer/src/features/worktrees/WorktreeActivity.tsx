import { Fragment, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  Check,
  FileText,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Info,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Rows3,
  Scissors,
  Search,
  TerminalSquare,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import { formatBytes, formatDateTime, formatNumber } from "../../format";
import {
  buildTaskRunPullRequestReviewPrompt,
  buildTaskRunReplayFailureReviewPrompt,
  buildTaskRunVerificationRepairPrompt,
  buildTaskRunVerificationReplayPrompt,
  buildTaskRunVerificationRerunPrompt
} from "../../../../../src/agent/reportRemediation";
import {
  buildTaskRunDiffComparison,
  buildTaskRunPlanSourceReview,
  buildTaskRunPullRequestReadiness,
  buildTaskRunReplayOutcomeGroups,
  type AgentTaskRunDiffComparison,
  type AgentTaskRunPlanSourceReview,
  type AgentTaskRunPullRequestReadiness,
  type AgentTaskRunReplayOutcomeGroup
} from "../../../../../src/agent/taskHistory";
import { capabilityLabel } from "../activity/capabilityPresentation";
import {
  activityStatusForTaskRun,
  planItemStatusLabel,
  planReviewStatusLabel,
  taskRunStatusLabel,
  verificationMetaLabel
} from "../activity/activityModel";
import { DiffBlock } from "../activity/DiffBlock";
import { agentLoopIterationStatusLabel, agentLoopRunStatusLabel } from "../sessions/agentLoopPresentation";
import { parseUnifiedDiffPreview, type DiffPreview } from "../../shared/diff";
import { shortRunId } from "../../shared/id";
import { truncateMiddle } from "../../shared/text";
import {
  verificationStatusLabel,
  worktreeStatusLabel,
  type TaskWorktreeAction,
  type TaskWorktreeActionOptions
} from "./worktreePresentation";
import type { DraftPromptOptions, PullRequestWatch, PullRequestWatchView, TaskRunPlanAction } from "./worktreeTypes";

export function TaskWorktreeActions({
  run,
  sourceRun,
  planSourceRun,
  attemptRuns,
  focusedRunId,
  busyKey,
  pullRequestWatch,
  onAction,
  onTogglePullRequestWatch,
  onFocusAttempt,
  onDraftRemediation
}: {
  run: AgentTaskRun;
  sourceRun?: AgentTaskRun;
  planSourceRun?: AgentTaskRun;
  attemptRuns?: AgentTaskRun[];
  focusedRunId: string | null;
  busyKey: string | null;
  pullRequestWatch: PullRequestWatchView;
  onAction: (run: AgentTaskRun, action: TaskWorktreeAction, options?: TaskWorktreeActionOptions) => void;
  onTogglePullRequestWatch: (run: AgentTaskRun) => void;
  onFocusAttempt: (run: AgentTaskRun) => void;
  onDraftRemediation: (draftText: string, options?: DraftPromptOptions) => void;
}) {
  const worktree = run.worktree;
  if (!worktree?.enabled) {
    return null;
  }

  const actions = taskWorktreeActionsForRun(run);
  const diffLabel = worktreeDiffLabel(worktree.diff);
  const busy = busyKey?.startsWith(`${run.id}:`) ?? false;
  const patchPreview = worktreePatchDiffPreview(worktree.patchPreview);
  const verificationGate = taskWorktreeVerificationGate(run, sourceRun);
  const verificationRepairPrompt = buildTaskRunVerificationRepairPrompt(run);
  const verificationRerunPrompt = buildTaskRunVerificationRerunPrompt(run, sourceRun);
  const pullRequestReviewPrompt = buildTaskRunPullRequestReviewPrompt(run);
  const planSourceReview = buildTaskRunPlanSourceReview(run, planSourceRun);
  return (
    <div className="task-worktree-panel">
      <div className="task-worktree-summary">
        <GitBranch size={13} />
        <span title={worktree.path ?? worktree.error}>
          {worktree.branch ?? "Task worktree"} - {worktreeStatusLabel(worktree.status)}
        </span>
        {diffLabel ? <strong>{diffLabel}</strong> : null}
      </div>
      {worktree.error ? <p className="task-worktree-error">{worktree.error}</p> : null}
      {planSourceReview ? <TaskWorktreePlanSourceReview review={planSourceReview} /> : null}
      {verificationGate ? <p className={`task-worktree-gate ${verificationGate.status}`}>{verificationGate.message}</p> : null}
      {worktree.conflict ? <TaskWorktreeConflictCard run={run} busyKey={busyKey} onAction={onAction} /> : null}
      <TaskWorktreeAttemptTimeline
        runs={attemptRuns ?? []}
        currentRunId={run.id}
        focusedRunId={focusedRunId}
        busyKey={busyKey}
        onFocusAttempt={onFocusAttempt}
        onOpenAttempt={(attempt) => onAction(attempt, "open")}
        onDraftRemediation={onDraftRemediation}
      />
      {actions.length > 0 ? (
        <div className="task-worktree-actions">
          {actions.map((action) => {
            const actionBusy = busyKey === `${run.id}:${action.id}`;
            return (
              <button
                key={action.id}
                type="button"
                onClick={() => onAction(run, action.id)}
                disabled={busy || action.disabled}
                title={action.disabledReason ?? action.title}
                aria-label={action.title}
              >
                {actionBusy ? <span className="pulse-dot" /> : action.icon}
                {action.label}
              </button>
            );
          })}
          {verificationRepairPrompt ? (
            <button
              type="button"
              disabled={busy}
              title="Draft a repair prompt and continue this task worktree"
              onClick={() =>
                onDraftRemediation(verificationRepairPrompt, {
                  worktreeContinuation: { taskRunId: run.id, branch: worktree.branch },
                  status: "Drafted repair prompt for task worktree",
                  confirmLabel: "Replace the current composer draft with a repair prompt for this task worktree?"
                })
              }
            >
              <Wrench size={12} />
              Fix verification
            </button>
          ) : null}
          {verificationRerunPrompt ? (
            <button
              type="button"
              disabled={busy}
              title="Draft a prompt that reruns verification in this task worktree"
              onClick={() =>
                onDraftRemediation(verificationRerunPrompt, {
                  worktreeContinuation: { taskRunId: run.id, branch: worktree.branch },
                  status: "Drafted verification rerun prompt for task worktree",
                  confirmLabel: "Replace the current composer draft with a verification rerun prompt for this task worktree?"
                })
              }
            >
              <RefreshCw size={12} />
              Rerun checks
            </button>
          ) : null}
        </div>
      ) : null}
      {worktree.pullRequest ? (
        <TaskWorktreePullRequestCard
          run={run}
          pullRequest={worktree.pullRequest}
          reviewPrompt={pullRequestReviewPrompt}
          busy={busy}
          watch={pullRequestWatch}
          onAction={onAction}
          onToggleWatch={onTogglePullRequestWatch}
          onDraftRemediation={onDraftRemediation}
        />
      ) : null}
      {patchPreview ? (
        <div className="task-worktree-patch">
          <div className="task-worktree-patch-note">
            <span>{worktree.patchPreview?.truncated ? "Patch preview truncated" : "Patch preview ready"}</span>
            <strong>{formatBytes(worktree.patchPreview?.bytes ?? 0)}</strong>
          </div>
          <DiffBlock preview={patchPreview} />
        </div>
      ) : null}
    </div>
  );
}

export function TaskWorktreePlanSourceReview({ review }: { review: AgentTaskRunPlanSourceReview }) {
  const visiblePaths = review.changedPaths.slice(0, 4);
  const hiddenPathCount = Math.max(0, review.changedPaths.length - visiblePaths.length);
  return (
    <div className="task-worktree-plan-source">
      <div className="task-worktree-plan-source-heading">
        <ListChecks size={12} />
        <div>
          <strong>Approved plan source</strong>
          <span>
            {shortRunId(review.sourceRunId)}
            {review.reviewStatus ? ` - ${planReviewStatusLabel(review.reviewStatus)}` : ""}
            {review.reviewUpdatedAt ? ` - ${formatDateTime(review.reviewUpdatedAt)}` : ""}
          </span>
        </div>
      </div>
      {review.sourcePromptPreview ? <p>{review.sourcePromptPreview}</p> : null}
      {review.planSummary ? <p>{review.planSummary}</p> : null}
      {review.completionNotes.length > 0 ? (
        <div className="task-worktree-plan-source-completion">
          <div className="task-worktree-plan-source-completion-heading">
            <strong>Completion notes</strong>
            <span className={review.completionStatus}>{planCompletionStatusLabel(review.completionStatus)}</span>
          </div>
          <p>{review.completionSummary}</p>
          <ol>
            {review.completionNotes.map((note, index) => (
              <li className={`completion-${note.status}`} key={`${note.text}-${index}`}>
                <span>{planCompletionStatusLabel(note.status)}</span>
                <div>
                  <strong>{note.text}</strong>
                  <small>
                    {[note.planStatus ? `Plan ${planItemStatusLabel(note.planStatus).toLowerCase()}` : undefined, ...note.evidence]
                      .filter(Boolean)
                      .join(" - ")}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <div className="task-worktree-plan-source-cues">
        {review.cues.map((cue) => (
          <span key={`${cue.status}-${cue.text}`} className={cue.status}>
            {planSourceCueIcon(cue.status)}
            {cue.text}
          </span>
        ))}
      </div>
      {visiblePaths.length > 0 ? (
        <div className="task-worktree-plan-source-paths">
          {visiblePaths.map((changedPath) => (
            <code key={changedPath}>{changedPath}</code>
          ))}
          {hiddenPathCount > 0 ? <code>+{hiddenPathCount} more</code> : null}
        </div>
      ) : null}
    </div>
  );
}

export function planSourceCueIcon(status: AgentTaskRunPlanSourceReview["cues"][number]["status"]) {
  switch (status) {
    case "passed":
      return <Check size={11} />;
    case "failed":
      return <AlertTriangle size={11} />;
    default:
      return <Info size={11} />;
  }
}

export function planCompletionStatusLabel(status: AgentTaskRunPlanSourceReview["completionStatus"]) {
  switch (status) {
    case "supported":
      return "Supported";
    case "blocked":
      return "Blocked";
    case "needs_evidence":
      return "Needs evidence";
  }
}

export function TaskWorktreeConflictCard({
  run,
  busyKey,
  onAction
}: {
  run: AgentTaskRun;
  busyKey: string | null;
  onAction: (run: AgentTaskRun, action: TaskWorktreeAction, options?: TaskWorktreeActionOptions) => void;
}) {
  const conflict = run.worktree?.conflict;
  if (!conflict) {
    return null;
  }
  const visibleFiles = conflict.files.slice(0, 6);
  const hiddenCount = conflict.files.length - visibleFiles.length;
  const busy = busyKey?.startsWith(`${run.id}:`) ?? false;
  return (
    <div className="task-worktree-conflict" aria-label="Task worktree conflict resolution">
      <div className="task-worktree-conflict-heading">
        <AlertTriangle size={13} />
        <span>Conflict resolution</span>
        <strong>{formatDateTime(conflict.detectedAt)}</strong>
      </div>
      <p>{conflict.message}</p>
      {visibleFiles.length > 0 ? (
        <ul>
          {visibleFiles.map((file) => (
            <li key={file}>
              <button
                type="button"
                onClick={() => onAction(run, "open_conflict_file", { conflictPath: file })}
                disabled={busy}
                title={`Open ${file}`}
              >
                <FileText size={11} />
                <span>{truncateMiddle(file, 54)}</span>
              </button>
            </li>
          ))}
          {hiddenCount > 0 ? (
            <li>
              <MoreHorizontal size={11} />
              <span>
                {formatNumber(hiddenCount)} more file{hiddenCount === 1 ? "" : "s"}
              </span>
            </li>
          ) : null}
        </ul>
      ) : null}
      <div className="task-worktree-conflict-actions">
        <button type="button" onClick={() => onAction(run, "open")} disabled={busy} title="Open this worktree to resolve conflicts">
          <FolderOpen size={12} />
          Open
        </button>
        <button
          type="button"
          onClick={() => onAction(run, "continue_conflict")}
          disabled={busy}
          title="Continue after conflicts are resolved and staged"
        >
          <Check size={12} />
          Continue
        </button>
        <button
          type="button"
          onClick={() => onAction(run, "abort_conflict")}
          disabled={busy}
          title="Abort this sync and return to the previous task branch state"
        >
          <RotateCcw size={12} />
          Abort
        </button>
      </div>
    </div>
  );
}

export function TaskWorktreeAttemptTimeline({
  runs,
  currentRunId,
  focusedRunId,
  busyKey,
  onFocusAttempt,
  onOpenAttempt,
  onDraftRemediation
}: {
  runs: AgentTaskRun[];
  currentRunId: string;
  focusedRunId: string | null;
  busyKey: string | null;
  onFocusAttempt: (run: AgentTaskRun) => void;
  onOpenAttempt: (run: AgentTaskRun) => void;
  onDraftRemediation: (draftText: string, options?: DraftPromptOptions) => void;
}) {
  const [compareRunId, setCompareRunId] = useState<string | null>(null);
  if (runs.length <= 1) {
    return null;
  }
  const currentRun = runs.find((run) => run.id === currentRunId) ?? runs.at(-1);
  const comparisonRun = compareRunId ? runs.find((run) => run.id === compareRunId) : undefined;
  const comparison = currentRun && comparisonRun ? attemptComparisonForRuns(runs, comparisonRun, currentRun) : undefined;
  const replayOutcomeGroups = buildTaskRunReplayOutcomeGroups(runs);
  const runsById = new Map(runs.map((attempt) => [attempt.id, attempt]));

  return (
    <div className="task-worktree-attempts" aria-label="Task worktree repair history">
      <div className="task-worktree-attempts-heading">
        <ListChecks size={13} />
        <span>Repair history</span>
        <strong>{runs.length} attempts</strong>
      </div>
      <ol>
        {runs.map((attempt, index) => {
          const verificationStatus = attempt.verification?.status ?? "unknown";
          const stage = attempt.worktree?.replayOfTaskRunId
            ? "Replay"
            : attempt.worktree?.continuedFromTaskRunId
              ? "Continuation"
              : "Original";
          const isCurrent = attempt.id === currentRunId;
          const focused = attempt.id === focusedRunId;
          const openAction = taskWorktreeActionsForRun(attempt).find((action) => action.id === "open");
          const openBusy = busyKey === `${attempt.id}:open`;
          const compareAvailable = Boolean(
            currentRun && (attempt.id !== currentRun.id || runs.findIndex((run) => run.id === attempt.id) > 0)
          );
          const replayPrompt = currentRun ? buildTaskRunVerificationReplayPrompt(attempt, currentRun) : undefined;
          const meta = [
            isCurrent ? "Current" : stage,
            taskRunStatusLabel(attempt.status),
            attempt.worktree?.replayOfTaskRunId ? `Replay of ${shortRunId(attempt.worktree.replayOfTaskRunId)}` : undefined,
            attempt.verification ? verificationStatusLabel(attempt.verification.status) : "Verification unknown",
            formatDateTime(attempt.updatedAt)
          ].filter((part): part is string => Boolean(part));
          return (
            <li key={attempt.id} className={`status-${verificationStatus}${focused ? " focus-active" : ""}`}>
              <span className="task-worktree-attempt-index">{index + 1}</span>
              <div>
                <strong title={attempt.promptPreview}>{attempt.promptPreview || stage}</strong>
                <small>{meta.join(" - ")}</small>
              </div>
              <div className="task-worktree-attempt-actions">
                <button type="button" onClick={() => onFocusAttempt(attempt)} title="Show this attempt's Activity details">
                  <MessageSquare size={11} />
                  Details
                </button>
                {compareAvailable ? (
                  <button type="button" onClick={() => setCompareRunId(attempt.id)} title="Compare this attempt with the current attempt">
                    <Rows3 size={11} />
                    Compare
                  </button>
                ) : null}
                {replayPrompt && currentRun?.worktree ? (
                  <button
                    type="button"
                    onClick={() =>
                      onDraftRemediation(replayPrompt, {
                        worktreeContinuation: {
                          taskRunId: currentRun.id,
                          branch: currentRun.worktree?.branch,
                          replayOfTaskRunId: attempt.id
                        },
                        status: "Drafted replay checks prompt for task worktree",
                        confirmLabel: "Replace the current composer draft with a replay-checks prompt for this task worktree?"
                      })
                    }
                    title="Draft a prompt that replays this attempt's verification commands in the current worktree"
                  >
                    <RefreshCw size={11} />
                    Replay
                  </button>
                ) : null}
                {openAction ? (
                  <button
                    type="button"
                    onClick={() => onOpenAttempt(attempt)}
                    disabled={Boolean(busyKey) || openAction.disabled}
                    title={openAction.disabledReason ?? "Open this attempt's managed worktree"}
                  >
                    {openBusy ? <span className="pulse-dot" /> : <FolderOpen size={11} />}
                    Open
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {replayOutcomeGroups.length > 0 ? (
        <TaskWorktreeReplayOutcomes
          groups={replayOutcomeGroups}
          runsById={runsById}
          currentRun={currentRun}
          onFocusAttempt={onFocusAttempt}
          onDraftRemediation={onDraftRemediation}
        />
      ) : null}
      {comparison ? (
        <TaskWorktreeAttemptComparison from={comparison.from} to={comparison.to} onClose={() => setCompareRunId(null)} />
      ) : null}
    </div>
  );
}

export function TaskWorktreeAttemptComparison({ from, to, onClose }: { from: AgentTaskRun; to: AgentTaskRun; onClose: () => void }) {
  const diffComparison = buildTaskRunDiffComparison(from, to);
  const rows = [
    ["Prompt", attemptPromptLabel(from), attemptPromptLabel(to)],
    ["Run", taskRunStatusLabel(from.status), taskRunStatusLabel(to.status)],
    ["Verification", attemptVerificationLabel(from), attemptVerificationLabel(to)],
    ["Commands", attemptCommandEvidenceLabel(from), attemptCommandEvidenceLabel(to)],
    ["Reports", attemptReportEvidenceLabel(from), attemptReportEvidenceLabel(to)],
    ["Changes", attemptWorktreeChangeLabel(from), attemptWorktreeChangeLabel(to)],
    ["Replay", attemptReplayLabel(from), attemptReplayLabel(to)],
    ["Updated", formatDateTime(from.updatedAt), formatDateTime(to.updatedAt)]
  ];

  return (
    <div className="task-worktree-attempt-comparison" aria-label="Repair attempt comparison">
      <div className="task-worktree-attempt-comparison-heading">
        <Rows3 size={13} />
        <span>Compare attempts</span>
        <button type="button" onClick={onClose} title="Close comparison" aria-label="Close comparison">
          <X size={12} />
        </button>
      </div>
      <div className="task-worktree-attempt-comparison-grid">
        <span />
        <strong title={from.promptPreview}>{from.id === to.id ? "Selected" : "Selected attempt"}</strong>
        <strong title={to.promptPreview}>Current attempt</strong>
        {rows.map(([label, left, right]) => (
          <Fragment key={label}>
            <span>{label}</span>
            <small title={left}>{left}</small>
            <small title={right}>{right}</small>
          </Fragment>
        ))}
      </div>
      <TaskWorktreeAttemptDiffDetails comparison={diffComparison} />
    </div>
  );
}

export function TaskWorktreeReplayOutcomes({
  groups,
  runsById,
  currentRun,
  onFocusAttempt,
  onDraftRemediation
}: {
  groups: AgentTaskRunReplayOutcomeGroup[];
  runsById: Map<string, AgentTaskRun>;
  currentRun: AgentTaskRun | undefined;
  onFocusAttempt: (run: AgentTaskRun) => void;
  onDraftRemediation: (draftText: string, options?: DraftPromptOptions) => void;
}) {
  return (
    <div className="task-worktree-replay-outcomes" aria-label="Replay outcomes">
      <div className="task-worktree-replay-outcomes-heading">
        <RefreshCw size={12} />
        <span>Replay outcomes</span>
        <strong>
          {groups.reduce((total, group) => total + group.outcomes.length, 0)} replay
          {groups.reduce((total, group) => total + group.outcomes.length, 0) === 1 ? "" : "s"}
        </strong>
      </div>
      {groups.map((group) => {
        const evidenceRun = runsById.get(group.evidenceRunId);
        const outcomeRuns = group.outcomes.map((outcome) => runsById.get(outcome.runId)).filter((run): run is AgentTaskRun => Boolean(run));
        const reviewPrompt =
          evidenceRun && currentRun ? buildTaskRunReplayFailureReviewPrompt(evidenceRun, outcomeRuns, currentRun) : undefined;
        const outcomeSummary = replayOutcomeSummary(group);
        return (
          <div key={group.evidenceRunId} className="task-worktree-replay-group">
            <div className="task-worktree-replay-group-heading">
              <div>
                <strong title={group.evidencePromptPreview}>Evidence {shortRunId(group.evidenceRunId)}</strong>
                <small>
                  {[
                    group.evidenceVerificationStatus
                      ? `Evidence ${verificationStatusLabel(group.evidenceVerificationStatus)}`
                      : "Evidence status unknown",
                    outcomeSummary,
                    group.latestOutcome ? formatDateTime(group.latestOutcome.updatedAt) : undefined
                  ]
                    .filter((part): part is string => Boolean(part))
                    .join(" - ")}
                </small>
              </div>
              {reviewPrompt && currentRun?.worktree ? (
                <button
                  type="button"
                  onClick={() =>
                    onDraftRemediation(reviewPrompt, {
                      worktreeContinuation: {
                        taskRunId: currentRun.id,
                        branch: currentRun.worktree?.branch,
                        replayOfTaskRunId: group.evidenceRunId
                      },
                      status: "Drafted replay failure review prompt for task worktree",
                      confirmLabel: "Replace the current composer draft with a replay failure review prompt for this task worktree?"
                    })
                  }
                  title="Draft a review prompt for repeated failed replay checks"
                >
                  <Wrench size={11} />
                  Review
                </button>
              ) : null}
            </div>
            <div className="task-worktree-replay-list">
              {group.outcomes.map((outcome) => {
                const run = runsById.get(outcome.runId);
                const status = outcome.verificationStatus ?? "unknown";
                return (
                  <button
                    key={outcome.runId}
                    type="button"
                    className={`status-${status}`}
                    onClick={() => (run ? onFocusAttempt(run) : undefined)}
                    disabled={!run}
                    title={outcome.verificationSummary ?? outcome.promptPreview ?? outcome.runId}
                  >
                    <span>{shortRunId(outcome.runId)}</span>
                    <strong>{verificationStatusLabel(status)}</strong>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TaskWorktreeAttemptDiffDetails({ comparison }: { comparison: AgentTaskRunDiffComparison }) {
  const visibleDeltas = comparison.pathDeltas.slice(0, 8);
  const hiddenCount = comparison.pathDeltas.length - visibleDeltas.length;
  const counters = [
    `${formatNumber(comparison.right.pathCount)} current path${comparison.right.pathCount === 1 ? "" : "s"}`,
    comparison.added.length ? `${formatNumber(comparison.added.length)} added` : undefined,
    comparison.removed.length ? `${formatNumber(comparison.removed.length)} removed` : undefined,
    comparison.shared.length ? `${formatNumber(comparison.shared.length)} shared` : undefined,
    attemptChangeStatsLabel(comparison.right)
  ].filter((part): part is string => Boolean(part));

  return (
    <div className="task-worktree-diff-details" aria-label="Attempt file-level comparison">
      <div className="task-worktree-diff-details-heading">
        <FileText size={12} />
        <span>File delta</span>
        <strong>{counters.join(" - ") || "No changed paths recorded"}</strong>
      </div>
      {comparison.pathDeltas.length > 0 ? (
        <ul>
          {visibleDeltas.map((delta) => (
            <li key={delta.path} className={`state-${delta.state}`}>
              <span>{attemptPathDeltaLabel(delta.state)}</span>
              <strong title={delta.path}>{truncateMiddle(delta.path, 54)}</strong>
              <small title={attemptPathDeltaSources(delta)}>{attemptPathDeltaSources(delta)}</small>
            </li>
          ))}
          {hiddenCount > 0 ? (
            <li className="state-hidden">
              <span>More</span>
              <strong>
                {formatNumber(hiddenCount)} more path{hiddenCount === 1 ? "" : "s"}
              </strong>
              <small>Open patch preview for full diff evidence.</small>
            </li>
          ) : null}
        </ul>
      ) : (
        <p>No per-file diff evidence was stored for these attempts.</p>
      )}
    </div>
  );
}

export function attemptComparisonForRuns(runs: AgentTaskRun[], selectedRun: AgentTaskRun, currentRun: AgentTaskRun) {
  if (selectedRun.id !== currentRun.id) {
    return { from: selectedRun, to: currentRun };
  }
  const selectedIndex = runs.findIndex((run) => run.id === selectedRun.id);
  const previous = selectedIndex > 0 ? runs[selectedIndex - 1] : undefined;
  return previous ? { from: previous, to: currentRun } : undefined;
}

export function attemptPromptLabel(run: AgentTaskRun) {
  return run.promptPreview ? truncateMiddle(run.promptPreview, 70) : "(no prompt)";
}

export function attemptVerificationLabel(run: AgentTaskRun) {
  const verification = run.verification;
  if (!verification) {
    return "No verification captured";
  }
  const stats = [
    `${verificationStatusLabel(verification.status)}`,
    `${formatNumber(verification.commandCount)} cmd`,
    verification.failedCommandCount ? `${formatNumber(verification.failedCommandCount)} failed` : undefined,
    verification.timedOutCommandCount ? `${formatNumber(verification.timedOutCommandCount)} timed out` : undefined,
    verification.parsedReportCount ? `${formatNumber(verification.parsedReportCount)} reports` : undefined,
    verification.failedReportCount ? `${formatNumber(verification.failedReportCount)} failed reports` : undefined
  ].filter((part): part is string => Boolean(part));
  return stats.join(" - ");
}

export function attemptCommandEvidenceLabel(run: AgentTaskRun) {
  const commands = run.artifacts.filter((artifact) => artifact.kind === "command_output");
  if (!commands.length) {
    return "No command evidence";
  }
  const failed = commands.filter((artifact) => artifact.exitCode !== undefined && artifact.exitCode !== 0).length;
  const latest = commands.at(-1);
  const command = latest?.command ? truncateMiddle(latest.command, 42) : (latest?.title ?? "command");
  return `${formatNumber(commands.length)} command${commands.length === 1 ? "" : "s"}${failed ? `, ${formatNumber(failed)} failed` : ""} - ${command}`;
}

export function attemptReportEvidenceLabel(run: AgentTaskRun) {
  const reports = run.artifacts.flatMap((artifact) => (artifact.kind === "command_output" ? (artifact.testReports ?? []) : []));
  if (!reports.length) {
    return "No parsed reports";
  }
  const failed = reports.filter((report) => report.status === "failed").length;
  const latest = reports.at(-1);
  return `${formatNumber(reports.length)} report${reports.length === 1 ? "" : "s"}${failed ? `, ${formatNumber(failed)} failed` : ""} - ${latest?.summary ?? latest?.path ?? "report"}`;
}

export function attemptWorktreeChangeLabel(run: AgentTaskRun) {
  const diffLabel = worktreeDiffLabel(run.worktree?.diff);
  if (diffLabel) {
    return diffLabel;
  }
  const patch = run.worktree?.patchPreview;
  if (patch) {
    return `Patch ${formatBytes(patch.bytes)}${patch.truncated ? " truncated" : ""}`;
  }
  const patchArtifacts = run.artifacts.filter((artifact) => artifact.kind === "patch" || artifact.kind === "file_change");
  if (patchArtifacts.length) {
    return `${formatNumber(patchArtifacts.length)} edit artifact${patchArtifacts.length === 1 ? "" : "s"}`;
  }
  return "No change summary";
}

export function attemptReplayLabel(run: AgentTaskRun) {
  return run.worktree?.replayOfTaskRunId ? `Replay of ${shortRunId(run.worktree.replayOfTaskRunId)}` : "Not a replay";
}

export function replayOutcomeSummary(group: AgentTaskRunReplayOutcomeGroup) {
  const parts = [
    group.failedOutcomeCount ? `${formatNumber(group.failedOutcomeCount)} failed` : undefined,
    group.passedOutcomeCount ? `${formatNumber(group.passedOutcomeCount)} passed` : undefined,
    group.unknownOutcomeCount ? `${formatNumber(group.unknownOutcomeCount)} unknown` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(", ") : `${formatNumber(group.outcomes.length)} replay${group.outcomes.length === 1 ? "" : "s"}`;
}

export function attemptChangeStatsLabel(summary: AgentTaskRunDiffComparison["right"]) {
  const stats = [
    summary.insertions ? `+${formatNumber(summary.insertions)}` : undefined,
    summary.deletions ? `-${formatNumber(summary.deletions)}` : undefined,
    summary.patchPreviewBytes ? `patch ${formatBytes(summary.patchPreviewBytes)}` : undefined,
    summary.patchPreviewTruncated ? "truncated" : undefined
  ].filter((part): part is string => Boolean(part));
  return stats.join(" ");
}

export function attemptPathDeltaLabel(state: AgentTaskRunDiffComparison["pathDeltas"][number]["state"]) {
  switch (state) {
    case "added":
      return "Current";
    case "removed":
      return "Selected";
    case "shared":
      return "Both";
    default:
      return "Path";
  }
}

export function attemptPathDeltaSources(delta: AgentTaskRunDiffComparison["pathDeltas"][number]) {
  const left = delta.leftSources.length ? `selected: ${delta.leftSources.join(", ")}` : undefined;
  const right = delta.rightSources.length ? `current: ${delta.rightSources.join(", ")}` : undefined;
  return [left, right].filter((part): part is string => Boolean(part)).join(" | ") || "No source label";
}

export function pullRequestWatchKey(sessionId: string, taskRunId: string) {
  return `${sessionId}:${taskRunId}`;
}

export function pullRequestWatchForRun(
  sessionId: string | undefined,
  run: AgentTaskRun,
  watches: Record<string, PullRequestWatch>,
  busy: Record<string, boolean>
): PullRequestWatchView {
  if (!sessionId) {
    return { active: false, refreshing: false };
  }
  const key = pullRequestWatchKey(sessionId, run.id);
  const watch = watches[key];
  return {
    active: Boolean(watch),
    refreshing: Boolean(busy[key]),
    lastRefreshedAt: watch?.lastRefreshedAt,
    lastError: watch?.lastError
  };
}

export function pullRequestWatchStatusLabel(watch: PullRequestWatchView) {
  if (!watch.active && !watch.refreshing) {
    return "";
  }
  if (watch.lastError) {
    return `Watch error: ${watch.lastError}`;
  }
  if (watch.refreshing) {
    return "Refreshing PR status...";
  }
  if (watch.lastRefreshedAt) {
    return `Watching in background - last refreshed ${formatDateTime(watch.lastRefreshedAt)}`;
  }
  return "Watching in background";
}

export function TaskWorktreePullRequestCard({
  run,
  pullRequest,
  reviewPrompt,
  busy,
  watch,
  onAction,
  onToggleWatch,
  onDraftRemediation
}: {
  run: AgentTaskRun;
  pullRequest: AgentTaskRunWorktreePullRequest;
  reviewPrompt?: string;
  busy: boolean;
  watch: PullRequestWatchView;
  onAction: (run: AgentTaskRun, action: TaskWorktreeAction, options?: TaskWorktreeActionOptions) => void;
  onToggleWatch: (run: AgentTaskRun) => void;
  onDraftRemediation: (draftText: string, options?: DraftPromptOptions) => void;
}) {
  const watchStatus = pullRequestWatchStatusLabel(watch);
  return (
    <div className="task-worktree-pr">
      <div className="task-worktree-pr-heading">
        <GitPullRequest size={13} />
        <strong>{pullRequest.url ? "Pull request created" : "Pull request draft"}</strong>
        <span>{formatDateTime(pullRequest.createdAt ?? pullRequest.preparedAt)}</span>
      </div>
      <p>{pullRequest.title}</p>
      <div className="task-worktree-pr-meta">
        <span>{pullRequest.branch}</span>
        {pullRequest.baseBranch ? <span>base {pullRequest.baseBranch}</span> : null}
        {pullRequest.remoteName ? <span>remote {pullRequest.remoteName}</span> : null}
      </div>
      {pullRequest.pushCommand ? <code>{pullRequest.pushCommand}</code> : null}
      {pullRequest.createCommand ? <code>{pullRequest.createCommand}</code> : null}
      {pullRequest.url ? <code>{pullRequest.url}</code> : null}
      {pullRequest.review ? <TaskWorktreePullRequestReview review={pullRequest.review} /> : null}
      {pullRequest.url || reviewPrompt ? (
        <div className="task-worktree-pr-actions">
          {pullRequest.url ? (
            <button
              type="button"
              disabled={busy}
              title="Refresh this pull request's review and check status with GitHub CLI"
              onClick={() => onAction(run, "refresh_pr")}
            >
              <RefreshCw size={12} />
              Refresh PR
            </button>
          ) : null}
          {pullRequest.review?.checkItems?.some(
            (item) => item.logCommand && (item.bucket === "failed" || item.bucket === "cancelled" || item.bucket === "unknown")
          ) ? (
            <button
              type="button"
              disabled={busy}
              title="Fetch failed, cancelled, or unknown PR check evidence and save it on the task run"
              onClick={() => onAction(run, "fetch_pr_check_logs")}
            >
              <TerminalSquare size={12} />
              Fetch evidence
            </button>
          ) : null}
          {pullRequest.url ? (
            <button
              type="button"
              disabled={busy || watch.refreshing}
              title={
                watch.active
                  ? "Stop background refresh for this pull request"
                  : "Refresh this pull request in the background every 90 seconds"
              }
              onClick={() => onToggleWatch(run)}
            >
              {watch.refreshing ? <span className="pulse-dot" /> : <RefreshCw size={12} />}
              {watch.active ? "Watching" : "Watch PR"}
            </button>
          ) : null}
          {reviewPrompt ? (
            <button
              type="button"
              disabled={busy}
              title="Draft a prompt to review this PR and continue the task worktree"
              onClick={() =>
                onDraftRemediation(reviewPrompt, {
                  worktreeContinuation: { taskRunId: run.id, branch: run.worktree?.branch },
                  status: "Drafted PR review prompt for task worktree",
                  confirmLabel: "Replace the current composer draft with a PR review prompt for this task worktree?"
                })
              }
            >
              <Search size={12} />
              Review PR
            </button>
          ) : null}
        </div>
      ) : null}
      {watchStatus ? (
        <small className={watch.lastError ? "task-worktree-pr-watch-status error" : "task-worktree-pr-watch-status"}>{watchStatus}</small>
      ) : null}
      {!pullRequest.createCommand ? <small>Add an origin remote and base branch before creating this PR with GitHub CLI.</small> : null}
    </div>
  );
}

export function TaskWorktreePullRequestReview({ review }: { review: AgentTaskRunWorktreePullRequestReview }) {
  const readiness = buildTaskRunPullRequestReadiness(review);
  return (
    <div className="task-worktree-pr-review">
      <div className="task-worktree-pr-review-heading">
        <ListChecks size={12} />
        <strong>{review.summary}</strong>
      </div>
      <div className="task-worktree-pr-meta">
        {review.state ? <span>state {formatPrStatusToken(review.state)}</span> : null}
        {review.isDraft !== undefined ? <span>{review.isDraft ? "draft" : "ready for review"}</span> : null}
        {review.reviewDecision ? <span>review {formatPrStatusToken(review.reviewDecision)}</span> : null}
        {review.mergeStateStatus ? <span>merge {formatPrStatusToken(review.mergeStateStatus)}</span> : null}
        <span>{review.checkSummary}</span>
        <span>{formatDateTime(review.updatedAt)}</span>
      </div>
      <TaskWorktreePullRequestReadiness readiness={readiness} />
      {review.notifications?.length ? <TaskWorktreePullRequestNotifications items={review.notifications} /> : null}
      {review.checkItems?.length ? <TaskWorktreePullRequestChecks items={review.checkItems} /> : null}
      {review.feedback ? <TaskWorktreePullRequestFeedback feedback={review.feedback} /> : null}
    </div>
  );
}

export function TaskWorktreePullRequestReadiness({ readiness }: { readiness: AgentTaskRunPullRequestReadiness }) {
  return (
    <div className={`task-worktree-pr-readiness ${readiness.status}`}>
      {pullRequestReadinessIcon(readiness.status)}
      <strong>{readiness.label}</strong>
      <span>{readiness.summary}</span>
    </div>
  );
}

export function TaskWorktreePullRequestNotifications({ items }: { items: AgentTaskRunWorktreePullRequestReviewNotification[] }) {
  return (
    <div className="task-worktree-pr-notifications">
      <div className="task-worktree-pr-feedback-heading">
        <Bell size={12} />
        <strong>PR updates</strong>
      </div>
      <ul>
        {items.map((item, index) => (
          <li key={`${item.summary}-${item.detail ?? ""}-${item.createdAt}-${index}`} className={item.level}>
            <span>{item.summary}</span>
            {item.detail ? <p>{item.detail}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TaskWorktreePullRequestFeedback({ feedback }: { feedback: AgentTaskRunWorktreePullRequestFeedback }) {
  return (
    <div className="task-worktree-pr-feedback">
      <div className="task-worktree-pr-feedback-heading">
        <MessageSquare size={12} />
        <strong>{feedback.summary}</strong>
      </div>
      {feedback.threadFetchError ? <p>Review thread details unavailable: {feedback.threadFetchError}</p> : null}
      {feedback.items.length > 0 ? (
        <ul>
          {feedback.items.map((item, index) => (
            <li key={`${item.kind}-${item.url ?? item.updatedAt ?? item.createdAt ?? index}`}>
              <span>{pullRequestFeedbackLabel(item)}</span>
              {item.body ? <p>{item.body}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function TaskWorktreePullRequestChecks({ items }: { items: AgentTaskRunWorktreePullRequestCheckItem[] }) {
  return (
    <div className="task-worktree-pr-feedback">
      <div className="task-worktree-pr-feedback-heading">
        <ListChecks size={12} />
        <strong>Check evidence</strong>
      </div>
      <ul>
        {items.map((item, index) => (
          <li key={`${item.name}-${item.detailsUrl ?? item.completedAt ?? index}`}>
            <span>{pullRequestCheckLabel(item)}</span>
            {item.detailsUrl ? <p>{item.detailsUrl}</p> : null}
            {item.logCommand ? (
              <p>
                {item.logSource === "details_url" ? "Check details capture" : "Log command"}: {item.logCommand}
              </p>
            ) : null}
            {item.logArtifactId ? <p>Saved evidence artifact: {item.logArtifactId}</p> : null}
            {item.logError ? <p>Evidence fetch issue: {item.logError}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function pullRequestCheckLabel(item: AgentTaskRunWorktreePullRequestCheckItem) {
  const details = [
    item.bucket,
    item.conclusion ? `conclusion ${formatPrStatusToken(item.conclusion)}` : undefined,
    item.state ? `state ${formatPrStatusToken(item.state)}` : undefined,
    item.status ? `status ${formatPrStatusToken(item.status)}` : undefined
  ].filter((part): part is string => Boolean(part));
  return `${item.name} - ${details.join(", ")}`;
}

export function pullRequestFeedbackLabel(item: AgentTaskRunWorktreePullRequestFeedbackItem) {
  const parts = [
    item.kind === "review" ? "Review" : item.kind === "thread" ? "Thread" : "Comment",
    item.state ? formatPrStatusToken(item.state) : undefined,
    item.author ? `by ${item.author}` : undefined,
    item.path ? `at ${item.path}${item.line !== undefined ? `:${item.line}` : ""}` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.join(" ");
}

export function pullRequestReadinessIcon(status: AgentTaskRunPullRequestReadiness["status"]) {
  switch (status) {
    case "ready":
      return <Check size={12} />;
    case "blocked":
      return <AlertTriangle size={12} />;
    default:
      return <Info size={12} />;
  }
}

export function TaskRunMeta({ run, compact = false }: { run: AgentTaskRun; compact?: boolean }) {
  const capabilityLabels = run.capabilities.map(capabilityLabel);
  return (
    <div className={compact ? "task-run-meta compact" : "task-run-meta"}>
      <span className={`task-run-state ${activityStatusForTaskRun(run)}`}>{taskRunStatusLabel(run.status)}</span>
      {run.providerName || run.model ? (
        <span title={run.modelSelectionReason}>{[run.providerName, run.model].filter(Boolean).join(" - ")}</span>
      ) : null}
      {run.planMode?.enabled ? <span>Plan approval</span> : null}
      {run.loop?.enabled ? <span>Loop {run.loop.maxIterations} max</span> : null}
      {run.worktree?.enabled ? (
        <span title={run.worktree.path ?? run.worktree.error}>
          {run.worktree.replayOfTaskRunId
            ? `Replay ${run.worktree.branch ?? "worktree"} from ${shortRunId(run.worktree.replayOfTaskRunId)}`
            : run.worktree.continuedFromTaskRunId
              ? `Continued ${run.worktree.branch ?? "worktree"}`
              : run.worktree.plannedFromTaskRunId
                ? `Plan worktree ${shortRunId(run.worktree.plannedFromTaskRunId)}`
                : run.worktree.status === "ready"
                  ? `Worktree ${run.worktree.branch ?? "ready"}`
                  : `Worktree ${worktreeStatusLabel(run.worktree.status)}`}
        </span>
      ) : null}
      {capabilityLabels.length > 0 ? (
        <span>{compact ? capabilityLabels.slice(0, 3).join(", ") : capabilityLabels.join(", ")}</span>
      ) : (
        <span>No tools yet</span>
      )}
      {run.plan?.items.length ? (
        <span>
          {run.plan.items.length} plan step{run.plan.items.length === 1 ? "" : "s"}
        </span>
      ) : null}
      {run.verification ? <span>{verificationMetaLabel(run.verification)}</span> : null}
      {run.artifacts.length > 0 ? (
        <span>
          {run.artifacts.length} artifact{run.artifacts.length === 1 ? "" : "s"}
        </span>
      ) : null}
    </div>
  );
}

export function TaskRunLoop({ loop }: { loop: NonNullable<AgentTaskRun["loop"]> }) {
  const iterations = loop.iterations ?? [];
  const latest = iterations.at(-1);
  const summary = [
    `${loop.iteration ?? iterations.length}/${loop.maxIterations}`,
    loop.status ? agentLoopRunStatusLabel(loop.status) : undefined,
    loop.lastDecision ? `last ${loop.lastDecision}` : undefined
  ].filter((item): item is string => Boolean(item));

  return (
    <div className="task-run-loop">
      <div className="task-run-loop-heading">
        <Activity size={13} />
        <span>Loop iterations</span>
        <strong>{summary.join(" - ")}</strong>
      </div>
      <ol>
        {iterations.map((iteration) => (
          <li key={`${iteration.iteration}-${iteration.startedAt}`} className={iteration.status}>
            <div>
              <strong>Iteration {iteration.iteration}</strong>
              <span>{agentLoopIterationStatusLabel(iteration.status)}</span>
              {iteration.decision ? <span>decision {iteration.decision}</span> : null}
              {iteration.toolCallCount !== undefined ? (
                <span>
                  {iteration.toolCallCount} tool{iteration.toolCallCount === 1 ? "" : "s"}
                </span>
              ) : null}
              {iteration.artifactCount !== undefined ? (
                <span>
                  {iteration.artifactCount} artifact{iteration.artifactCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
            {iteration.error || iteration.outputPreview ? <p>{iteration.error ?? iteration.outputPreview}</p> : null}
          </li>
        ))}
      </ol>
      {latest?.status === "running" ? <p className="task-run-loop-live">Current iteration is still running.</p> : null}
    </div>
  );
}

export function TaskRunVerification({ verification }: { verification: AgentTaskRunVerification }) {
  const counters = [
    `${verification.commandCount} command${verification.commandCount === 1 ? "" : "s"}`,
    verification.failedCommandCount > 0
      ? `${verification.failedCommandCount} failed exit${verification.failedCommandCount === 1 ? "" : "s"}`
      : null,
    verification.timedOutCommandCount && verification.timedOutCommandCount > 0 ? `${verification.timedOutCommandCount} timed out` : null,
    verification.parsedReportCount > 0
      ? `${verification.parsedReportCount} report${verification.parsedReportCount === 1 ? "" : "s"}`
      : null,
    verification.failedReportCount > 0
      ? `${verification.failedReportCount} failed report${verification.failedReportCount === 1 ? "" : "s"}`
      : null
  ].filter((counter): counter is string => Boolean(counter));

  return (
    <div className={`task-run-verification ${verification.status}`}>
      <div className="task-run-verification-heading">
        <Activity size={13} />
        <span>Verification</span>
        <strong>{verificationStatusLabel(verification.status)}</strong>
        <time>{formatDateTime(verification.updatedAt)}</time>
      </div>
      <p>{verification.summary}</p>
      {counters.length > 0 ? (
        <div className="task-run-verification-counters">
          {counters.map((counter) => (
            <span key={counter}>{counter}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TaskRunPlan({
  plan,
  planReview,
  approvalPrompt,
  worktreePrompt,
  canCreateWorktree,
  actionBusyKey,
  runId,
  onDraftApproval,
  onDraftWorktreeApproval,
  onPlanAction
}: {
  plan: NonNullable<AgentTaskRun["plan"]>;
  planReview?: AgentTaskRun["planReview"];
  approvalPrompt?: string;
  worktreePrompt?: string;
  canCreateWorktree?: boolean;
  actionBusyKey?: string | null;
  runId?: string;
  onDraftApproval?: (draftText: string) => void;
  onDraftWorktreeApproval?: (draftText: string) => void;
  onPlanAction?: (action: TaskRunPlanAction) => void;
}) {
  const reviewStatus = planReview?.status;
  const isPlanActionBusy = Boolean(runId && actionBusyKey?.startsWith(`${runId}:`));
  return (
    <div className="task-run-plan">
      <div className="task-run-plan-heading">
        <ListChecks size={13} />
        <span>Plan</span>
        <time>{formatDateTime(plan.updatedAt)}</time>
      </div>
      {planReview ? (
        <div className={`task-run-plan-review ${planReview.status}`}>
          <strong>{planReviewStatusLabel(planReview.status)}</strong>
          <span>{formatDateTime(planReview.updatedAt)}</span>
        </div>
      ) : null}
      {plan.summary ? <p>{plan.summary}</p> : null}
      <ol>
        {plan.items.map((item, index) => (
          <li key={`${item.text}-${index}`} className={item.status ? `status-${item.status}` : undefined}>
            <span>{planItemStatusLabel(item.status)}</span>
            <strong>{item.text}</strong>
          </li>
        ))}
      </ol>
      {onPlanAction && runId && reviewStatus !== "approved" ? (
        <div className="task-run-plan-actions">
          <button type="button" className="secondary-command" disabled={isPlanActionBusy} onClick={() => onPlanAction("approve")}>
            Approve
          </button>
          <button type="button" className="secondary-command" disabled={isPlanActionBusy} onClick={() => onPlanAction("request_revision")}>
            Revise
          </button>
          <button type="button" className="secondary-command" disabled={isPlanActionBusy} onClick={() => onPlanAction("cancel")}>
            Cancel
          </button>
        </div>
      ) : null}
      {approvalPrompt && onDraftApproval && reviewStatus === "approved" ? (
        <div className="task-run-plan-actions">
          <button type="button" className="secondary-command" onClick={() => onDraftApproval(approvalPrompt)}>
            Use approved plan
          </button>
          {worktreePrompt && onDraftWorktreeApproval ? (
            <button
              type="button"
              className="secondary-command"
              disabled={!canCreateWorktree}
              title={
                canCreateWorktree
                  ? "Draft this approved plan and arm a new task worktree"
                  : "Select a git project before using task worktrees"
              }
              onClick={() => onDraftWorktreeApproval(worktreePrompt)}
            >
              Start worktree
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function buildTaskRunPlanApprovalPrompt(run: AgentTaskRun, options: { worktree?: boolean } = {}) {
  if (!run.planMode?.enabled || !run.plan || (!run.plan.summary && run.plan.items.length === 0)) {
    return undefined;
  }
  const lines = [
    options.worktree
      ? `Proceed with the approved plan from Arivu task run ${run.id} in a new isolated task worktree.`
      : `Proceed with the approved plan from Arivu task run ${run.id}.`,
    options.worktree
      ? "Use the task worktree for edits and verification, while keeping the work scoped to the approved plan."
      : "Use normal tools, edits, and verification as needed now, while keeping the work scoped to the approved plan.",
    run.promptPreview ? `Original request: ${run.promptPreview}` : undefined,
    "",
    "Approved plan:",
    run.plan.summary ? `- Summary: ${run.plan.summary}` : undefined,
    ...run.plan.items.map((item, index) => `${index + 1}. ${item.text}`),
    "",
    "Before editing, re-check any relevant files if needed. After changes, run the first focused verification that fits the plan and summarize the result."
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

export function taskWorktreeActionsForRun(run: AgentTaskRun) {
  const worktree = run.worktree;
  if (!worktree?.enabled) {
    return [];
  }

  const verificationBlocked = run.verification?.status === "failed";
  const verificationBlockedReason = verificationBlocked ? "Resolve failed verification before promoting this task worktree" : undefined;
  const conflictBlockedReason = worktree.conflict ? "Resolve or abort the task worktree conflict before promoting this branch" : undefined;
  const promotionBlocked = verificationBlocked || Boolean(worktree.conflict);
  const promotionBlockedReason = conflictBlockedReason ?? verificationBlockedReason;
  const actions: Array<{
    id: TaskWorktreeAction;
    label: string;
    title: string;
    icon: ReactNode;
    disabled?: boolean;
    disabledReason?: string;
  }> = [];
  if (worktree.path && !["discarded", "cleaned"].includes(worktree.status)) {
    actions.push({
      id: "open",
      label: "Open",
      title: "Open this task worktree folder",
      icon: <FolderOpen size={12} />
    });
  }
  if (worktree.status === "ready") {
    actions.push({
      id: "refresh",
      label: "Refresh",
      title: "Refresh task worktree diff",
      icon: <RefreshCw size={12} />
    });
    if (!["queued", "running"].includes(run.status)) {
      actions.push({
        id: "preview",
        label: "Preview",
        title: worktree.conflict
          ? "Resolve or abort conflicts before generating a patch preview"
          : "Generate a patch preview before merging",
        icon: <FileText size={12} />,
        disabled: Boolean(worktree.conflict),
        disabledReason: conflictBlockedReason
      });
      actions.push({
        id: "sync",
        label: "Sync",
        title: worktree.conflict
          ? "Conflict resolution is already in progress"
          : "Sync this task branch with the current original checkout",
        icon: <GitBranch size={12} />,
        disabled: Boolean(worktree.conflict),
        disabledReason: conflictBlockedReason
      });
      const canMerge = Boolean(worktree.patchPreview) || worktree.diff?.hasChanges === false;
      if (worktree.patchPreview && !worktree.pullRequest?.url) {
        actions.push({
          id: "prepare_pr",
          label: "PR draft",
          title: "Prepare a pull request draft for this task worktree",
          icon: <GitPullRequest size={12} />,
          disabled: promotionBlocked,
          disabledReason: promotionBlockedReason
        });
      }
      if (worktree.pullRequest?.remoteName && worktree.pullRequest.baseBranch && !worktree.pullRequest.url) {
        actions.push({
          id: "create_pr",
          label: "Create PR",
          title: "Push this task branch and create a draft pull request",
          icon: <GitPullRequest size={12} />,
          disabled: promotionBlocked,
          disabledReason: promotionBlockedReason
        });
      }
      actions.push({
        id: "discard",
        label: "Discard",
        title: "Delete this task worktree and its task branch",
        icon: <Trash2 size={12} />
      });
      if (canMerge) {
        actions.splice(2, 0, {
          id: "merge",
          label: "Merge",
          title: "Fast-forward merge this previewed task worktree into the original checkout",
          icon: <Check size={12} />,
          disabled: promotionBlocked,
          disabledReason: promotionBlockedReason
        });
      }
    }
  } else if (worktree.status === "merged") {
    actions.push({
      id: "cleanup",
      label: "Clean up",
      title: "Remove the merged task worktree and task branch",
      icon: <Scissors size={12} />
    });
  } else if (worktree.status === "failed" && worktree.path && worktree.branch) {
    actions.push({
      id: "discard",
      label: "Discard",
      title: "Delete this failed task worktree and its task branch",
      icon: <Trash2 size={12} />
    });
  }
  return actions;
}

export function taskWorktreeVerificationGate(run: AgentTaskRun, sourceRun?: AgentTaskRun) {
  const verification = run.verification;
  const worktree = run.worktree;
  if (!verification) {
    return {
      status: "unknown",
      message: "No verification summary yet. Preview remains available; run checks before PR or merge."
    };
  }
  if (verification.status === "failed") {
    return {
      status: "failed",
      message: `Promotion blocked: ${verification.summary}`
    };
  }
  if (verification.status === "unknown") {
    return {
      status: "unknown",
      message: verification.summary
    };
  }
  if (verification.status === "passed" && worktree?.enabled && worktree.status === "ready") {
    const intro =
      worktree.continuedFromTaskRunId || sourceRun?.verification?.status === "failed" ? "Repair verified" : "Verification passed";
    if (worktree.pullRequest?.url) {
      return {
        status: "passed",
        message: `${intro}: draft PR created. Continue review in GitHub or clean up after merge.`
      };
    }
    if (worktree.pullRequest?.remoteName && worktree.pullRequest.baseBranch) {
      return {
        status: "passed",
        message: `${intro}: PR draft is prepared. Create PR is available.`
      };
    }
    if (worktree.patchPreview) {
      return {
        status: "passed",
        message: `${intro}: patch preview is ready. PR draft or merge can proceed.`
      };
    }
    if (worktree.diff?.hasChanges === false) {
      return {
        status: "passed",
        message: `${intro}: no worktree changes are currently recorded. Refresh if the branch changed.`
      };
    }
    return {
      status: "passed",
      message: `${intro}: generate a patch preview before PR draft or merge.`
    };
  }
  return undefined;
}

export function worktreeDiffLabel(diff: AgentTaskRunWorktreeDiff | undefined) {
  if (!diff) {
    return undefined;
  }
  if (!diff.hasChanges) {
    return "No changes";
  }
  const stats = [diff.insertions ? `+${diff.insertions}` : "", diff.deletions ? `-${diff.deletions}` : ""].filter(Boolean);
  return `${diff.files} file${diff.files === 1 ? "" : "s"}${stats.length ? ` ${stats.join(" ")}` : ""}`;
}

export function worktreePatchDiffPreview(preview: AgentTaskRunWorktreePatchPreview | undefined): DiffPreview | null {
  if (!preview?.text.trim()) {
    return null;
  }
  return {
    ...parseUnifiedDiffPreview(preview.text),
    title: preview.truncated ? "Task patch preview (truncated)" : "Task patch preview"
  };
}

export function taskRunPlanActionStatus(action: TaskRunPlanAction) {
  switch (action) {
    case "approve":
      return "Plan approved";
    case "request_revision":
      return "Plan revision requested";
    case "cancel":
      return "Plan cancelled";
    default:
      return "Plan review updated";
  }
}

export function formatPrStatusToken(value: string) {
  return value
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .join(" ");
}

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Image as ImageIcon,
  RotateCcw,
  Shield,
  TerminalSquare,
  Wrench
} from "lucide-react";
import { writeClipboardText } from "../../format";
import { buildTaskRunAuditMarkdown } from "../../../../../src/agent/taskRunAudit";
import {
  activityGroupEyebrow,
  approvalStatusLabel,
  toolActivityCountLabel,
  toolRunDetailPreview,
  toolRunEntriesFromItems,
  toolRunEntryKindLabel,
  toolRunSummaryLabel
} from "./activityModel";
import type { ActivityEvidenceLink, ActivityGroup, ActivityItem, ActivityPolicyDetail, ToolRunEntry } from "./activityTypes";
import { policyEffectLabel, trustModeLabel } from "./capabilityPresentation";
import { DiffBlock } from "./DiffBlock";
import {
  TaskRunLoop,
  TaskRunMeta,
  TaskRunPlan,
  TaskRunVerification,
  TaskWorktreeActions,
  buildTaskRunPlanApprovalPrompt,
  pullRequestWatchForRun
} from "../worktrees/WorktreeActivity";
import type { DraftPromptOptions, PullRequestWatch, TaskRunPlanAction } from "../worktrees/worktreeTypes";
import type { TaskWorktreeAction, TaskWorktreeActionOptions } from "../worktrees/worktreePresentation";
import { parseUnifiedDiffPreview, splitLines, type DiffPreview } from "../../shared/diff";
import { parseMaybeJson } from "../../shared/json";
import { isRecord } from "../../shared/typeGuards";

export function ToolRunSummary({ group }: { group: ActivityGroup }) {
  const [expanded, setExpanded] = useState(group.status === "running");
  const entries = toolRunEntriesFromItems(group.items);
  if (entries.length === 0) {
    return null;
  }

  return (
    <section className={`tool-run-summary ${group.status}`} aria-label={`Activity for ${group.title}`}>
      <button
        className="tool-run-summary-button"
        type="button"
        aria-expanded={expanded}
        title={expanded ? "Collapse tool calls" : "Expand tool calls"}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="tool-run-icon">{group.status === "running" ? <span className="pulse-dot" /> : <TerminalSquare size={13} />}</span>
        <strong>{toolRunSummaryLabel(group)}</strong>
        <span title={group.detail}>For this query: {group.title}</span>
      </button>
      {group.run ? <TaskRunMeta run={group.run} compact /> : null}
      {expanded ? (
        <div className="tool-run-list">
          {entries.map((entry, itemIndex) => (
            <ToolRunEntryRow entry={entry} step={itemIndex + 1} key={entry.id} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function ToolRunEntryRow({ entry, step }: { entry: ToolRunEntry; step: number }) {
  const callPreview = entry.call ? toolRunDetailPreview(entry.call) : undefined;
  const resultPreview = entry.result ? toolRunDetailPreview(entry.result) : undefined;
  const itemPreview = entry.item ? toolRunDetailPreview(entry.item) : undefined;
  const status = entry.status;
  return (
    <div className={`tool-run-item ${entry.kind}${status ? ` status-${status}` : ""}`}>
      <span className="tool-run-step">{step}</span>
      <span className="tool-run-kind">{toolRunEntryKindLabel(entry)}</span>
      <strong>{entry.title}</strong>
      {status ? <span className={`activity-status ${status}`}>{activityStatusLabel(status)}</span> : null}
      {entry.imagePreview ? <span className="tool-run-chip">Screenshot</span> : null}
      {entry.policy ? <ActivityPolicyChip policy={entry.policy} compact /> : null}
      {entry.call?.summary ? (
        <p>
          <span>Call</span>
          {entry.call.summary}
        </p>
      ) : null}
      {entry.result?.summary ? (
        <p>
          <span>Result</span>
          {entry.result.summary}
        </p>
      ) : null}
      {entry.item?.summary ? <p>{entry.item.summary}</p> : null}
      {callPreview ? <pre data-label="Call args">{callPreview}</pre> : null}
      {resultPreview ? <pre data-label="Result">{resultPreview}</pre> : null}
      {itemPreview ? <pre>{itemPreview}</pre> : null}
    </div>
  );
}

export function RunCheckpointCard({ run, busy, onUndo }: { run: AgentTaskRun; busy: boolean; onUndo: () => void }) {
  const checkpoint = run.checkpoint;
  if (!checkpoint) {
    return null;
  }
  const count = checkpoint.changedPaths.length;
  const fileLabel = `${count} file${count === 1 ? "" : "s"}`;
  return (
    <div className="run-checkpoint-card">
      <div className="run-checkpoint-summary">
        <RotateCcw size={13} />
        {checkpoint.revertedAt ? (
          <span>Reverted this run's changes to {fileLabel}.</span>
        ) : (
          <span>This run changed {fileLabel} directly in the workspace.</span>
        )}
      </div>
      {checkpoint.revertedAt ? null : (
        <button type="button" className="run-checkpoint-undo" onClick={onUndo} disabled={busy}>
          {busy ? "Undoing…" : "Undo run changes"}
        </button>
      )}
    </div>
  );
}

export function ActivityGroupCard({
  group,
  currentSessionId,
  focusedRunId,
  worktreeActionBusy,
  planReviewBusy,
  evidenceOpenBusy,
  pullRequestWatches,
  pullRequestWatchBusy,
  canCreateWorktree,
  onTaskWorktreeAction,
  onTaskRunPlanAction,
  onTogglePullRequestWatch,
  onFocusTaskRun,
  onOpenEvidence,
  onDraftRemediation,
  onUndoRun,
  undoBusyRunId
}: {
  group: ActivityGroup;
  currentSessionId?: string;
  focusedRunId: string | null;
  worktreeActionBusy: string | null;
  planReviewBusy: string | null;
  evidenceOpenBusy: string | null;
  pullRequestWatches: Record<string, PullRequestWatch>;
  pullRequestWatchBusy: Record<string, boolean>;
  canCreateWorktree: boolean;
  onTaskWorktreeAction: (run: AgentTaskRun, action: TaskWorktreeAction, options?: TaskWorktreeActionOptions) => void;
  onTaskRunPlanAction: (run: AgentTaskRun, action: TaskRunPlanAction) => void;
  onTogglePullRequestWatch: (run: AgentTaskRun) => void;
  onFocusTaskRun: (run: AgentTaskRun) => void;
  onOpenEvidence: (link: ActivityEvidenceLink) => void;
  onDraftRemediation: (draftText: string, options?: DraftPromptOptions) => void;
  onUndoRun: (run: AgentTaskRun) => void;
  undoBusyRunId: string | null;
}) {
  const [collapsed, setCollapsed] = useState(group.status !== "running");
  const [copiedAudit, setCopiedAudit] = useState(false);
  const auditCopyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousStatusRef = useRef(group.status);
  const toolCountLabel = toolActivityCountLabel(group.items);
  const focused = Boolean(group.run && group.run.id === focusedRunId);
  const planApprovalPrompt = group.run ? buildTaskRunPlanApprovalPrompt(group.run) : undefined;
  const planWorktreePrompt = group.run ? buildTaskRunPlanApprovalPrompt(group.run, { worktree: true }) : undefined;

  useEffect(() => {
    if (focused) {
      setCollapsed(false);
    }
  }, [focused]);

  useEffect(() => {
    if (previousStatusRef.current === "running" && group.status !== "running") {
      setCollapsed(true);
    }
    previousStatusRef.current = group.status;
  }, [group.status]);

  useEffect(() => {
    return () => {
      if (auditCopyResetTimeoutRef.current) {
        clearTimeout(auditCopyResetTimeoutRef.current);
      }
    };
  }, []);

  async function copyAuditSummary() {
    if (!group.run) {
      return;
    }
    try {
      await writeClipboardText(buildTaskRunAuditMarkdown(group.run));
      setCopiedAudit(true);
      if (auditCopyResetTimeoutRef.current) {
        clearTimeout(auditCopyResetTimeoutRef.current);
      }
      auditCopyResetTimeoutRef.current = setTimeout(() => {
        setCopiedAudit(false);
        auditCopyResetTimeoutRef.current = null;
      }, 1400);
    } catch {
      setCopiedAudit(false);
    }
  }

  return (
    <section className={`activity-group ${group.status}${focused ? " focus-active" : ""}`} data-activity-run-id={group.run?.id}>
      <button
        className="activity-group-header"
        type="button"
        aria-expanded={!collapsed}
        title={collapsed ? "Expand query tool activity" : "Collapse query tool activity"}
        onClick={() => setCollapsed((current) => !current)}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <div className="activity-group-title">
          <span>{activityGroupEyebrow(group)}</span>
          <strong title={group.detail}>{group.title}</strong>
        </div>
        <span className="activity-group-count">{toolCountLabel}</span>
        <span className={`activity-status ${group.status}`}>{activityStatusLabel(group.status)}</span>
      </button>
      {group.run ? (
        <button
          className="activity-group-audit-button"
          type="button"
          onClick={() => void copyAuditSummary()}
          title={copiedAudit ? "Copied audit summary" : "Copy audit summary"}
          aria-label={copiedAudit ? "Copied audit summary" : "Copy audit summary"}
        >
          {copiedAudit ? <Check size={12} /> : <Copy size={12} />}
        </button>
      ) : null}
      {!collapsed ? (
        <div className="activity-group-body">
          {group.run ? <TaskRunMeta run={group.run} /> : null}
          {group.run?.loop?.iterations?.length ? <TaskRunLoop loop={group.run.loop} /> : null}
          {group.run?.verification ? <TaskRunVerification verification={group.run.verification} /> : null}
          {group.run?.plan ? (
            <TaskRunPlan
              plan={group.run.plan}
              planReview={group.run.planReview}
              approvalPrompt={planApprovalPrompt}
              worktreePrompt={planWorktreePrompt}
              canCreateWorktree={canCreateWorktree}
              actionBusyKey={planReviewBusy}
              runId={group.run.id}
              onDraftApproval={(draftText) =>
                onDraftRemediation(draftText, {
                  status: "Approved-plan prompt drafted",
                  confirmLabel: "Replace the composer with this approved-plan prompt?"
                })
              }
              onDraftWorktreeApproval={(draftText) =>
                group.run &&
                onDraftRemediation(draftText, {
                  worktreePlanSource: { taskRunId: group.run.id },
                  status: "Approved plan drafted in a task worktree",
                  confirmLabel: "Replace the composer and arm a new task worktree for this approved plan?"
                })
              }
              onPlanAction={(action) => group.run && onTaskRunPlanAction(group.run, action)}
            />
          ) : null}
          {group.run ? (
            <TaskWorktreeActions
              run={group.run}
              sourceRun={group.sourceRun}
              planSourceRun={group.planSourceRun}
              attemptRuns={group.worktreeAttemptRuns}
              focusedRunId={focusedRunId}
              busyKey={worktreeActionBusy}
              pullRequestWatch={pullRequestWatchForRun(currentSessionId, group.run, pullRequestWatches, pullRequestWatchBusy)}
              onAction={onTaskWorktreeAction}
              onTogglePullRequestWatch={onTogglePullRequestWatch}
              onFocusAttempt={onFocusTaskRun}
              onDraftRemediation={onDraftRemediation}
            />
          ) : null}
          {group.run && group.run.checkpoint && !group.run.worktree?.enabled ? (
            <RunCheckpointCard run={group.run} busy={undoBusyRunId === group.run.id} onUndo={() => group.run && onUndoRun(group.run)} />
          ) : null}
          {group.items.map((item) => (
            <ActivityRow
              key={item.id}
              item={item}
              defaultCollapsed
              evidenceOpenBusy={evidenceOpenBusy}
              onOpenEvidence={onOpenEvidence}
              onDraftRemediation={onDraftRemediation}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function ActivityRow({
  item,
  defaultCollapsed,
  evidenceOpenBusy,
  onOpenEvidence,
  onDraftRemediation
}: {
  item: ActivityItem;
  defaultCollapsed?: boolean;
  evidenceOpenBusy?: string | null;
  onOpenEvidence?: (link: ActivityEvidenceLink) => void;
  onDraftRemediation?: (draftText: string, options?: DraftPromptOptions) => void;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? item.kind === "system");
  const diff = item.diffPreview ?? buildActivityDiffPreview(item);
  const evidenceLinks = item.evidenceLinks ?? [];
  const showEvidenceActions =
    (evidenceLinks.length > 0 && onOpenEvidence) || ((item.remediationPrompt || item.rollbackPrompt) && onDraftRemediation);

  return (
    <article className={activityRowClassName(item, collapsed)}>
      <button
        className="activity-title"
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((current) => !current)}
        title={collapsed ? "Expand details" : "Collapse details"}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span>{item.kind}</span>
        <strong>{item.title}</strong>
        {item.policy ? <ActivityPolicyChip policy={item.policy} /> : null}
        {item.status ? <span className={`activity-status ${item.status}`}>{activityStatusLabel(item.status)}</span> : null}
      </button>
      {!collapsed ? (
        <div className="activity-body">
          {item.summary ? <p className="activity-summary">{item.summary}</p> : null}
          {item.policy ? <ActivityPolicyDetails policy={item.policy} /> : null}
          {showEvidenceActions ? (
            <div className="activity-evidence-actions" aria-label="Task-run evidence actions">
              {onOpenEvidence
                ? evidenceLinks.map((link) => (
                    <button
                      key={link.id}
                      className="activity-evidence-button"
                      type="button"
                      disabled={evidenceOpenBusy === link.id}
                      title={link.title}
                      onClick={() => onOpenEvidence(link)}
                    >
                      <FileText size={13} />
                      <span>{evidenceOpenBusy === link.id ? "Opening..." : link.label}</span>
                    </button>
                  ))
                : null}
              {item.remediationPrompt && onDraftRemediation ? (
                <button
                  className="activity-evidence-button repair"
                  type="button"
                  title="Draft a repair prompt from this report evidence"
                  onClick={() => onDraftRemediation(item.remediationPrompt ?? "")}
                >
                  <Wrench size={13} />
                  <span>Draft fix</span>
                </button>
              ) : null}
              {item.rollbackPrompt && onDraftRemediation ? (
                <button
                  className="activity-evidence-button repair"
                  type="button"
                  title="Draft a revert prompt for this edit artifact"
                  onClick={() =>
                    onDraftRemediation(item.rollbackPrompt ?? "", {
                      status: "Drafted revert prompt from edit evidence",
                      confirmLabel: "Replace the current composer draft with a revert prompt from this edit evidence?"
                    })
                  }
                >
                  <RotateCcw size={13} />
                  <span>Draft revert</span>
                </button>
              ) : null}
            </div>
          ) : null}
          {item.imagePreview ? <ActivityScreenshotPreview preview={item.imagePreview} /> : null}
          {diff ? <DiffBlock preview={diff} /> : item.detail ? <pre>{item.detail}</pre> : null}
        </div>
      ) : null}
    </article>
  );
}

export function ActivityPolicyChip({ policy, compact = false }: { policy: ActivityPolicyDetail; compact?: boolean }) {
  const label = compact ? activityPolicyShortLabel(policy) : activityPolicyLabel(policy);
  return (
    <span className={`activity-policy-chip ${policy.effect ?? "inferred"}`} title={activityPolicyTitle(policy)}>
      <Shield size={compact ? 10 : 11} />
      {label}
    </span>
  );
}

export function ActivityPolicyDetails({ policy }: { policy: ActivityPolicyDetail }) {
  const metadata = [
    policy.trustMode ? `Trust: ${trustModeLabel(policy.trustMode)}` : undefined,
    policy.status ? `Audit: ${approvalStatusLabel(policy.status)}` : undefined,
    policy.effect ? `Effect: ${policyEffectLabel(policy.effect)}` : undefined,
    policy.override ? `Override: ${policy.override}` : undefined,
    policy.risky !== undefined ? `Risk: ${policy.risky ? "risky action" : "standard action"}` : undefined,
    policy.scope ? `Scope: ${approvalScopeLabel(policy.scope)}` : undefined
  ].filter((item): item is string => Boolean(item));
  return (
    <div className={`activity-policy-detail ${policy.effect ?? "inferred"}`}>
      <div>
        <Shield size={13} />
        <span>{policy.capabilityLabel}</span>
        <strong>{activityPolicyLabel(policy)}</strong>
      </div>
      {policy.reason ? <p>{policy.reason}</p> : <p>{activityPolicyFallbackReason(policy)}</p>}
      {policy.summary ? <small>{policy.summary}</small> : null}
      {metadata.length > 0 ? (
        <div className="activity-policy-meta">
          {metadata.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function activityPolicyShortLabel(policy: ActivityPolicyDetail) {
  if (policy.effect) {
    return `${policy.capabilityLabel} · ${policyEffectLabel(policy.effect)}`;
  }
  return policy.capabilityLabel;
}

export function activityPolicyLabel(policy: ActivityPolicyDetail) {
  if (policy.label && policy.effect) {
    return `${policy.label} · ${policyEffectLabel(policy.effect)}`;
  }
  if (policy.label) {
    return policy.label;
  }
  if (policy.effect) {
    return policyEffectLabel(policy.effect);
  }
  return policy.source === "inferred" ? "Inferred capability" : "Recorded capability";
}

export function activityPolicyTitle(policy: ActivityPolicyDetail) {
  const lines = [
    `Capability: ${policy.capabilityLabel}`,
    policy.effect ? `Effect: ${policyEffectLabel(policy.effect)}` : undefined,
    policy.status ? `Audit: ${approvalStatusLabel(policy.status)}` : undefined,
    policy.trustMode ? `Trust mode: ${trustModeLabel(policy.trustMode)}` : undefined,
    policy.override ? `Workspace override: ${policy.override}` : undefined,
    policy.scope ? `Scope: ${approvalScopeLabel(policy.scope)}` : undefined,
    policy.reason
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

export function approvalScopeLabel(scope: AgentTaskRunApprovalScope) {
  return [scope.label, scope.value].filter(Boolean).join(": ");
}

export function activityPolicyFallbackReason(policy: ActivityPolicyDetail) {
  if (policy.source === "inferred") {
    return "Capability was inferred from the tool name because this row was restored from transcript protocol.";
  }
  if (policy.source === "tool") {
    return "Capability was recorded on the task run; no matching approval audit was found for this tool call.";
  }
  return "Policy audit details were recorded on the task run.";
}

export function LatestActivityScreenshot({ item }: { item: ActivityItem }) {
  if (!item.imagePreview) {
    return null;
  }

  return (
    <section className="activity-latest-screenshot" aria-label="Latest browser screenshot">
      <div className="activity-latest-heading">
        <ImageIcon size={13} />
        <span>Latest screenshot</span>
      </div>
      {item.summary ? <p>{item.summary}</p> : null}
      <ActivityScreenshotPreview preview={item.imagePreview} compact />
    </section>
  );
}

export function ActivityScreenshotPreview({
  preview,
  compact = false
}: {
  preview: NonNullable<ActivityItem["imagePreview"]>;
  compact?: boolean;
}) {
  const [imageState, setImageState] = useState<{ src: string | null; failed: boolean }>({ src: null, failed: false });

  useEffect(() => {
    let cancelled = false;
    setImageState({ src: null, failed: false });

    if (/^(?:data|blob|https?|file):/i.test(preview.path)) {
      setImageState({ src: localImageSrc(preview.path), failed: false });
      return () => {
        cancelled = true;
      };
    }

    window.arivu
      .readLocalImage(preview.path)
      .then((image) => {
        if (!cancelled) {
          setImageState({ src: image.dataUrl, failed: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setImageState({ src: localImageSrc(preview.path), failed: false });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [preview.path]);

  return (
    <figure className={compact ? "activity-screenshot compact" : "activity-screenshot"}>
      {!imageState.failed && imageState.src ? (
        <img src={imageState.src} alt={preview.caption} onError={() => setImageState({ src: null, failed: true })} />
      ) : imageState.failed ? (
        <div className="activity-screenshot-missing">Screenshot file unavailable</div>
      ) : (
        <div className="activity-screenshot-loading">Loading screenshot...</div>
      )}
      <figcaption>{preview.caption}</figcaption>
    </figure>
  );
}

export function activityRowClassName(item: ActivityItem, collapsed: boolean) {
  return [
    "activity-row",
    item.kind,
    item.status ? `status-${item.status}` : "",
    item.imagePreview ? "has-image-preview" : "",
    collapsed ? "collapsed" : ""
  ]
    .filter(Boolean)
    .join(" ");
}

export function activityStatusLabel(status: NonNullable<ActivityItem["status"]>) {
  if (status === "running") {
    return "Running";
  }
  if (status === "done") {
    return "Done";
  }
  if (status === "failed") {
    return "Failed";
  }
  return "Waiting";
}

export function localImageSrc(filePath: string) {
  if (/^(?:data|blob|https?|file):/i.test(filePath)) {
    return filePath;
  }

  const normalized = filePath.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${normalized.split("/").map(encodeURIComponent).join("/")}`;
  }
  if (normalized.startsWith("/")) {
    return `file://${normalized
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/")}`;
  }
  return normalized;
}

export function buildActivityDiffPreview(item: ActivityItem): DiffPreview | null {
  if (item.kind !== "call") {
    return null;
  }

  const args = parseToolArguments(item.detail);
  if (item.title === "apply_patch" && isRecord(args) && typeof args.diff === "string") {
    return parseUnifiedDiffPreview(args.diff);
  }

  if (item.title === "write_file" && isRecord(args) && typeof args.content === "string") {
    const path = typeof args.path === "string" ? args.path : "write_file";
    return {
      title: path,
      lines: splitLines(args.content).map((text, index) => ({
        kind: "add",
        newNumber: index + 1,
        text
      }))
    };
  }

  return null;
}

export function parseToolArguments(detail: string): unknown {
  const parsed = parseMaybeJson(detail);
  if (typeof parsed === "string") {
    return parseMaybeJson(parsed) ?? parsed;
  }
  return parsed;
}

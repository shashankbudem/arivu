import type { DiffPreview } from "../../shared/diff";

export type ActivityItem = {
  id: string;
  kind: "call" | "result" | "approval" | "system";
  toolCallId?: string;
  title: string;
  detail: string;
  summary?: string;
  status?: "running" | "done" | "waiting" | "failed";
  imagePreview?: {
    path: string;
    width?: number;
    height?: number;
    caption: string;
  };
  diffPreview?: DiffPreview;
  evidenceLinks?: ActivityEvidenceLink[];
  remediationPrompt?: string;
  rollbackPrompt?: string;
  policy?: ActivityPolicyDetail;
};

export type ActivityPolicyDetail = {
  capability: AgentTaskRunCapability;
  capabilityLabel: string;
  source: "approval" | "tool" | "inferred";
  label?: string;
  reason?: string;
  effect?: AgentTaskRunApprovalEffect;
  status?: AgentTaskRunApprovalStatus;
  trustMode?: TrustMode;
  risky?: boolean;
  override?: AgentTaskRunApprovalOverride;
  scope?: AgentTaskRunApprovalScope;
  summary?: string;
};

export type ActivityEvidenceLink = {
  id: string;
  label: string;
  title: string;
  taskRunId: string;
  artifactId: string;
  path: string;
  line?: number;
  kind: "report" | "source" | "diagnostic";
};

export type ActivityGroupStatus = "running" | "done" | "waiting" | "failed";

export type ActivityGroup = {
  id: string;
  userMessageIndex: number | null;
  title: string;
  detail: string;
  items: ActivityItem[];
  status: ActivityGroupStatus;
  run?: AgentTaskRun;
  sourceRun?: AgentTaskRun;
  planSourceRun?: AgentTaskRun;
  worktreeAttemptRuns?: AgentTaskRun[];
};

export type ActivityModel = {
  items: ActivityItem[];
  systemItems: ActivityItem[];
  groups: ActivityGroup[];
  groupsByUserMessageIndex: Map<number, ActivityGroup>;
};

export type ToolRunEntry = {
  id: string;
  kind: "tool" | "approval" | "event";
  title: string;
  status?: ActivityItem["status"];
  call?: ActivityItem;
  result?: ActivityItem;
  item?: ActivityItem;
  policy?: ActivityPolicyDetail;
  imagePreview?: ActivityItem["imagePreview"];
};

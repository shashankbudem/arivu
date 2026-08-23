export type PullRequestWatch = {
  sessionId: string;
  taskRunId: string;
  startedAt: string;
  lastRefreshedAt?: string;
  lastError?: string;
};

export type PullRequestWatchView = {
  active: boolean;
  refreshing: boolean;
  lastRefreshedAt?: string;
  lastError?: string;
};

export type WorktreeContinuation = {
  taskRunId: string;
  branch?: string;
  replayOfTaskRunId?: string;
};

export type WorktreePlanSource = {
  taskRunId: string;
};

export type DraftPromptOptions = {
  worktreeContinuation?: WorktreeContinuation;
  worktreePlanSource?: WorktreePlanSource;
  status?: string;
  confirmLabel?: string;
};

export type TaskRunPlanAction = "approve" | "request_revision" | "cancel";

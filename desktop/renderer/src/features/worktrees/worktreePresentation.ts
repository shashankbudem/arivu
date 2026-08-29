export type TaskWorktreeAction =
  | "open"
  | "refresh"
  | "preview"
  | "merge"
  | "discard"
  | "cleanup"
  | "prepare_pr"
  | "create_pr"
  | "refresh_pr"
  | "fetch_pr_check_logs"
  | "sync"
  | "continue_conflict"
  | "abort_conflict"
  | "open_conflict_file";

export type TaskWorktreeActionOptions = {
  conflictPath?: string;
};

export function verificationStatusLabel(status: AgentTaskRunVerification["status"]) {
  switch (status) {
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "unknown":
      return "Unknown";
  }
}

export function worktreeStatusLabel(status: AgentTaskRunWorktreeStatus) {
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
    default:
      return status;
  }
}

export function taskWorktreeInventorySummary(items: TaskWorktreeInventoryItem[]) {
  const present = items.filter((item) => item.folderExists).length;
  if (items.length === 0) {
    return "No recorded task worktrees";
  }
  return `${items.length} recorded, ${present} present`;
}

export function worktreeInventoryStatusLabel(item: TaskWorktreeInventoryItem) {
  const folder = item.folderExists ? "present" : "missing";
  const pr = item.pullRequestUrl ? " - PR created" : item.pullRequestPreparedAt ? " - PR draft" : "";
  return `${worktreeStatusLabel(item.worktreeStatus)} - ${folder}${pr} - ${item.sessionTitle}`;
}

export function confirmInventoryWorktreeAction(item: TaskWorktreeInventoryItem, action: TaskWorktreeAction) {
  const label = item.branch ?? "this task worktree";
  const missingNote = item.folderExists
    ? ""
    : "\n\nThe recorded folder is missing; Arivu will prune the worktree record and delete the task branch where possible.";
  if (action === "discard") {
    return window.confirm(
      `Discard ${label}? This deletes the managed task worktree and its task branch. The original checkout stays unchanged.${missingNote}`
    );
  }
  if (action === "cleanup") {
    return window.confirm(`Clean up ${label}? This removes the merged task worktree and its task branch.${missingNote}`);
  }
  if (action === "create_pr") {
    return confirmCreatePullRequest({ title: item.pullRequestTitle ?? label, branch: item.branch ?? label });
  }
  return true;
}

export function confirmCreatePullRequest(pullRequest: Pick<AgentTaskRunWorktreePullRequest, "title" | "branch"> | undefined) {
  const label = pullRequest?.title ?? pullRequest?.branch ?? "this task worktree";
  return window.confirm(`Create a draft pull request for ${label}? Arivu will push the task branch and run GitHub CLI.`);
}

export function taskWorktreeActionStatus(action: TaskWorktreeAction) {
  switch (action) {
    case "open":
      return "Task worktree opened";
    case "refresh":
      return "Task worktree refreshed";
    case "preview":
      return "Task worktree patch previewed";
    case "merge":
      return "Task worktree merged";
    case "discard":
      return "Task worktree discarded";
    case "cleanup":
      return "Task worktree cleaned up";
    case "prepare_pr":
      return "Task worktree PR draft prepared";
    case "create_pr":
      return "Task worktree PR created";
    case "refresh_pr":
      return "Task worktree PR status refreshed";
    case "fetch_pr_check_logs":
      return "Task worktree PR check evidence saved";
    case "sync":
      return "Task worktree synced";
    case "continue_conflict":
      return "Task worktree conflict continued";
    case "abort_conflict":
      return "Task worktree conflict aborted";
    case "open_conflict_file":
      return "Task worktree conflict file opened";
    default:
      return "Task worktree updated";
  }
}

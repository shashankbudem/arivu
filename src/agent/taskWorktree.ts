import { access, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { execa } from "execa";
import { appDataDir } from "../config.js";
import type {
  AgentTaskRunVerification,
  AgentTaskRunWorktree,
  AgentTaskRunWorktreeConflict,
  AgentTaskRunWorktreeDiff,
  AgentTaskRunWorktreePatchPreview,
  AgentTaskRunWorktreePullRequest,
  AgentTaskRunWorktreePullRequestFeedback,
  AgentTaskRunWorktreePullRequestFeedbackItem,
  AgentTaskRunWorktreePullRequestCheckItem,
  AgentTaskRunWorktreePullRequestReview,
  AgentTaskRunWorktreePullRequestReviewNotification
} from "./types.js";

export const DEFAULT_TASK_WORKTREE_PATCH_PREVIEW_BYTES = 80_000;
const MAX_PULL_REQUEST_FEEDBACK_ITEMS = 5;
const MAX_PULL_REQUEST_CHECK_ITEMS = 8;
const MAX_PULL_REQUEST_REVIEW_NOTIFICATIONS = 8;
const MAX_PULL_REQUEST_FEEDBACK_BODY_CHARS = 240;
const MAX_PULL_REQUEST_REVIEW_THREADS = 20;
const PULL_REQUEST_REVIEW_THREADS_QUERY = `
query PullRequestReviewThreads($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: ${MAX_PULL_REQUEST_REVIEW_THREADS}) {
        nodes {
          isResolved
          path
          line
          originalLine
          comments(first: 10) {
            nodes {
              author {
                login
              }
              body
              path
              line
              originalLine
              url
              createdAt
              updatedAt
            }
          }
        }
      }
    }
  }
}
`;

export type PreparedTaskWorktree = {
  originalRoot: string;
  path: string;
  branch: string;
  baseRef: string;
  createdAt: string;
};

export type CreateTaskWorktreeOptions = {
  cwd: string;
  sessionId: string;
  taskRunId: string;
  worktreesRoot?: string;
};

export type TaskWorktreeActionResult = {
  status: AgentTaskRunWorktree["status"];
  diff?: AgentTaskRunWorktreeDiff;
  patchPreview?: AgentTaskRunWorktreePatchPreview;
  pullRequest?: AgentTaskRunWorktreePullRequest;
  conflict?: AgentTaskRunWorktreeConflict;
  mergeCommit?: string;
  mergedAt?: string;
  discardedAt?: string;
  cleanedAt?: string;
};

type TaskWorktreeActionOptions = {
  taskRunId?: string;
  promptPreview?: string;
  verification?: AgentTaskRunVerification;
  worktreesRoot?: string;
  patchPreviewBytes?: number;
  now?: string;
  commandRunner?: TaskWorktreeCommandRunner;
};

type TaskWorktreeCommandResult = {
  stdout: string;
  stderr?: string;
  exitCode?: number;
};

type TaskWorktreeCommandRunner = (
  file: string,
  args: string[],
  options: { cwd: string; reject?: boolean }
) => Promise<TaskWorktreeCommandResult>;

export async function createTaskWorktree(options: CreateTaskWorktreeOptions): Promise<PreparedTaskWorktree> {
  const originalRoot = await gitRootOrThrow(options.cwd);
  const baseRef = await gitHeadOrThrow(originalRoot);
  const safeSessionId = safeWorktreeSegment(options.sessionId);
  const safeRunId = safeWorktreeSegment(options.taskRunId);
  const worktreeRoot = path.join(options.worktreesRoot ?? path.join(appDataDir(), "task-worktrees"), safeSessionId);
  const worktreePath = path.join(worktreeRoot, safeRunId);
  const branch = `arivu/task-${safeRunId.slice(0, 12)}`;
  await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
  await execa("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], { cwd: originalRoot });
  return {
    originalRoot,
    path: worktreePath,
    branch,
    baseRef,
    createdAt: new Date().toISOString()
  };
}

export function taskWorktreeInstruction(worktree: PreparedTaskWorktree) {
  return [
    "Task worktree mode is active for this request.",
    `Run tools against the isolated git worktree at ${worktree.path}.`,
    `The original project root is ${worktree.originalRoot}.`,
    `The task branch is ${worktree.branch} at base ${worktree.baseRef}.`,
    "Do not assume edits are applied to the original checkout. Summarize the worktree path and branch when you make changes."
  ].join("\n");
}

export async function summarizeTaskWorktree(
  worktree: AgentTaskRunWorktree,
  options: TaskWorktreeActionOptions = {}
): Promise<AgentTaskRunWorktreeDiff> {
  const prepared = assertTaskWorktreeReady(worktree, options.worktreesRoot);
  await assertPathExists(prepared.path, "Task worktree no longer exists.");
  const status = await execa("git", ["status", "--porcelain=v1"], { cwd: prepared.path });
  const diffBase = prepared.baseRef ?? "HEAD";
  const shortstat = await execa("git", ["diff", "--shortstat", diffBase, "--"], { cwd: prepared.path });
  const diffNames = await execa("git", ["diff", "--name-only", diffBase, "--"], { cwd: prepared.path });
  const paths = mergeChangedPaths(changedPathsFromNameOnly(diffNames.stdout), changedPathsFromPorcelain(status.stdout));
  const stats = parseShortstat(shortstat.stdout);
  return {
    hasChanges: paths.length > 0,
    files: paths.length,
    insertions: stats.insertions,
    deletions: stats.deletions,
    changedPaths: paths,
    updatedAt: options.now ?? new Date().toISOString()
  };
}

export async function mergeTaskWorktree(
  worktree: AgentTaskRunWorktree,
  options: TaskWorktreeActionOptions = {}
): Promise<TaskWorktreeActionResult> {
  assertVerificationAllowsLifecycle(options.verification, "merging");
  const prepared = assertTaskWorktreeReady(worktree, options.worktreesRoot);
  await assertPathExists(prepared.path, "Task worktree no longer exists.");
  await assertCleanOriginal(prepared.originalRoot);
  if (!worktree.patchPreview && worktree.diff?.hasChanges !== false) {
    throw new Error("Preview the task worktree patch before merging.");
  }
  await commitTaskWorktreeChanges(prepared.path, options.taskRunId ?? prepared.branch);
  const diff = await summarizeTaskWorktree(worktree, options);
  const mergeCommit = await gitHeadOrThrow(prepared.path, { full: true });
  await execa("git", ["merge", "--ff-only", prepared.branch], { cwd: prepared.originalRoot });
  return {
    status: "merged",
    diff,
    mergeCommit,
    mergedAt: options.now ?? new Date().toISOString()
  };
}

export async function previewTaskWorktreePatch(
  worktree: AgentTaskRunWorktree,
  options: TaskWorktreeActionOptions = {}
): Promise<TaskWorktreeActionResult> {
  const prepared = assertTaskWorktreeReady(worktree, options.worktreesRoot);
  await assertPathExists(prepared.path, "Task worktree no longer exists.");
  const diff = await summarizeTaskWorktree(worktree, options);
  const patchText = await taskWorktreePatchText(prepared);
  return {
    status: worktree.status,
    diff,
    patchPreview: buildPatchPreview(patchText, options.patchPreviewBytes, options.now)
  };
}

export async function prepareTaskWorktreePullRequest(
  worktree: AgentTaskRunWorktree,
  options: TaskWorktreeActionOptions = {}
): Promise<TaskWorktreeActionResult> {
  assertVerificationAllowsLifecycle(options.verification, "preparing a PR draft");
  if (worktree.status !== "ready") {
    throw new Error("Only ready task worktrees can be prepared for PR.");
  }
  const prepared = assertTaskWorktreeReady(worktree, options.worktreesRoot);
  await assertPathExists(prepared.path, "Task worktree no longer exists.");
  const currentDiff = await summarizeTaskWorktree(worktree, options);
  if (currentDiff.hasChanges && !worktree.patchPreview) {
    throw new Error("Preview the task worktree patch before preparing a PR draft.");
  }

  await commitTaskWorktreeChanges(prepared.path, options.taskRunId ?? prepared.branch);
  const diff = await summarizeTaskWorktree(worktree, options);
  if (!diff.hasChanges) {
    throw new Error("No task worktree changes to prepare for PR.");
  }

  const commit = await gitHeadOrThrow(prepared.path, { full: true });
  const baseBranch = await currentBranch(prepared.originalRoot);
  const remote = await getRemote(prepared.originalRoot, "origin");
  const title = pullRequestTitle(options.promptPreview, prepared.branch);
  const body = pullRequestBody({
    promptPreview: options.promptPreview,
    branch: prepared.branch,
    baseBranch,
    baseRef: prepared.baseRef,
    commit,
    diff
  });
  const remoteName = remote ? "origin" : undefined;
  const pushCommand = remoteName
    ? `git -C ${shellQuote(prepared.path)} push -u ${shellQuote(remoteName)} ${shellQuote(prepared.branch)}`
    : undefined;
  const createCommand =
    remoteName && baseBranch
      ? [
          "gh pr create --draft",
          `--base ${shellQuote(baseBranch)}`,
          `--head ${shellQuote(prepared.branch)}`,
          `--title ${shellQuote(title)}`,
          `--body ${shellQuote(body)}`
        ].join(" ")
      : undefined;

  return {
    status: worktree.status,
    diff,
    pullRequest: {
      title,
      body,
      branch: prepared.branch,
      baseBranch,
      baseRef: prepared.baseRef,
      commit,
      remoteName,
      remoteUrl: remote,
      pushCommand,
      createCommand,
      preparedAt: options.now ?? new Date().toISOString()
    }
  };
}

export async function createTaskWorktreePullRequest(
  worktree: AgentTaskRunWorktree,
  options: TaskWorktreeActionOptions = {}
): Promise<TaskWorktreeActionResult> {
  assertVerificationAllowsLifecycle(options.verification, "creating a PR");
  if (worktree.status !== "ready") {
    throw new Error("Only ready task worktrees can create PRs.");
  }
  const prepared = assertTaskWorktreeReady(worktree, options.worktreesRoot);
  await assertPathExists(prepared.path, "Task worktree no longer exists.");
  const draft = worktree.pullRequest;
  if (!draft) {
    throw new Error("Prepare a PR draft before creating a pull request.");
  }
  if (draft.url) {
    throw new Error("This task worktree already has a pull request URL.");
  }
  if (!draft.remoteName || !draft.baseBranch) {
    throw new Error("PR creation requires an origin remote and a base branch.");
  }
  const currentCommit = await gitHeadOrThrow(prepared.path, { full: true });
  if (currentCommit !== draft.commit) {
    throw new Error("The PR draft is stale. Prepare a new PR draft before creating a pull request.");
  }
  await assertCleanWorktree(prepared.path, "Task worktree has uncommitted changes. Prepare a new PR draft before creating a pull request.");

  const run = options.commandRunner ?? runTaskWorktreeCommand;
  await run("git", ["push", "-u", draft.remoteName, draft.branch], { cwd: prepared.path });
  const created = await run(
    "gh",
    ["pr", "create", "--draft", "--base", draft.baseBranch, "--head", draft.branch, "--title", draft.title, "--body", draft.body],
    { cwd: prepared.path }
  );
  const url = parsePullRequestUrl(`${created.stdout}\n${created.stderr ?? ""}`) ?? created.stdout.trim();
  if (!url) {
    throw new Error("GitHub CLI did not return a pull request URL.");
  }
  const now = options.now ?? new Date().toISOString();
  return {
    status: worktree.status,
    diff: worktree.diff,
    pullRequest: {
      ...draft,
      pushedAt: now,
      createdAt: now,
      url
    }
  };
}

export async function refreshTaskWorktreePullRequest(
  worktree: AgentTaskRunWorktree,
  options: TaskWorktreeActionOptions = {}
): Promise<TaskWorktreeActionResult> {
  const prepared = assertTaskWorktreeReady(worktree, options.worktreesRoot);
  await assertPathExists(prepared.path, "Task worktree no longer exists.");
  const pullRequest = worktree.pullRequest;
  if (!pullRequest?.url) {
    throw new Error("Create a pull request before refreshing PR status.");
  }

  const run = options.commandRunner ?? runTaskWorktreeCommand;
  const result = await run(
    "gh",
    ["pr", "view", pullRequest.url, "--json", "state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,comments,reviews,url"],
    { cwd: prepared.path }
  );
  const reviewThreads = await fetchPullRequestReviewThreads(pullRequest.url, prepared.path, run);
  const refreshedAt = options.now ?? new Date().toISOString();
  const review = enrichPullRequestReview(
    pullRequest.review,
    parsePullRequestReview(result.stdout, refreshedAt, reviewThreads?.threads, reviewThreads?.error),
    refreshedAt
  );
  return {
    status: worktree.status,
    diff: worktree.diff,
    pullRequest: {
      ...pullRequest,
      review
    }
  };
}

export async function syncTaskWorktreeWithOriginal(
  worktree: AgentTaskRunWorktree,
  options: TaskWorktreeActionOptions = {}
): Promise<TaskWorktreeActionResult> {
  const prepared = assertTaskWorktreeReady(worktree, options.worktreesRoot);
  await assertPathExists(prepared.path, "Task worktree no longer exists.");
  await assertNoMergeInProgress(prepared.path, "Resolve or abort the current task worktree conflict before syncing again.");
  const originalHead = await gitHeadOrThrow(prepared.originalRoot, { full: true });
  let taskHead = await gitHeadOrThrow(prepared.path, { full: true });
  if (await isAncestor(originalHead, taskHead, prepared.path)) {
    return {
      status: worktree.status,
      diff: await summarizeTaskWorktree(worktree, options)
    };
  }

  await commitTaskWorktreeChanges(prepared.path, options.taskRunId ?? prepared.branch);
  taskHead = await gitHeadOrThrow(prepared.path, { full: true });
  if (await isAncestor(originalHead, taskHead, prepared.path)) {
    return {
      status: worktree.status,
      diff: await summarizeTaskWorktree(worktree, options)
    };
  }

  const merge = await execa("git", ["-c", "user.name=Arivu", "-c", "user.email=arivu@local.invalid", "merge", "--no-edit", originalHead], {
    cwd: prepared.path,
    reject: false
  });
  if (merge.exitCode !== 0) {
    return {
      status: worktree.status,
      diff: await summarizeTaskWorktree(worktree, options),
      conflict: {
        type: "sync",
        message: merge.stderr || merge.stdout || "Task worktree needs conflict resolution before it can sync with the original checkout.",
        files: await taskWorktreeConflictFiles(prepared.path),
        originalHead,
        taskHead,
        detectedAt: options.now ?? new Date().toISOString()
      }
    };
  }

  return {
    status: worktree.status,
    diff: await summarizeTaskWorktree(worktree, options)
  };
}

export async function continueTaskWorktreeConflict(
  worktree: AgentTaskRunWorktree,
  options: TaskWorktreeActionOptions = {}
): Promise<TaskWorktreeActionResult> {
  const prepared = assertTaskWorktreeReady(worktree, options.worktreesRoot);
  await assertPathExists(prepared.path, "Task worktree no longer exists.");
  await assertMergeInProgress(prepared.path, "No task worktree conflict is currently in progress.");
  await execa("git", ["add", "-A"], { cwd: prepared.path });
  const conflicts = await taskWorktreeConflictFiles(prepared.path);
  if (conflicts.length > 0) {
    throw new Error(`Resolve conflict markers before continuing: ${conflicts.join(", ")}`);
  }
  const committed = await execa("git", ["-c", "user.name=Arivu", "-c", "user.email=arivu@local.invalid", "commit", "--no-edit"], {
    cwd: prepared.path,
    reject: false
  });
  if (committed.exitCode !== 0) {
    throw new Error(committed.stderr || committed.stdout || "Unable to complete task worktree conflict resolution.");
  }
  return {
    status: worktree.status,
    diff: await summarizeTaskWorktree(worktree, options)
  };
}

export async function abortTaskWorktreeConflict(
  worktree: AgentTaskRunWorktree,
  options: TaskWorktreeActionOptions = {}
): Promise<TaskWorktreeActionResult> {
  const prepared = assertTaskWorktreeReady(worktree, options.worktreesRoot);
  await assertPathExists(prepared.path, "Task worktree no longer exists.");
  const mergeHeadPath = await gitPath(prepared.path, "MERGE_HEAD");
  try {
    await access(mergeHeadPath);
  } catch {
    return {
      status: worktree.status,
      diff: await summarizeTaskWorktree(worktree, options)
    };
  }
  const aborted = await execa("git", ["merge", "--abort"], { cwd: prepared.path, reject: false });
  if (aborted.exitCode !== 0) {
    throw new Error(aborted.stderr || aborted.stdout || "Unable to abort task worktree conflict resolution.");
  }
  return {
    status: worktree.status,
    diff: await summarizeTaskWorktree(worktree, options)
  };
}

export async function discardTaskWorktree(
  worktree: AgentTaskRunWorktree,
  options: TaskWorktreeActionOptions = {}
): Promise<TaskWorktreeActionResult> {
  const prepared = assertTaskWorktreeReady(worktree, options.worktreesRoot);
  await removeTaskWorktree(prepared);
  return {
    status: "discarded",
    discardedAt: options.now ?? new Date().toISOString()
  };
}

export async function cleanupMergedTaskWorktree(
  worktree: AgentTaskRunWorktree,
  options: TaskWorktreeActionOptions = {}
): Promise<TaskWorktreeActionResult> {
  if (worktree.status !== "merged") {
    throw new Error("Only merged task worktrees can be cleaned up.");
  }
  const prepared = assertTaskWorktreeReady(worktree, options.worktreesRoot);
  await removeTaskWorktree(prepared);
  return {
    status: "cleaned",
    cleanedAt: options.now ?? new Date().toISOString()
  };
}

export async function resolveTaskWorktreePath(worktree: AgentTaskRunWorktree, options: TaskWorktreeActionOptions = {}): Promise<string> {
  const prepared = assertTaskWorktreeReady(worktree, options.worktreesRoot);
  await assertPathExists(prepared.path, "Task worktree no longer exists.");
  return prepared.path;
}

async function taskWorktreePatchText(prepared: { path: string; baseRef?: string }) {
  const diffBase = prepared.baseRef ?? "HEAD";
  const mainDiff = await execa("git", ["diff", "--patch", "--find-renames", diffBase, "--"], { cwd: prepared.path });
  const untracked = await execa("git", ["ls-files", "--others", "--exclude-standard"], { cwd: prepared.path });
  const untrackedDiffs: string[] = [];
  for (const filePath of untrackedPathsFromNameOnly(untracked.stdout)) {
    const result = await execa("git", ["diff", "--no-index", "--", "/dev/null", filePath], {
      cwd: prepared.path,
      reject: false
    });
    if (result.stdout.trim()) {
      untrackedDiffs.push(result.stdout);
    }
  }
  return [mainDiff.stdout, ...untrackedDiffs].filter((part) => part.trim()).join("\n");
}

function buildPatchPreview(text: string, maxBytes = DEFAULT_TASK_WORKTREE_PATCH_PREVIEW_BYTES, now = new Date().toISOString()) {
  const bytes = Buffer.byteLength(text, "utf8");
  const safeMaxBytes = Math.max(1, Math.floor(maxBytes));
  const truncated = bytes > safeMaxBytes;
  const previewText = truncated ? Buffer.from(text, "utf8").subarray(0, safeMaxBytes).toString("utf8") : text;
  return {
    text: previewText,
    bytes,
    lineCount: previewText ? previewText.split(/\r?\n/).length : 0,
    truncated,
    updatedAt: now
  };
}

async function gitRootOrThrow(cwd: string) {
  try {
    const inside = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    if (inside.stdout.trim() !== "true") {
      throw new Error("not a git workspace");
    }
    const root = await execa("git", ["rev-parse", "--show-toplevel"], { cwd });
    return root.stdout.trim();
  } catch {
    throw new Error("Task worktree mode requires a git-backed project.");
  }
}

async function gitHeadOrThrow(cwd: string, options: { full?: boolean } = {}) {
  try {
    const args = options.full ? ["rev-parse", "HEAD"] : ["rev-parse", "--short", "HEAD"];
    const result = await execa("git", args, { cwd });
    return result.stdout.trim();
  } catch {
    throw new Error("Task worktree mode requires a git repository with at least one commit.");
  }
}

async function currentBranch(cwd: string) {
  const result = await execa("git", ["branch", "--show-current"], { cwd, reject: false });
  const branch = result.stdout.trim();
  return branch || undefined;
}

async function getRemote(cwd: string, remoteName: string) {
  const result = await execa("git", ["remote", "get-url", remoteName], { cwd, reject: false });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

function assertTaskWorktreeReady(worktree: AgentTaskRunWorktree, worktreesRoot?: string) {
  if (!worktree.enabled || !worktree.originalRoot || !worktree.path || !worktree.branch) {
    throw new Error("Task worktree metadata is incomplete.");
  }
  if (!worktree.branch.startsWith("arivu/task-")) {
    throw new Error("Refusing to manage a non-Arivu task branch.");
  }
  const managedRoot = path.resolve(worktreesRoot ?? path.join(appDataDir(), "task-worktrees"));
  const worktreePath = path.resolve(worktree.path);
  if (!isPathInside(worktreePath, managedRoot)) {
    throw new Error("Refusing to manage a task worktree outside Arivu app data.");
  }
  return {
    originalRoot: path.resolve(worktree.originalRoot),
    path: worktreePath,
    branch: worktree.branch,
    baseRef: worktree.baseRef
  };
}

function assertVerificationAllowsLifecycle(verification: AgentTaskRunVerification | undefined, action: string) {
  if (verification?.status !== "failed") {
    return;
  }
  throw new Error(`Resolve failed verification before ${action}. ${verification.summary}`);
}

async function assertPathExists(filePath: string, message: string) {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

async function assertCleanOriginal(originalRoot: string) {
  await assertCleanWorktree(
    originalRoot,
    "Original checkout has uncommitted changes. Commit, stash, or clean them before merging a task worktree."
  );
}

async function assertCleanWorktree(cwd: string, message: string) {
  const status = await execa("git", ["status", "--porcelain=v1"], { cwd });
  if (status.stdout.trim()) {
    throw new Error(message);
  }
}

async function assertNoMergeInProgress(cwd: string, message: string) {
  const mergeHeadPath = await gitPath(cwd, "MERGE_HEAD");
  try {
    await access(mergeHeadPath);
  } catch {
    return;
  }
  throw new Error(message);
}

async function assertMergeInProgress(cwd: string, message: string) {
  const mergeHeadPath = await gitPath(cwd, "MERGE_HEAD");
  try {
    await access(mergeHeadPath);
  } catch {
    throw new Error(message);
  }
}

async function isAncestor(ancestor: string, descendant: string, cwd: string) {
  const result = await execa("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, reject: false });
  return result.exitCode === 0;
}

async function gitPath(cwd: string, name: string) {
  const result = await execa("git", ["rev-parse", "--git-path", name], { cwd });
  return path.resolve(cwd, result.stdout.trim());
}

async function taskWorktreeConflictFiles(cwd: string) {
  const status = await execa("git", ["status", "--porcelain=v1"], { cwd });
  return conflictPathsFromPorcelain(status.stdout);
}

async function commitTaskWorktreeChanges(worktreePath: string, taskRunId: string) {
  const status = await execa("git", ["status", "--porcelain=v1"], { cwd: worktreePath });
  if (!status.stdout.trim()) {
    return;
  }
  await execa("git", ["add", "-A"], { cwd: worktreePath });
  const diff = await execa("git", ["diff", "--cached", "--quiet"], { cwd: worktreePath, reject: false });
  if (diff.exitCode !== 1) {
    return;
  }
  await execa("git", ["-c", "user.name=Arivu", "-c", "user.email=arivu@local.invalid", "commit", "-m", `Arivu task ${taskRunId}`], {
    cwd: worktreePath
  });
}

async function removeTaskWorktree(prepared: { originalRoot: string; path: string; branch: string }) {
  const remove = await execa("git", ["worktree", "remove", "--force", prepared.path], {
    cwd: prepared.originalRoot,
    reject: false
  });
  if (remove.exitCode !== 0) {
    await execa("git", ["worktree", "prune"], { cwd: prepared.originalRoot, reject: false });
    await assertPathGone(prepared.path, remove.stderr || remove.stdout || "Unable to remove task worktree.");
  }
  const deleted = await execa("git", ["branch", "-D", prepared.branch], {
    cwd: prepared.originalRoot,
    reject: false
  });
  if (deleted.exitCode !== 0 && !/not found|branch .* not found/i.test(`${deleted.stderr}\n${deleted.stdout}`)) {
    throw new Error(deleted.stderr || deleted.stdout || "Unable to delete task branch.");
  }
}

async function assertPathGone(filePath: string, message: string) {
  try {
    await access(filePath);
  } catch {
    return;
  }
  throw new Error(message);
}

function changedPathsFromPorcelain(output: string) {
  const paths = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const rawPath = line.slice(3).trim();
    if (!rawPath) {
      continue;
    }
    paths.add(rawPath.includes(" -> ") ? (rawPath.split(" -> ").at(-1) ?? rawPath) : rawPath);
  }
  return Array.from(paths).sort((left, right) => left.localeCompare(right));
}

function conflictPathsFromPorcelain(output: string) {
  const paths = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const status = line.slice(0, 2);
    if (!isUnmergedPorcelainStatus(status)) {
      continue;
    }
    const rawPath = line.slice(3).trim();
    if (!rawPath) {
      continue;
    }
    paths.add(rawPath.includes(" -> ") ? (rawPath.split(" -> ").at(-1) ?? rawPath) : rawPath);
  }
  return Array.from(paths).sort((left, right) => left.localeCompare(right));
}

function isUnmergedPorcelainStatus(status: string) {
  return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status);
}

function untrackedPathsFromNameOnly(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function changedPathsFromNameOnly(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function mergeChangedPaths(...groups: string[][]) {
  return Array.from(new Set(groups.flat())).sort((left, right) => left.localeCompare(right));
}

function parseShortstat(output: string) {
  const insertions = output.match(/(\d+)\s+insertion/)?.[1];
  const deletions = output.match(/(\d+)\s+deletion/)?.[1];
  return {
    insertions: insertions ? Number(insertions) : undefined,
    deletions: deletions ? Number(deletions) : undefined
  };
}

function pullRequestTitle(promptPreview: string | undefined, branch: string) {
  const normalized = promptPreview?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return `Arivu task ${branch.replace(/^arivu\/task-/, "")}`;
  }
  const title = normalized.length > 72 ? `${normalized.slice(0, 69).trimEnd()}...` : normalized;
  return `Arivu: ${title}`;
}

function pullRequestBody({
  promptPreview,
  branch,
  baseBranch,
  baseRef,
  commit,
  diff
}: {
  promptPreview?: string;
  branch: string;
  baseBranch?: string;
  baseRef?: string;
  commit: string;
  diff: AgentTaskRunWorktreeDiff;
}) {
  const changedPaths = diff.changedPaths.slice(0, 25);
  const omitted = diff.changedPaths.length - changedPaths.length;
  return [
    "## Summary",
    promptPreview?.trim() ? `- ${promptPreview.trim()}` : "- Arivu task worktree changes.",
    "",
    "## Task worktree",
    `- Branch: \`${branch}\``,
    baseBranch ? `- Base branch: \`${baseBranch}\`` : undefined,
    baseRef ? `- Base commit: \`${baseRef}\`` : undefined,
    `- Task commit: \`${commit}\``,
    "",
    "## Changed files",
    ...changedPaths.map((filePath) => `- \`${filePath}\``),
    omitted > 0 ? `- ...and ${omitted} more` : undefined,
    "",
    "Generated by Arivu task worktree PR prep. Review the patch preview before creating the PR."
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runTaskWorktreeCommand(file: string, args: string[], options: { cwd: string; reject?: boolean }) {
  return execa(file, args, options);
}

function parsePullRequestUrl(output: string) {
  return output.match(/https:\/\/[^\s]+\/pull\/\d+/)?.[0];
}

async function fetchPullRequestReviewThreads(
  pullRequestUrl: string,
  cwd: string,
  run: TaskWorktreeCommandRunner
): Promise<{ threads?: unknown; error?: string } | undefined> {
  const details = parsePullRequestUrlDetails(pullRequestUrl);
  if (!details) {
    return { error: "Unable to parse the pull request URL for review thread lookup." };
  }

  const args = [
    "api",
    ...(details.host && details.host !== "github.com" ? ["--hostname", details.host] : []),
    "graphql",
    "-f",
    `query=${PULL_REQUEST_REVIEW_THREADS_QUERY}`,
    "-F",
    `owner=${details.owner}`,
    "-F",
    `repo=${details.repo}`,
    "-F",
    `number=${details.number}`
  ];

  try {
    const result = await run("gh", args, { cwd });
    return { threads: result.stdout };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

function parsePullRequestUrlDetails(value: string) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const pullIndex = parts.indexOf("pull");
    if (pullIndex < 2 || pullIndex + 1 >= parts.length) {
      return undefined;
    }
    const number = Number.parseInt(parts[pullIndex + 1] ?? "", 10);
    if (!Number.isInteger(number) || number <= 0) {
      return undefined;
    }
    return {
      host: url.hostname,
      owner: parts[pullIndex - 2],
      repo: parts[pullIndex - 1],
      number
    };
  } catch {
    return undefined;
  }
}

function parsePullRequestReview(
  output: string,
  now: string,
  reviewThreadsValue?: unknown,
  threadFetchError?: string
): AgentTaskRunWorktreePullRequestReview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("GitHub CLI returned invalid PR status JSON.");
  }
  if (!isRecord(parsed)) {
    throw new Error("GitHub CLI returned invalid PR status JSON.");
  }

  const state = optionalString(parsed.state);
  const reviewDecision = optionalString(parsed.reviewDecision);
  const mergeStateStatus = optionalString(parsed.mergeStateStatus);
  const isDraft = typeof parsed.isDraft === "boolean" ? parsed.isDraft : undefined;
  const checks = summarizePullRequestChecks(parsed.statusCheckRollup);
  const checkItems = summarizePullRequestCheckItems(parsed.statusCheckRollup);
  const checkSummary = formatPullRequestCheckSummary(checks);
  const feedback = summarizePullRequestFeedback(parsed.comments, parsed.reviews, reviewThreadsValue, threadFetchError);
  const summary = [
    isDraft ? "Draft" : formatPullRequestState(state),
    reviewDecision ? `review ${formatPrToken(reviewDecision)}` : undefined,
    mergeStateStatus ? `merge ${formatPrToken(mergeStateStatus)}` : undefined,
    checkSummary,
    feedback.summary
  ]
    .filter((part): part is string => Boolean(part))
    .join(" - ");

  return {
    state,
    isDraft,
    reviewDecision,
    mergeStateStatus,
    checkSummary,
    checks,
    checkItems,
    summary,
    feedback,
    updatedAt: now
  };
}

function enrichPullRequestReview(
  previous: AgentTaskRunWorktreePullRequestReview | undefined,
  current: AgentTaskRunWorktreePullRequestReview,
  now: string
): AgentTaskRunWorktreePullRequestReview {
  const checkItems = preservePullRequestCheckLogArtifacts(previous?.checkItems, current.checkItems);
  const notifications = pullRequestReviewNotifications(previous, { ...current, checkItems }, now);
  return {
    ...current,
    checkItems,
    notifications: notifications.length > 0 ? notifications : undefined
  };
}

function preservePullRequestCheckLogArtifacts(
  previousItems: AgentTaskRunWorktreePullRequestCheckItem[] | undefined,
  currentItems: AgentTaskRunWorktreePullRequestCheckItem[] | undefined
) {
  if (!currentItems?.length || !previousItems?.length) {
    return currentItems;
  }
  const previousByLogCommand = new Map(previousItems.filter((item) => item.logCommand).map((item) => [item.logCommand, item] as const));
  return currentItems.map((item) => {
    const previous = item.logCommand ? previousByLogCommand.get(item.logCommand) : undefined;
    if (!previous?.logArtifactId && !previous?.logFetchedAt && !previous?.logError) {
      return item;
    }
    return {
      ...item,
      logArtifactId: item.logArtifactId ?? previous.logArtifactId,
      logFetchedAt: item.logFetchedAt ?? previous.logFetchedAt,
      logError: item.logError ?? previous.logError
    };
  });
}

function pullRequestReviewNotifications(
  previous: AgentTaskRunWorktreePullRequestReview | undefined,
  current: AgentTaskRunWorktreePullRequestReview,
  now: string
): AgentTaskRunWorktreePullRequestReviewNotification[] {
  if (!previous) {
    return [];
  }

  const notifications: AgentTaskRunWorktreePullRequestReviewNotification[] = [];
  addPullRequestReviewChangeNotification(notifications, now, {
    previous: previous.state,
    current: current.state,
    summary: "PR state changed",
    level: "info"
  });
  if (previous.isDraft !== current.isDraft && previous.isDraft !== undefined && current.isDraft !== undefined) {
    notifications.push({
      level: current.isDraft ? "warning" : "success",
      summary: current.isDraft ? "PR moved back to draft" : "PR is ready for review",
      detail: `was ${previous.isDraft ? "draft" : "ready for review"}`,
      createdAt: now
    });
  }
  addPullRequestReviewChangeNotification(notifications, now, {
    previous: previous.reviewDecision,
    current: current.reviewDecision,
    summary: "Review decision changed",
    level: reviewDecisionNotificationLevel(current.reviewDecision)
  });
  addPullRequestReviewChangeNotification(notifications, now, {
    previous: previous.mergeStateStatus,
    current: current.mergeStateStatus,
    summary: "Merge state changed",
    level: mergeStateNotificationLevel(current.mergeStateStatus)
  });
  notifications.push(...pullRequestCheckNotifications(previous.checkItems, current.checkItems, now));
  if (previous.checkSummary !== current.checkSummary) {
    notifications.push({
      level: checkSummaryNotificationLevel(previous.checks, current.checks),
      summary: "Check summary changed",
      detail: `${previous.checkSummary} -> ${current.checkSummary}`,
      createdAt: now
    });
  }
  if (previous.feedback?.summary !== current.feedback?.summary && (previous.feedback || current.feedback)) {
    notifications.push({
      level: feedbackNotificationLevel(previous.feedback, current.feedback),
      summary: "Review feedback changed",
      detail: `${previous.feedback?.summary ?? "No review feedback"} -> ${current.feedback?.summary ?? "No review feedback"}`,
      createdAt: now
    });
  }

  return notifications.slice(0, MAX_PULL_REQUEST_REVIEW_NOTIFICATIONS);
}

function addPullRequestReviewChangeNotification(
  notifications: AgentTaskRunWorktreePullRequestReviewNotification[],
  now: string,
  options: {
    previous: string | undefined;
    current: string | undefined;
    summary: string;
    level: AgentTaskRunWorktreePullRequestReviewNotification["level"];
  }
) {
  if (normalizedOptionalToken(options.previous) === normalizedOptionalToken(options.current)) {
    return;
  }
  notifications.push({
    level: options.level,
    summary: options.summary,
    detail: `${formatNotificationToken(options.previous)} -> ${formatNotificationToken(options.current)}`,
    createdAt: now
  });
}

function pullRequestCheckNotifications(
  previousItems: AgentTaskRunWorktreePullRequestCheckItem[] | undefined,
  currentItems: AgentTaskRunWorktreePullRequestCheckItem[] | undefined,
  now: string
): AgentTaskRunWorktreePullRequestReviewNotification[] {
  const notifications: AgentTaskRunWorktreePullRequestReviewNotification[] = [];
  const previousByName = new Map((previousItems ?? []).map((item) => [item.name, item] as const));
  const currentByName = new Map((currentItems ?? []).map((item) => [item.name, item] as const));

  for (const item of currentItems ?? []) {
    const previous = previousByName.get(item.name);
    if (!previous) {
      if (item.bucket !== "passed" && item.bucket !== "skipped") {
        notifications.push({
          level: checkBucketNotificationLevel(undefined, item.bucket),
          summary: `New ${item.bucket} check: ${item.name}`,
          createdAt: now
        });
      }
      continue;
    }
    if (previous.bucket !== item.bucket) {
      notifications.push({
        level: checkBucketNotificationLevel(previous.bucket, item.bucket),
        summary: `Check ${item.name} changed`,
        detail: `${previous.bucket} -> ${item.bucket}`,
        createdAt: now
      });
    }
  }

  for (const item of previousItems ?? []) {
    if (currentByName.has(item.name) || (item.bucket !== "failed" && item.bucket !== "cancelled" && item.bucket !== "pending")) {
      continue;
    }
    notifications.push({
      level: item.bucket === "pending" ? "info" : "success",
      summary: `Check no longer reported: ${item.name}`,
      detail: `was ${item.bucket}`,
      createdAt: now
    });
  }

  return notifications;
}

function normalizedOptionalToken(value: string | undefined) {
  return value ? value.trim().toUpperCase() : "";
}

function formatNotificationToken(value: string | undefined) {
  return value ? formatPrToken(value) : "none";
}

function reviewDecisionNotificationLevel(value: string | undefined): AgentTaskRunWorktreePullRequestReviewNotification["level"] {
  const normalized = normalizedOptionalToken(value);
  if (normalized === "APPROVED") {
    return "success";
  }
  if (normalized === "CHANGES_REQUESTED" || normalized === "REVIEW_REQUIRED") {
    return "warning";
  }
  return "info";
}

function mergeStateNotificationLevel(value: string | undefined): AgentTaskRunWorktreePullRequestReviewNotification["level"] {
  const normalized = normalizedOptionalToken(value);
  if (normalized === "CLEAN" || normalized === "HAS_HOOKS") {
    return "success";
  }
  if (normalized === "BLOCKED" || normalized === "DIRTY" || normalized === "BEHIND" || normalized === "UNSTABLE") {
    return "warning";
  }
  return "info";
}

function checkSummaryNotificationLevel(
  previous: AgentTaskRunWorktreePullRequestReview["checks"],
  current: AgentTaskRunWorktreePullRequestReview["checks"]
): AgentTaskRunWorktreePullRequestReviewNotification["level"] {
  if (current.failed > previous.failed || current.cancelled > previous.cancelled || current.unknown > previous.unknown) {
    return "warning";
  }
  if (current.failed < previous.failed || current.cancelled < previous.cancelled || current.passed > previous.passed) {
    return "success";
  }
  return "info";
}

function checkBucketNotificationLevel(
  previous: AgentTaskRunWorktreePullRequestCheckItem["bucket"] | undefined,
  current: AgentTaskRunWorktreePullRequestCheckItem["bucket"]
): AgentTaskRunWorktreePullRequestReviewNotification["level"] {
  if (current === "failed" || current === "cancelled" || current === "unknown") {
    return "warning";
  }
  if (current === "passed" && previous && previous !== "passed") {
    return "success";
  }
  return "info";
}

function feedbackNotificationLevel(
  previous: AgentTaskRunWorktreePullRequestFeedback | undefined,
  current: AgentTaskRunWorktreePullRequestFeedback | undefined
): AgentTaskRunWorktreePullRequestReviewNotification["level"] {
  if (
    (current?.changesRequested ?? 0) > (previous?.changesRequested ?? 0) ||
    (current?.unresolvedThreads ?? 0) > (previous?.unresolvedThreads ?? 0)
  ) {
    return "warning";
  }
  if ((current?.approved ?? 0) > (previous?.approved ?? 0) || (current?.unresolvedThreads ?? 0) < (previous?.unresolvedThreads ?? 0)) {
    return "success";
  }
  return "info";
}

function summarizePullRequestFeedback(
  commentsValue: unknown,
  reviewsValue: unknown,
  reviewThreadsValue?: unknown,
  threadFetchError?: string
): AgentTaskRunWorktreePullRequestFeedback {
  const comments = pullRequestFeedbackItems(commentsValue, "comment");
  const reviews = pullRequestFeedbackItems(reviewsValue, "review");
  const threads = pullRequestReviewThreadItems(reviewThreadsValue);
  const reviewStates = reviews.map((item) => optionalString(item.state)?.toUpperCase()).filter((state): state is string => Boolean(state));
  const unresolvedThreads = threads.filter((thread) => thread.state === "UNRESOLVED").length;
  const resolvedThreads = threads.filter((thread) => thread.state === "RESOLVED").length;
  const allItems = [...comments, ...reviews, ...threads].sort(comparePullRequestFeedbackItems);

  const feedback = {
    total: comments.length + reviews.length + threads.length,
    comments: comments.length,
    reviews: reviews.length,
    threads: threads.length,
    unresolvedThreads,
    resolvedThreads,
    changesRequested: reviewStates.filter((state) => state === "CHANGES_REQUESTED").length,
    approved: reviewStates.filter((state) => state === "APPROVED").length,
    commented: reviewStates.filter((state) => state === "COMMENTED").length,
    summary: "",
    threadFetchError,
    items: allItems.slice(0, MAX_PULL_REQUEST_FEEDBACK_ITEMS)
  };
  feedback.summary = formatPullRequestFeedbackSummary(feedback);
  return feedback;
}

function pullRequestFeedbackItems(value: unknown, kind: AgentTaskRunWorktreePullRequestFeedbackItem["kind"]) {
  const items = pullRequestCheckItems(value);
  return items.map((item): AgentTaskRunWorktreePullRequestFeedbackItem => {
    const body = boundedFeedbackBody(optionalString(item.body) ?? optionalString(item.bodyText));
    const author = authorName(item.author);
    const createdAt = optionalString(item.createdAt) ?? optionalString(item.submittedAt);
    const updatedAt = optionalString(item.updatedAt) ?? optionalString(item.submittedAt);
    const line = typeof item.line === "number" && Number.isInteger(item.line) && item.line >= 0 ? item.line : undefined;
    return {
      kind,
      author,
      state: optionalString(item.state),
      body,
      path: optionalString(item.path),
      line,
      url: optionalString(item.url),
      createdAt,
      updatedAt
    };
  });
}

function pullRequestReviewThreadItems(value: unknown): AgentTaskRunWorktreePullRequestFeedbackItem[] {
  const threads = pullRequestReviewThreadNodes(value);
  return threads.map((thread): AgentTaskRunWorktreePullRequestFeedbackItem => {
    const comments = pullRequestReviewThreadComments(thread);
    const latest = comments.at(-1);
    const first = comments[0];
    const line =
      numberField(thread.line) ?? numberField(latest?.line) ?? numberField(thread.originalLine) ?? numberField(latest?.originalLine);
    return {
      kind: "thread",
      author: authorName(latest?.author ?? first?.author),
      state: thread.isResolved === true ? "RESOLVED" : "UNRESOLVED",
      body: boundedFeedbackBody(optionalString(latest?.body) ?? optionalString(first?.body)),
      path: optionalString(thread.path) ?? optionalString(latest?.path) ?? optionalString(first?.path),
      line,
      url: optionalString(latest?.url) ?? optionalString(first?.url),
      createdAt: optionalString(first?.createdAt) ?? optionalString(latest?.createdAt),
      updatedAt: optionalString(latest?.updatedAt) ?? optionalString(first?.updatedAt)
    };
  });
}

function pullRequestReviewThreadNodes(value: unknown): Record<string, unknown>[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const pullRequest =
    isRecord(parsed.data) && isRecord(parsed.data.repository) && isRecord(parsed.data.repository.pullRequest)
      ? parsed.data.repository.pullRequest
      : parsed;
  if (isRecord(pullRequest.reviewThreads)) {
    return pullRequest.reviewThreads.nodes instanceof Array ? pullRequest.reviewThreads.nodes.filter(isRecord) : [];
  }
  return [];
}

function pullRequestReviewThreadComments(thread: Record<string, unknown>) {
  if (isRecord(thread.comments) && Array.isArray(thread.comments.nodes)) {
    return thread.comments.nodes.filter(isRecord);
  }
  return [];
}

function comparePullRequestFeedbackItems(
  left: AgentTaskRunWorktreePullRequestFeedbackItem,
  right: AgentTaskRunWorktreePullRequestFeedbackItem
) {
  const leftTime = Date.parse(left.updatedAt ?? left.createdAt ?? "");
  const rightTime = Date.parse(right.updatedAt ?? right.createdAt ?? "");
  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
    return 0;
  }
  if (Number.isNaN(leftTime)) {
    return 1;
  }
  if (Number.isNaN(rightTime)) {
    return -1;
  }
  return rightTime - leftTime;
}

function formatPullRequestFeedbackSummary(feedback: Omit<AgentTaskRunWorktreePullRequestFeedback, "summary">) {
  if (feedback.total === 0) {
    return "No review comments reported";
  }
  const parts = [
    feedback.reviews ? `${feedback.reviews} review${feedback.reviews === 1 ? "" : "s"}` : undefined,
    feedback.comments ? `${feedback.comments} comment${feedback.comments === 1 ? "" : "s"}` : undefined,
    feedback.threads ? `${feedback.threads} line thread${feedback.threads === 1 ? "" : "s"}` : undefined,
    feedback.unresolvedThreads
      ? `${feedback.unresolvedThreads} unresolved thread${feedback.unresolvedThreads === 1 ? "" : "s"}`
      : undefined,
    feedback.changesRequested ? `${feedback.changesRequested} changes requested` : undefined,
    feedback.approved ? `${feedback.approved} approved` : undefined,
    feedback.commented ? `${feedback.commented} commented` : undefined
  ].filter((part): part is string => Boolean(part));
  return `Review feedback: ${parts.join(", ")}`;
}

function boundedFeedbackBody(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_PULL_REQUEST_FEEDBACK_BODY_CHARS
    ? `${normalized.slice(0, MAX_PULL_REQUEST_FEEDBACK_BODY_CHARS - 3).trimEnd()}...`
    : normalized;
}

function boundedCheckText(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117).trimEnd()}...` : normalized;
}

function authorName(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return optionalString(value.login) ?? optionalString(value.name);
}

function summarizePullRequestChecks(value: unknown): AgentTaskRunWorktreePullRequestReview["checks"] {
  const checks = {
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    cancelled: 0,
    unknown: 0
  };
  const items = pullRequestCheckItems(value);
  for (const item of items) {
    checks.total += 1;
    const bucket = pullRequestCheckBucket(item);
    checks[bucket] += 1;
  }
  return checks;
}

function summarizePullRequestCheckItems(value: unknown): AgentTaskRunWorktreePullRequestCheckItem[] | undefined {
  const items = pullRequestCheckItems(value)
    .map(pullRequestCheckEvidenceItem)
    .filter((item): item is AgentTaskRunWorktreePullRequestCheckItem => Boolean(item))
    .sort(comparePullRequestCheckItems)
    .slice(0, MAX_PULL_REQUEST_CHECK_ITEMS);
  return items.length > 0 ? items : undefined;
}

function pullRequestCheckEvidenceItem(item: Record<string, unknown>): AgentTaskRunWorktreePullRequestCheckItem | undefined {
  const name = optionalString(item.name) ?? optionalString(item.context) ?? optionalString(item.__typename);
  if (!name) {
    return undefined;
  }
  const bucket = pullRequestCheckBucket(item);
  const detailsUrl = optionalString(item.detailsUrl) ?? optionalString(item.targetUrl) ?? optionalString(item.url);
  const logEvidence = pullRequestCheckLogEvidence(detailsUrl, bucket);
  return {
    name: boundedCheckText(name),
    bucket,
    status: optionalString(item.status),
    conclusion: optionalString(item.conclusion),
    state: optionalString(item.state),
    detailsUrl,
    logSource: logEvidence?.logSource,
    logCommand: logEvidence?.logCommand,
    startedAt: optionalString(item.startedAt),
    completedAt: optionalString(item.completedAt)
  };
}

function pullRequestCheckLogEvidence(
  detailsUrl: string | undefined,
  bucket: AgentTaskRunWorktreePullRequestCheckItem["bucket"]
): Pick<AgentTaskRunWorktreePullRequestCheckItem, "logCommand" | "logSource"> | undefined {
  const actions = parseGithubActionsCheckUrl(detailsUrl);
  if (actions) {
    const args = [
      "gh",
      "run",
      "view",
      shellQuote(actions.runId),
      "--repo",
      shellQuote(actions.repo),
      actions.jobId ? "--job" : undefined,
      actions.jobId ? shellQuote(actions.jobId) : undefined,
      bucket === "failed" || bucket === "cancelled" ? "--log-failed" : "--log"
    ].filter((part): part is string => Boolean(part));
    return {
      logSource: "github_actions",
      logCommand: args.join(" ")
    };
  }
  if (!detailsUrl || !["failed", "cancelled", "unknown"].includes(bucket) || !isHttpUrl(detailsUrl)) {
    return undefined;
  }
  return {
    logSource: "details_url",
    logCommand: ["curl", "-L", "--max-time", "30", "--silent", "--show-error", shellQuote(detailsUrl)].join(" ")
  };
}

function parseGithubActionsCheckUrl(detailsUrl: string | undefined) {
  if (!detailsUrl) {
    return undefined;
  }
  try {
    const url = new URL(detailsUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const actionsIndex = parts.indexOf("actions");
    const runsIndex = parts.indexOf("runs");
    if (actionsIndex < 2 || runsIndex !== actionsIndex + 1 || runsIndex + 1 >= parts.length) {
      return undefined;
    }
    const owner = parts[actionsIndex - 2];
    const repo = parts[actionsIndex - 1];
    const runId = parts[runsIndex + 1];
    if (!owner || !repo || !/^\d+$/.test(runId)) {
      return undefined;
    }
    const jobIndex = parts.indexOf("job", runsIndex + 2);
    const jobId = jobIndex >= 0 ? parts[jobIndex + 1] : undefined;
    if (jobId !== undefined && !/^\d+$/.test(jobId)) {
      return undefined;
    }
    const repoPrefix = url.hostname && url.hostname !== "github.com" ? `${url.hostname}/` : "";
    return {
      repo: `${repoPrefix}${owner}/${repo}`,
      runId,
      jobId
    };
  } catch {
    return undefined;
  }
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function comparePullRequestCheckItems(left: AgentTaskRunWorktreePullRequestCheckItem, right: AgentTaskRunWorktreePullRequestCheckItem) {
  const rankDelta = pullRequestCheckBucketRank(left.bucket) - pullRequestCheckBucketRank(right.bucket);
  if (rankDelta !== 0) {
    return rankDelta;
  }
  return left.name.localeCompare(right.name);
}

function pullRequestCheckBucketRank(bucket: AgentTaskRunWorktreePullRequestCheckItem["bucket"]) {
  switch (bucket) {
    case "failed":
      return 0;
    case "cancelled":
      return 1;
    case "pending":
      return 2;
    case "unknown":
      return 3;
    case "skipped":
      return 4;
    case "passed":
      return 5;
  }
}

function pullRequestCheckItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (isRecord(value) && Array.isArray(value.nodes)) {
    return value.nodes.filter(isRecord);
  }
  return [];
}

function pullRequestCheckBucket(item: Record<string, unknown>): keyof Omit<AgentTaskRunWorktreePullRequestReview["checks"], "total"> {
  const conclusion = optionalString(item.conclusion)?.toUpperCase();
  const status = optionalString(item.status)?.toUpperCase();
  const state = optionalString(item.state)?.toUpperCase();
  if (conclusion) {
    if (["SUCCESS", "NEUTRAL"].includes(conclusion)) {
      return "passed";
    }
    if (["SKIPPED"].includes(conclusion)) {
      return "skipped";
    }
    if (["CANCELLED"].includes(conclusion)) {
      return "cancelled";
    }
    if (["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) {
      return "failed";
    }
  }
  if (state) {
    if (["SUCCESS"].includes(state)) {
      return "passed";
    }
    if (["FAILURE", "ERROR"].includes(state)) {
      return "failed";
    }
    if (["PENDING", "EXPECTED"].includes(state)) {
      return "pending";
    }
  }
  if (status && ["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"].includes(status)) {
    return "pending";
  }
  return "unknown";
}

function formatPullRequestCheckSummary(checks: AgentTaskRunWorktreePullRequestReview["checks"]) {
  if (checks.total === 0) {
    return "No checks reported";
  }
  const parts = [
    checks.passed ? `${checks.passed} passed` : undefined,
    checks.failed ? `${checks.failed} failed` : undefined,
    checks.pending ? `${checks.pending} pending` : undefined,
    checks.skipped ? `${checks.skipped} skipped` : undefined,
    checks.cancelled ? `${checks.cancelled} cancelled` : undefined,
    checks.unknown ? `${checks.unknown} unknown` : undefined
  ].filter((part): part is string => Boolean(part));
  return `${checks.total} check${checks.total === 1 ? "" : "s"}: ${parts.join(", ") || "unknown"}`;
}

function formatPullRequestState(state: string | undefined) {
  return state ? formatPrToken(state) : "PR status unknown";
}

function formatPrToken(value: string) {
  return value
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .join(" ");
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "GitHub CLI review-thread lookup failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isPathInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function safeWorktreeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || randomUUID();
}

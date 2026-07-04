import { chmod, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { appDataDir } from "../config.js";
import type { AgentSession } from "../agent/types.js";

const TextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string()
});

const ImagePartSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(["auto", "low", "high"]).optional()
  }),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional()
});

const ContentSchema = z.union([z.string(), z.array(z.union([TextPartSchema, ImagePartSchema]))]);

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: ContentSchema,
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.unknown()
      })
    )
    .optional()
});

const AgentLoopSchema = z.object({
  status: z.enum(["running", "stopping", "completed", "stopped", "blocked", "failed", "max_iterations"]),
  goal: z.string(),
  iteration: z.number().int().min(0),
  maxIterations: z.number().int().min(1).max(10),
  startedAt: z.string(),
  updatedAt: z.string(),
  stopRequested: z.boolean().optional(),
  lastDecision: z.enum(["continue", "done", "blocked"]).optional()
});

const AgentTaskRunToolSchema = z.object({
  id: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  arguments: z.unknown().optional(),
  capability: z.enum([
    "read_repo",
    "write_workspace",
    "run_command",
    "network_fetch",
    "browser_control",
    "mcp_call",
    "skill_context",
    "local_context",
    "unknown"
  ]),
  status: z.enum(["running", "done", "failed"]),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  durationMs: z.number().int().min(0).optional(),
  resultPreview: z.string().optional(),
  artifactIds: z.array(z.string()).optional()
});

const AgentTaskRunApprovalScopeSchema = z.object({
  kind: z.enum(["path", "query", "command", "network", "browser", "mcp", "unknown"]),
  label: z.string(),
  value: z.string().optional(),
  detail: z.string().optional()
});

const AgentTaskRunApprovalChangePreviewSchema = z.object({
  kind: z.enum(["patch", "file_change"]),
  title: z.string(),
  summary: z.string().optional(),
  path: z.string().optional(),
  writeMode: z.enum(["create", "replace"]).optional(),
  diff: z.string().optional(),
  diffTruncated: z.boolean().optional(),
  content: z.string().optional(),
  contentTruncated: z.boolean().optional(),
  original: z.string().optional(),
  originalTruncated: z.boolean().optional(),
  changedPaths: z.array(z.string()).optional(),
  additions: z.number().int().min(0).optional(),
  deletions: z.number().int().min(0).optional(),
  lineCount: z.number().int().min(0).optional(),
  bytes: z.number().int().min(0).optional()
});

const AgentTaskRunApprovalSchema = z.object({
  id: z.string(),
  actionType: z.enum(["read", "write", "shell", "mcp", "network", "browser"]),
  capability: AgentTaskRunToolSchema.shape.capability,
  status: z.enum(["allowed", "requested", "approved", "denied", "blocked"]),
  trustMode: z.enum(["ask", "readonly", "trusted"]),
  effect: z.enum(["allow", "prompt", "deny"]),
  label: z.string(),
  reason: z.string(),
  risky: z.boolean(),
  override: z.enum(["prompt", "deny"]).optional(),
  scope: AgentTaskRunApprovalScopeSchema.optional(),
  changePreview: AgentTaskRunApprovalChangePreviewSchema.optional(),
  summary: z.string(),
  message: z.string().optional(),
  createdAt: z.string(),
  requestedAt: z.string().optional(),
  decidedAt: z.string().optional(),
  updatedAt: z.string().optional()
});

const AgentTaskRunTestReportSchema = z.object({
  kind: z.enum(["junit", "sarif"]),
  path: z.string(),
  summary: z.string(),
  status: z.enum(["passed", "failed", "unknown"]),
  tests: z.number().int().min(0).optional(),
  failures: z.number().int().min(0).optional(),
  errors: z.number().int().min(0).optional(),
  skipped: z.number().int().min(0).optional(),
  suites: z.number().int().min(0).optional(),
  durationSeconds: z.number().min(0).optional(),
  findings: z.number().int().min(0).optional(),
  errorFindings: z.number().int().min(0).optional(),
  warningFindings: z.number().int().min(0).optional(),
  noteFindings: z.number().int().min(0).optional(),
  rules: z.number().int().min(0).optional(),
  failedTests: z
    .array(
      z.object({
        name: z.string(),
        classname: z.string().optional(),
        file: z.string().optional(),
        line: z.number().int().min(1).optional(),
        message: z.string().optional(),
        type: z.enum(["failure", "error"]).optional()
      })
    )
    .optional(),
  findingDetails: z
    .array(
      z.object({
        ruleId: z.string().optional(),
        level: z.enum(["error", "warning", "note", "none"]).optional(),
        message: z.string().optional(),
        path: z.string().optional(),
        line: z.number().int().min(1).optional(),
        column: z.number().int().min(1).optional()
      })
    )
    .optional()
});

const AgentTaskRunArtifactSchema = z.object({
  id: z.string(),
  kind: z.enum(["browser_screenshot", "command_output", "file_change", "patch", "tool_result"]),
  title: z.string(),
  summary: z.string().optional(),
  path: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  writeMode: z.enum(["create", "replace"]).optional(),
  content: z.string().optional(),
  contentTruncated: z.boolean().optional(),
  lineCount: z.number().int().min(0).optional(),
  diff: z.string().optional(),
  diffTruncated: z.boolean().optional(),
  changedPaths: z.array(z.string()).optional(),
  additions: z.number().int().min(0).optional(),
  deletions: z.number().int().min(0).optional(),
  command: z.string().optional(),
  executionProfile: z.enum(["host", "container", "sandbox"]).optional(),
  executionIsolation: z.string().optional(),
  workingDirectory: z.string().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().min(0).optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  stdoutTruncated: z.boolean().optional(),
  stderrTruncated: z.boolean().optional(),
  reportPaths: z.array(z.string()).optional(),
  testReports: z.array(AgentTaskRunTestReportSchema).optional(),
  toolCallId: z.string().optional(),
  createdAt: z.string()
});

const AgentTaskRunWorktreeDiffSchema = z.object({
  hasChanges: z.boolean(),
  files: z.number().int().min(0),
  insertions: z.number().int().min(0).optional(),
  deletions: z.number().int().min(0).optional(),
  changedPaths: z.array(z.string()),
  updatedAt: z.string()
});

const AgentTaskRunWorktreePatchPreviewSchema = z.object({
  text: z.string(),
  bytes: z.number().int().min(0),
  lineCount: z.number().int().min(0),
  truncated: z.boolean(),
  updatedAt: z.string()
});

const AgentTaskRunWorktreePullRequestFeedbackItemSchema = z.object({
  kind: z.enum(["comment", "review", "thread"]),
  author: z.string().optional(),
  state: z.string().optional(),
  body: z.string().optional(),
  path: z.string().optional(),
  line: z.number().int().min(0).optional(),
  url: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
});

const AgentTaskRunWorktreePullRequestFeedbackSchema = z.object({
  total: z.number().int().min(0),
  comments: z.number().int().min(0),
  reviews: z.number().int().min(0),
  threads: z.number().int().min(0).optional(),
  unresolvedThreads: z.number().int().min(0).optional(),
  resolvedThreads: z.number().int().min(0).optional(),
  changesRequested: z.number().int().min(0),
  approved: z.number().int().min(0),
  commented: z.number().int().min(0),
  summary: z.string(),
  threadFetchError: z.string().optional(),
  items: z.array(AgentTaskRunWorktreePullRequestFeedbackItemSchema)
});

const AgentTaskRunWorktreePullRequestCheckItemSchema = z.object({
  name: z.string(),
  bucket: z.enum(["passed", "failed", "pending", "skipped", "cancelled", "unknown"]),
  status: z.string().optional(),
  conclusion: z.string().optional(),
  state: z.string().optional(),
  detailsUrl: z.string().optional(),
  logSource: z.enum(["github_actions", "details_url"]).optional(),
  logCommand: z.string().optional(),
  logArtifactId: z.string().optional(),
  logFetchedAt: z.string().optional(),
  logError: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional()
});

const AgentTaskRunWorktreePullRequestReviewNotificationSchema = z.object({
  level: z.enum(["info", "success", "warning"]),
  summary: z.string(),
  detail: z.string().optional(),
  createdAt: z.string()
});

const AgentTaskRunWorktreePullRequestReviewSchema = z.object({
  state: z.string().optional(),
  isDraft: z.boolean().optional(),
  reviewDecision: z.string().optional(),
  mergeStateStatus: z.string().optional(),
  checkSummary: z.string(),
  checks: z.object({
    total: z.number().int().min(0),
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    pending: z.number().int().min(0),
    skipped: z.number().int().min(0),
    cancelled: z.number().int().min(0),
    unknown: z.number().int().min(0)
  }),
  checkItems: z.array(AgentTaskRunWorktreePullRequestCheckItemSchema).optional(),
  notifications: z.array(AgentTaskRunWorktreePullRequestReviewNotificationSchema).optional(),
  summary: z.string(),
  feedback: AgentTaskRunWorktreePullRequestFeedbackSchema.optional(),
  updatedAt: z.string()
});

const AgentTaskRunWorktreePullRequestSchema = z.object({
  title: z.string(),
  body: z.string(),
  branch: z.string(),
  baseBranch: z.string().optional(),
  baseRef: z.string().optional(),
  commit: z.string(),
  remoteName: z.string().optional(),
  remoteUrl: z.string().optional(),
  pushCommand: z.string().optional(),
  createCommand: z.string().optional(),
  preparedAt: z.string(),
  pushedAt: z.string().optional(),
  createdAt: z.string().optional(),
  url: z.string().optional(),
  review: AgentTaskRunWorktreePullRequestReviewSchema.optional()
});

const AgentTaskRunWorktreeConflictSchema = z.object({
  type: z.enum(["sync"]),
  message: z.string(),
  files: z.array(z.string()),
  originalHead: z.string().optional(),
  taskHead: z.string().optional(),
  detectedAt: z.string()
});

const AgentTaskRunWorktreeSchema = z.object({
  enabled: z.boolean(),
  status: z.enum(["creating", "ready", "failed", "merged", "discarded", "cleaned"]),
  originalRoot: z.string().optional(),
  path: z.string().optional(),
  branch: z.string().optional(),
  baseRef: z.string().optional(),
  plannedFromTaskRunId: z.string().optional(),
  continuedFromTaskRunId: z.string().optional(),
  replayOfTaskRunId: z.string().optional(),
  createdAt: z.string().optional(),
  diff: AgentTaskRunWorktreeDiffSchema.optional(),
  patchPreview: AgentTaskRunWorktreePatchPreviewSchema.optional(),
  pullRequest: AgentTaskRunWorktreePullRequestSchema.optional(),
  conflict: AgentTaskRunWorktreeConflictSchema.optional(),
  mergeCommit: z.string().optional(),
  mergedAt: z.string().optional(),
  discardedAt: z.string().optional(),
  cleanedAt: z.string().optional(),
  error: z.string().optional()
});

const AgentTaskRunPlanSchema = z.object({
  summary: z.string().optional(),
  items: z.array(
    z.object({
      text: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]).optional()
    })
  ),
  sourceMessageIndex: z.number().int().min(0).optional(),
  updatedAt: z.string()
});

const AgentTaskRunCompletionSchema = z.object({
  summary: z.string().optional(),
  items: z.array(
    z.object({
      text: z.string(),
      status: z.enum(["completed", "needs_followup", "blocked"]).optional(),
      evidence: z
        .array(
          z.object({
            kind: z.enum(["file", "command", "report", "check", "note"]),
            value: z.string()
          })
        )
        .optional()
    })
  ),
  sourceMessageIndex: z.number().int().min(0).optional(),
  updatedAt: z.string()
});

const AgentTaskRunPlanReviewSchema = z.object({
  status: z.enum(["approved", "revision_requested", "cancelled"]),
  updatedAt: z.string()
});

const AgentTaskRunVerificationSchema = z.object({
  status: z.enum(["passed", "failed", "unknown"]),
  summary: z.string(),
  commandCount: z.number().int().min(0),
  failedCommandCount: z.number().int().min(0),
  parsedReportCount: z.number().int().min(0),
  failedReportCount: z.number().int().min(0),
  passedReportCount: z.number().int().min(0),
  unknownReportCount: z.number().int().min(0),
  updatedAt: z.string()
});

const AgentTaskRunSchema = z.object({
  id: z.string(),
  userMessageIndex: z.number().int().min(0),
  promptPreview: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "stopped", "blocked", "max_iterations"]),
  model: z.string().optional(),
  providerName: z.string().optional(),
  modelSelectionReason: z.string().optional(),
  loop: z
    .object({
      enabled: z.boolean(),
      maxIterations: z.number().int().min(1).max(10)
    })
    .optional(),
  planMode: z
    .object({
      enabled: z.boolean()
    })
    .optional(),
  plan: AgentTaskRunPlanSchema.optional(),
  completion: AgentTaskRunCompletionSchema.optional(),
  planReview: AgentTaskRunPlanReviewSchema.optional(),
  worktree: AgentTaskRunWorktreeSchema.optional(),
  verification: AgentTaskRunVerificationSchema.optional(),
  capabilities: z.array(AgentTaskRunToolSchema.shape.capability),
  tools: z.array(AgentTaskRunToolSchema),
  approvals: z.array(AgentTaskRunApprovalSchema).default([]),
  artifacts: z.array(AgentTaskRunArtifactSchema),
  startedAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  error: z.string().optional()
});

const SessionSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  pinnedAt: z.string().optional(),
  cwd: z.string(),
  projectRoot: z.string().nullable().optional(),
  trustMode: z.enum(["ask", "readonly", "trusted"]),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  modelMode: z.enum(["manual", "auto"]).optional(),
  selectedModel: z.string().optional(),
  selectedProviderId: z.string().optional(),
  selectedProviderName: z.string().optional(),
  modelSelectionReason: z.string().optional(),
  agentLoop: AgentLoopSchema.optional(),
  taskRuns: z.array(AgentTaskRunSchema).optional(),
  messages: z.array(MessageSchema),
  createdAt: z.string(),
  updatedAt: z.string()
});

const MAX_SESSION_LIST_FILE_BYTES = 2 * 1024 * 1024;

export class SessionStore {
  constructor(private readonly root = path.join(appDataDir(), "sessions")) {}

  async save(session: AgentSession) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = this.fileFor(session.id);
    await writeFile(file, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
  }

  async load(id: string): Promise<AgentSession> {
    const raw = await readFile(this.fileFor(id), "utf8");
    return SessionSchema.parse(JSON.parse(raw)) as AgentSession;
  }

  async delete(id: string) {
    await unlink(this.fileFor(id));
  }

  async list(): Promise<AgentSession[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const sessions: AgentSession[] = [];
    for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
      const session = await this.readSessionForList(entry);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions.sort(compareSessionsForList);
  }

  private async readSessionForList(entry: string): Promise<AgentSession | undefined> {
    try {
      const filePath = path.join(this.root, entry);
      const info = await stat(filePath);
      if (!info.isFile() || info.size > MAX_SESSION_LIST_FILE_BYTES) {
        return undefined;
      }
      const raw = await readFile(filePath, "utf8");
      return SessionSchema.parse(JSON.parse(raw)) as AgentSession;
    } catch {
      return undefined;
    }
  }

  private fileFor(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error("Invalid session id.");
    }
    return path.join(this.root, `${id}.json`);
  }
}

function compareSessionsForList(left: AgentSession, right: AgentSession) {
  if (left.pinnedAt || right.pinnedAt) {
    if (!left.pinnedAt) {
      return 1;
    }
    if (!right.pinnedAt) {
      return -1;
    }
    return right.pinnedAt.localeCompare(left.pinnedAt);
  }
  return right.updatedAt.localeCompare(left.updatedAt);
}

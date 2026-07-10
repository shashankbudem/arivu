import crypto from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { appDataDir } from "../config.js";
import { chatContentToText } from "../agent/content.js";
import type { AgentSession, ChatMessage } from "../agent/types.js";

const ATTACHMENT_REF_PREFIX = "arivu-attachment:v1:";
const ATTACHMENT_INLINE_THRESHOLD_BYTES = 2 * 1024;

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
  lastDecision: z.enum(["continue", "done", "blocked"]).optional(),
  iterations: z
    .array(
      z.object({
        iteration: z.number().int().min(1),
        status: z.enum(["running", "continued", "completed", "stopped", "blocked", "failed", "max_iterations"]),
        startedAt: z.string(),
        updatedAt: z.string(),
        completedAt: z.string().optional(),
        decision: z.enum(["continue", "done", "blocked"]).optional(),
        assistantMessageIndex: z.number().int().min(0).optional(),
        outputPreview: z.string().optional(),
        toolCallCount: z.number().int().min(0).optional(),
        artifactCount: z.number().int().min(0).optional(),
        error: z.string().optional()
      })
    )
    .optional()
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

const AgentTaskRunDiagnosticSchema = z.object({
  source: z.enum(["typescript", "eslint"]),
  severity: z.enum(["error", "warning", "info", "hint"]),
  message: z.string(),
  code: z.string().optional(),
  path: z.string().optional(),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional()
});

const AgentTaskRunArtifactSchema = z.object({
  id: z.string(),
  kind: z.enum(["browser_screenshot", "browser_task_log", "command_output", "file_change", "patch", "tool_result"]),
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
  commandMode: z.enum(["shell", "argv"]).optional(),
  commandRisk: z.enum(["low", "medium", "high"]).optional(),
  commandAnalysis: z.string().optional(),
  executionProfile: z.enum(["host", "container", "sandbox"]).optional(),
  executionIsolation: z.string().optional(),
  workingDirectory: z.string().optional(),
  timeoutMs: z.number().int().min(0).optional(),
  timedOut: z.boolean().optional(),
  signal: z.string().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().min(0).optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  stdoutTruncated: z.boolean().optional(),
  stderrTruncated: z.boolean().optional(),
  reportPaths: z.array(z.string()).optional(),
  testReports: z.array(AgentTaskRunTestReportSchema).optional(),
  diagnostics: z.array(AgentTaskRunDiagnosticSchema).optional(),
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
  timedOutCommandCount: z.number().int().min(0).optional(),
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
  usage: z
    .object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      totalTokens: z.number(),
      requestCount: z.number()
    })
    .optional(),
  checkpoint: z
    .object({
      changedPaths: z.array(z.string()),
      capturedAt: z.string(),
      revertedAt: z.string().optional()
    })
    .optional(),
  loop: z
    .object({
      enabled: z.boolean(),
      maxIterations: z.number().int().min(1).max(10),
      status: AgentLoopSchema.shape.status.optional(),
      iteration: z.number().int().min(0).optional(),
      lastDecision: AgentLoopSchema.shape.lastDecision,
      iterations: AgentLoopSchema.shape.iterations
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
  private saveCounter = 0;

  constructor(private readonly root = path.join(appDataDir(), "sessions")) {}

  async save(session: AgentSession) {
    normalizeTaskRunUserMessageIndexes(session);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Persist large image attachments as separate files, keeping the JSON small and diffable.
    const persisted = await this.externalizeAttachments(session);
    const file = this.fileFor(session.id);
    // Write to a temp file in the same directory, then atomically rename so a crash mid-write
    // cannot corrupt the session file.
    const tmp = `${file}.${process.pid}.${(this.saveCounter += 1)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    await chmod(file, 0o600);
  }

  async load(id: string): Promise<AgentSession> {
    const raw = await readFile(this.fileFor(id), "utf8");
    const session = normalizeTaskRunUserMessageIndexes(SessionSchema.parse(JSON.parse(raw)) as AgentSession);
    return this.rehydrateAttachments(session);
  }

  async delete(id: string) {
    await unlink(this.fileFor(id));
    await rm(this.attachmentsDir(id), { recursive: true, force: true });
  }

  private attachmentsDir(sessionId: string) {
    return path.join(this.root, "attachments", sessionId);
  }

  private async externalizeAttachments(session: AgentSession): Promise<AgentSession> {
    if (!session.messages.some((message) => Array.isArray(message.content))) {
      return session;
    }
    const clone: AgentSession = structuredClone(session);
    const dir = this.attachmentsDir(session.id);
    let dirEnsured = false;
    for (const message of clone.messages) {
      for (const part of imageParts(message)) {
        const data = parseDataUrl(part.image_url.url);
        if (!data || data.bytes.length < ATTACHMENT_INLINE_THRESHOLD_BYTES) {
          continue;
        }
        const hash = crypto.createHash("sha256").update(data.bytes).digest("hex");
        if (!dirEnsured) {
          await mkdir(dir, { recursive: true, mode: 0o700 });
          dirEnsured = true;
        }
        const filePath = path.join(dir, hash);
        if (!(await fileExists(filePath))) {
          await writeFile(filePath, data.bytes, { mode: 0o600 });
        }
        part.mimeType = part.mimeType ?? data.mimeType;
        part.image_url.url = `${ATTACHMENT_REF_PREFIX}${hash}`;
      }
    }
    return clone;
  }

  private async rehydrateAttachments(session: AgentSession): Promise<AgentSession> {
    const dir = this.attachmentsDir(session.id);
    for (const message of session.messages) {
      for (const part of imageParts(message)) {
        const url = part.image_url.url;
        if (!url.startsWith(ATTACHMENT_REF_PREFIX)) {
          continue;
        }
        const hash = url.slice(ATTACHMENT_REF_PREFIX.length);
        try {
          const bytes = await readFile(path.join(dir, hash));
          const mimeType = part.mimeType ?? "image/png";
          part.image_url.url = `data:${mimeType};base64,${bytes.toString("base64")}`;
        } catch {
          // Missing attachment file; leave the reference so the gap is visible rather than silently blank.
        }
      }
    }
    return session;
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
    const filePath = path.join(this.root, entry);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        return undefined;
      }
      if (info.size > MAX_SESSION_LIST_FILE_BYTES) {
        console.warn(
          `[SessionStore] Hiding "${entry}" from the session list: ${info.size} bytes exceeds the ${MAX_SESSION_LIST_FILE_BYTES}-byte cap. The file is intact on disk.`
        );
        return undefined;
      }
      const raw = await readFile(filePath, "utf8");
      return normalizeTaskRunUserMessageIndexes(SessionSchema.parse(JSON.parse(raw)) as AgentSession);
    } catch (error) {
      // A single unreadable file must not drop the rest of the list, but swallowing it silently
      // is what let a schema drift hide sessions with no signal. Log which file and why.
      console.warn(`[SessionStore] Hiding "${entry}" from the session list: ${describeSessionLoadError(error)}`);
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

function describeSessionLoadError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issues = error.issues.slice(0, 3).map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${location}: ${issue.message}`;
    });
    const more = error.issues.length > issues.length ? ` (+${error.issues.length - issues.length} more)` : "";
    return `schema validation failed — ${issues.join("; ")}${more}`;
  }
  if (error instanceof SyntaxError) {
    return `invalid JSON — ${error.message} (file may be truncated from an interrupted write)`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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

function normalizeTaskRunUserMessageIndexes(session: AgentSession) {
  for (const run of session.taskRuns ?? []) {
    const current = session.messages[run.userMessageIndex];
    if (current?.role === "user" && taskRunMatchesUserMessage(run.promptPreview, current.content)) {
      continue;
    }

    const matchingIndexes = session.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.role === "user" && taskRunMatchesUserMessage(run.promptPreview, message.content))
      .map(({ index }) => index);
    const repairedIndex = closestUniqueIndex(matchingIndexes, run.userMessageIndex);
    if (repairedIndex !== undefined) {
      run.userMessageIndex = repairedIndex;
    }
  }
  return session;
}

function taskRunMatchesUserMessage(promptPreview: string, content: AgentSession["messages"][number]["content"]) {
  const preview = normalizePromptPreview(promptPreview);
  if (!preview) {
    return false;
  }
  const messageText = normalizePromptPreview(chatContentToText(content));
  if (preview.endsWith("...")) {
    const prefix = preview.slice(0, -3).trimEnd();
    return prefix.length >= 12 && messageText.startsWith(prefix);
  }
  return messageText === preview;
}

function closestUniqueIndex(indexes: number[], target: number) {
  if (indexes.length === 0) {
    return undefined;
  }
  const [best, second] = [...indexes].sort((left, right) => Math.abs(left - target) - Math.abs(right - target));
  if (second !== undefined && Math.abs(second - target) === Math.abs((best ?? 0) - target)) {
    return undefined;
  }
  return best;
}

function normalizePromptPreview(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

type ImageContentPart = Extract<Exclude<ChatMessage["content"], string>[number], { type: "image_url" }>;

function imageParts(message: ChatMessage): ImageContentPart[] {
  if (!Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter((part): part is ImageContentPart => part.type === "image_url");
}

function parseDataUrl(url: string): { mimeType: string; bytes: Buffer } | undefined {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
  if (!match) {
    return undefined;
  }
  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const data = match[3] ?? "";
  try {
    const bytes = isBase64 ? Buffer.from(data, "base64") : Buffer.from(decodeURIComponent(data), "utf8");
    return { mimeType, bytes };
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

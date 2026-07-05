import type { TrustMode } from "../permissions/types.js";
import type { CommandExecutionProfile } from "../execution/profile.js";
import type { ChatContent } from "./content.js";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type ChatMessage = {
  role: ChatRole;
  content: ChatContent;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
};

export type ToolSchema = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools: ToolSchema[];
};

export type ChatResponse = {
  message: ChatMessage;
};

export type ChatStreamEvent =
  | {
      type: "content_delta";
      delta: string;
    }
  | {
      type: "tool_call_delta";
      index: number;
      id: string;
      name: string;
      argumentsDelta: string;
      argumentsText: string;
    };

export type ChatStreamHandler = (event: ChatStreamEvent) => void | Promise<void>;

export interface ChatClient {
  complete(request: ChatRequest): Promise<ChatResponse>;
  stream?(request: ChatRequest, onEvent?: ChatStreamHandler): Promise<ChatResponse>;
}

export type AgentRunEvent =
  | {
      type: "assistant_delta";
      delta: string;
    }
  | {
      type: "tool_call_delta";
      toolCallId: string;
      index: number;
      name: string;
      argumentsDelta: string;
      argumentsText: string;
    }
  | {
      type: "tool_call";
      call: ToolCall;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      result: string;
    };

export type AgentRunOptions = {
  onEvent?: (event: AgentRunEvent) => void | Promise<void>;
  skillNames?: string[];
  promptAlreadyInSession?: boolean;
  allowedToolNames?: string[];
};

export type AgentLoopStatus = "running" | "stopping" | "completed" | "stopped" | "blocked" | "failed" | "max_iterations";
export type AgentLoopDecision = "continue" | "done" | "blocked";
export type AgentLoopIterationStatus = "running" | "continued" | "completed" | "stopped" | "blocked" | "failed" | "max_iterations";

export type AgentLoopIteration = {
  iteration: number;
  status: AgentLoopIterationStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  decision?: AgentLoopDecision;
  assistantMessageIndex?: number;
  outputPreview?: string;
  toolCallCount?: number;
  artifactCount?: number;
  error?: string;
};

export type AgentLoopState = {
  status: AgentLoopStatus;
  goal: string;
  iteration: number;
  maxIterations: number;
  startedAt: string;
  updatedAt: string;
  stopRequested?: boolean;
  lastDecision?: AgentLoopDecision;
  iterations?: AgentLoopIteration[];
};

export type AgentTaskRunStatus = "queued" | "running" | "completed" | "failed" | "stopped" | "blocked" | "max_iterations";

export type AgentTaskRunCapability =
  | "read_repo"
  | "write_workspace"
  | "run_command"
  | "network_fetch"
  | "browser_control"
  | "mcp_call"
  | "skill_context"
  | "local_context"
  | "unknown";

export type AgentTaskRunToolStatus = "running" | "done" | "failed";

export type AgentTaskRunToolCall = {
  id: string;
  toolCallId: string;
  name: string;
  arguments?: unknown;
  capability: AgentTaskRunCapability;
  status: AgentTaskRunToolStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  resultPreview?: string;
  artifactIds?: string[];
};

export type AgentTaskRunApprovalStatus = "allowed" | "requested" | "approved" | "denied" | "blocked";
export type AgentTaskRunApprovalEffect = "allow" | "prompt" | "deny";
export type AgentTaskRunApprovalOverride = "prompt" | "deny";
export type AgentTaskRunApprovalScopeKind = "path" | "query" | "command" | "network" | "browser" | "mcp" | "unknown";
export type AgentTaskRunApprovalScope = {
  kind: AgentTaskRunApprovalScopeKind;
  label: string;
  value?: string;
  detail?: string;
};

export type AgentTaskRunApprovalChangePreview = {
  kind: "patch" | "file_change";
  title: string;
  summary?: string;
  path?: string;
  writeMode?: "create" | "replace";
  diff?: string;
  diffTruncated?: boolean;
  content?: string;
  contentTruncated?: boolean;
  original?: string;
  originalTruncated?: boolean;
  changedPaths?: string[];
  additions?: number;
  deletions?: number;
  lineCount?: number;
  bytes?: number;
};

export type AgentTaskRunApproval = {
  id: string;
  actionType: "read" | "write" | "shell" | "mcp" | "network" | "browser";
  capability: AgentTaskRunCapability;
  status: AgentTaskRunApprovalStatus;
  trustMode: TrustMode;
  effect: AgentTaskRunApprovalEffect;
  label: string;
  reason: string;
  risky: boolean;
  override?: AgentTaskRunApprovalOverride;
  scope?: AgentTaskRunApprovalScope;
  changePreview?: AgentTaskRunApprovalChangePreview;
  summary: string;
  message?: string;
  createdAt: string;
  requestedAt?: string;
  decidedAt?: string;
  updatedAt?: string;
};

export type AgentTaskRunApprovalEvent = Omit<AgentTaskRunApproval, "createdAt" | "requestedAt" | "decidedAt" | "updatedAt"> & {
  createdAt?: string;
};

export type AgentTaskRunReportStatus = "passed" | "failed" | "unknown";

export type AgentTaskRunFailedTest = {
  name: string;
  classname?: string;
  file?: string;
  line?: number;
  message?: string;
  type?: "failure" | "error";
};

export type AgentTaskRunReportFinding = {
  ruleId?: string;
  level?: "error" | "warning" | "note" | "none";
  message?: string;
  path?: string;
  line?: number;
  column?: number;
};

export type AgentTaskRunDiagnosticSeverity = "error" | "warning" | "info" | "hint";

export type AgentTaskRunDiagnostic = {
  source: "typescript" | "eslint";
  severity: AgentTaskRunDiagnosticSeverity;
  message: string;
  code?: string;
  path?: string;
  line?: number;
  column?: number;
};

export type AgentTaskRunTestReport = {
  kind: "junit" | "sarif";
  path: string;
  summary: string;
  status: AgentTaskRunReportStatus;
  tests?: number;
  failures?: number;
  errors?: number;
  skipped?: number;
  suites?: number;
  durationSeconds?: number;
  findings?: number;
  errorFindings?: number;
  warningFindings?: number;
  noteFindings?: number;
  rules?: number;
  failedTests?: AgentTaskRunFailedTest[];
  findingDetails?: AgentTaskRunReportFinding[];
};

export type AgentTaskRunArtifact = {
  id: string;
  kind: "browser_screenshot" | "command_output" | "file_change" | "patch" | "tool_result";
  title: string;
  summary?: string;
  path?: string;
  width?: number;
  height?: number;
  writeMode?: "create" | "replace";
  content?: string;
  contentTruncated?: boolean;
  lineCount?: number;
  diff?: string;
  diffTruncated?: boolean;
  changedPaths?: string[];
  additions?: number;
  deletions?: number;
  command?: string;
  executionProfile?: CommandExecutionProfile;
  executionIsolation?: string;
  workingDirectory?: string;
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  reportPaths?: string[];
  testReports?: AgentTaskRunTestReport[];
  diagnostics?: AgentTaskRunDiagnostic[];
  toolCallId?: string;
  createdAt: string;
};

export type AgentTaskRunWorktreeStatus = "creating" | "ready" | "failed" | "merged" | "discarded" | "cleaned";

export type AgentTaskRunWorktreeDiff = {
  hasChanges: boolean;
  files: number;
  insertions?: number;
  deletions?: number;
  changedPaths: string[];
  updatedAt: string;
};

export type AgentTaskRunWorktreePatchPreview = {
  text: string;
  bytes: number;
  lineCount: number;
  truncated: boolean;
  updatedAt: string;
};

export type AgentTaskRunWorktreePullRequestFeedbackItem = {
  kind: "comment" | "review" | "thread";
  author?: string;
  state?: string;
  body?: string;
  path?: string;
  line?: number;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type AgentTaskRunWorktreePullRequestFeedback = {
  total: number;
  comments: number;
  reviews: number;
  threads?: number;
  unresolvedThreads?: number;
  resolvedThreads?: number;
  changesRequested: number;
  approved: number;
  commented: number;
  summary: string;
  threadFetchError?: string;
  items: AgentTaskRunWorktreePullRequestFeedbackItem[];
};

export type AgentTaskRunWorktreePullRequestCheckItem = {
  name: string;
  bucket: "passed" | "failed" | "pending" | "skipped" | "cancelled" | "unknown";
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  logSource?: "github_actions" | "details_url";
  logCommand?: string;
  logArtifactId?: string;
  logFetchedAt?: string;
  logError?: string;
  startedAt?: string;
  completedAt?: string;
};

export type AgentTaskRunWorktreePullRequestReviewNotification = {
  level: "info" | "success" | "warning";
  summary: string;
  detail?: string;
  createdAt: string;
};

export type AgentTaskRunWorktreePullRequestReview = {
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string;
  mergeStateStatus?: string;
  checkSummary: string;
  checks: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    skipped: number;
    cancelled: number;
    unknown: number;
  };
  checkItems?: AgentTaskRunWorktreePullRequestCheckItem[];
  notifications?: AgentTaskRunWorktreePullRequestReviewNotification[];
  summary: string;
  feedback?: AgentTaskRunWorktreePullRequestFeedback;
  updatedAt: string;
};

export type AgentTaskRunWorktreePullRequest = {
  title: string;
  body: string;
  branch: string;
  baseBranch?: string;
  baseRef?: string;
  commit: string;
  remoteName?: string;
  remoteUrl?: string;
  pushCommand?: string;
  createCommand?: string;
  preparedAt: string;
  pushedAt?: string;
  createdAt?: string;
  url?: string;
  review?: AgentTaskRunWorktreePullRequestReview;
};

export type AgentTaskRunWorktreeConflict = {
  type: "sync";
  message: string;
  files: string[];
  originalHead?: string;
  taskHead?: string;
  detectedAt: string;
};

export type AgentTaskRunWorktree = {
  enabled: boolean;
  status: AgentTaskRunWorktreeStatus;
  originalRoot?: string;
  path?: string;
  branch?: string;
  baseRef?: string;
  plannedFromTaskRunId?: string;
  continuedFromTaskRunId?: string;
  replayOfTaskRunId?: string;
  createdAt?: string;
  diff?: AgentTaskRunWorktreeDiff;
  patchPreview?: AgentTaskRunWorktreePatchPreview;
  pullRequest?: AgentTaskRunWorktreePullRequest;
  conflict?: AgentTaskRunWorktreeConflict;
  mergeCommit?: string;
  mergedAt?: string;
  discardedAt?: string;
  cleanedAt?: string;
  error?: string;
};

export type AgentTaskRunPlanItemStatus = "pending" | "in_progress" | "completed";

export type AgentTaskRunPlanItem = {
  text: string;
  status?: AgentTaskRunPlanItemStatus;
};

export type AgentTaskRunPlan = {
  summary?: string;
  items: AgentTaskRunPlanItem[];
  sourceMessageIndex?: number;
  updatedAt: string;
};

export type AgentTaskRunCompletionItemStatus = "completed" | "needs_followup" | "blocked";
export type AgentTaskRunCompletionEvidenceKind = "file" | "command" | "report" | "check" | "note";

export type AgentTaskRunCompletionEvidenceLabel = {
  kind: AgentTaskRunCompletionEvidenceKind;
  value: string;
};

export type AgentTaskRunCompletionItem = {
  text: string;
  status?: AgentTaskRunCompletionItemStatus;
  evidence?: AgentTaskRunCompletionEvidenceLabel[];
};

export type AgentTaskRunCompletion = {
  summary?: string;
  items: AgentTaskRunCompletionItem[];
  sourceMessageIndex?: number;
  updatedAt: string;
};

export type AgentTaskRunPlanReviewStatus = "approved" | "revision_requested" | "cancelled";

export type AgentTaskRunPlanReview = {
  status: AgentTaskRunPlanReviewStatus;
  updatedAt: string;
};

export type AgentTaskRunVerificationStatus = "passed" | "failed" | "unknown";

export type AgentTaskRunVerification = {
  status: AgentTaskRunVerificationStatus;
  summary: string;
  commandCount: number;
  failedCommandCount: number;
  parsedReportCount: number;
  failedReportCount: number;
  passedReportCount: number;
  unknownReportCount: number;
  updatedAt: string;
};

export type AgentTaskRun = {
  id: string;
  userMessageIndex: number;
  promptPreview: string;
  status: AgentTaskRunStatus;
  model?: string;
  providerName?: string;
  modelSelectionReason?: string;
  loop?: {
    enabled: boolean;
    maxIterations: number;
    status?: AgentLoopStatus;
    iteration?: number;
    lastDecision?: AgentLoopDecision;
    iterations?: AgentLoopIteration[];
  };
  planMode?: {
    enabled: boolean;
  };
  plan?: AgentTaskRunPlan;
  completion?: AgentTaskRunCompletion;
  planReview?: AgentTaskRunPlanReview;
  worktree?: AgentTaskRunWorktree;
  verification?: AgentTaskRunVerification;
  capabilities: AgentTaskRunCapability[];
  tools: AgentTaskRunToolCall[];
  approvals: AgentTaskRunApproval[];
  artifacts: AgentTaskRunArtifact[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
};

export type AgentSession = {
  id: string;
  title?: string;
  pinnedAt?: string;
  cwd: string;
  projectRoot?: string | null;
  trustMode: TrustMode;
  model?: string;
  baseUrl?: string;
  modelMode?: "manual" | "auto";
  selectedModel?: string;
  selectedProviderId?: string;
  selectedProviderName?: string;
  modelSelectionReason?: string;
  agentLoop?: AgentLoopState;
  taskRuns?: AgentTaskRun[];
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
};

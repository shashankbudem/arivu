/// <reference types="vite/client" />

type TrustMode = "ask" | "readonly" | "trusted";
type ProviderToolCallingMode = "auto" | "enabled" | "disabled";
type ProviderImageInputMode = "auto" | "enabled" | "disabled";
type BrowserMode = "visible" | "background";

type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
};

type McpServersConfig = Record<string, McpServerConfig>;

type LlmProviderProfile = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  toolCalling: ProviderToolCallingMode;
  imageInput: ProviderImageInputMode;
  contextWindowTokens?: number;
  apiKeyPresent: boolean;
};

type LlmProviderPatch = Omit<LlmProviderProfile, "apiKeyPresent"> & {
  apiKey?: string;
};

type ToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

type ImageDetail = "auto" | "low" | "high";

type ChatTextPart = {
  type: "text";
  text: string;
};

type ChatImagePart = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: ImageDetail;
  };
  name?: string;
  mimeType?: string;
  size?: number;
};

type ChatContentPart = ChatTextPart | ChatImagePart;

type ChatContent = string | ChatContentPart[];

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: ChatContent;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
};

type AgentLoopStatus = "running" | "stopping" | "completed" | "stopped" | "blocked" | "failed" | "max_iterations";
type AgentLoopDecision = "continue" | "done" | "blocked";
type AgentLoopIterationStatus = "running" | "continued" | "completed" | "stopped" | "blocked" | "failed" | "max_iterations";

type AgentLoopIteration = {
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

type AgentLoopState = {
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

type AgentTaskRunStatus = "queued" | "running" | "completed" | "failed" | "stopped" | "blocked" | "max_iterations";

type AgentTaskRunCapability =
  | "read_repo"
  | "write_workspace"
  | "run_command"
  | "network_fetch"
  | "browser_control"
  | "mcp_call"
  | "skill_context"
  | "local_context"
  | "unknown";

type CapabilityPolicyOverrideEffect = "prompt" | "deny";
type WorkspacePolicyCapability =
  "read_repo" | "write_workspace" | "run_command" | "network_fetch" | "browser_control" | "mcp_call" | "unknown";
type WorkspaceCapabilityPolicyOverrides = Partial<Record<WorkspacePolicyCapability, CapabilityPolicyOverrideEffect>>;
type WorkspaceScopePolicyRules = {
  blockedPathPrefixes?: string[];
  allowedNetworkDomains?: string[];
  allowedMcpServers?: string[];
  allowedBrowserTargetClasses?: Array<"background" | "visible" | "local" | "file" | "public">;
};
type WorkspaceCapabilityPolicy = {
  overrides: WorkspaceCapabilityPolicyOverrides;
  scopeRules: WorkspaceScopePolicyRules;
};
type WorkspaceCapabilityPolicies = Record<string, WorkspaceCapabilityPolicy>;
type WorkspacePolicyProfiles = Record<string, WorkspaceCapabilityPolicy>;
type WorkspacePolicyBundle = WorkspaceCapabilityPolicy & {
  kind: "arivu.workspacePolicy";
  version: 1;
  name: string;
  description?: string;
  sourcePath: string;
};
type WorkspacePolicyBundleResult = {
  path: string;
  exists: boolean;
  bundle: WorkspacePolicyBundle | null;
  error?: string;
};

type AgentTaskRunToolCall = {
  id: string;
  toolCallId: string;
  name: string;
  arguments?: unknown;
  capability: AgentTaskRunCapability;
  status: "running" | "done" | "failed";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  resultPreview?: string;
  artifactIds?: string[];
};

type AgentTaskRunApprovalStatus = "allowed" | "requested" | "approved" | "denied" | "blocked";
type AgentTaskRunApprovalEffect = "allow" | "prompt" | "deny";
type AgentTaskRunApprovalOverride = "prompt" | "deny";
type AgentTaskRunApprovalScopeKind = "path" | "query" | "command" | "network" | "browser" | "mcp" | "unknown";
type AgentTaskRunApprovalScope = {
  kind: AgentTaskRunApprovalScopeKind;
  label: string;
  value?: string;
  detail?: string;
};
type AgentTaskRunApprovalChangePreview = {
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
type AgentTaskRunApproval = {
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

type AgentTaskRunTestReport = {
  kind: "junit" | "sarif";
  path: string;
  summary: string;
  status: "passed" | "failed" | "unknown";
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
  failedTests?: Array<{
    name: string;
    classname?: string;
    file?: string;
    line?: number;
    message?: string;
    type?: "failure" | "error";
  }>;
  findingDetails?: Array<{
    ruleId?: string;
    level?: "error" | "warning" | "note" | "none";
    message?: string;
    path?: string;
    line?: number;
    column?: number;
  }>;
};

type AgentTaskRunDiagnostic = {
  source: "typescript" | "eslint";
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  code?: string;
  path?: string;
  line?: number;
  column?: number;
};

type AgentTaskRunArtifact = {
  id: string;
  kind: "browser_screenshot" | "browser_task_log" | "command_output" | "file_change" | "patch" | "tool_result";
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
  commandMode?: "shell" | "argv";
  commandRisk?: "low" | "medium" | "high";
  commandAnalysis?: string;
  executionProfile?: "host" | "container" | "sandbox";
  executionIsolation?: string;
  workingDirectory?: string;
  timeoutMs?: number;
  timedOut?: boolean;
  signal?: string;
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  reportPaths?: string[];
  testReports?: AgentTaskRunTestReport[];
  diagnostics?: AgentTaskRunDiagnostic[];
  browserTask?: {
    success: boolean;
    model?: string;
    providerId?: string;
    providerName?: string;
    endpoint?: string;
    maxSteps?: number;
    timeoutMs?: number;
    stepDelayMs?: number;
    stepCount: number;
    stopReason?: string;
    navigationCount?: number;
    tokensUsed?: number;
    proxyDiagnostics?: Array<{
      attempt: number;
      timestamp: string;
      method: string;
      path: string;
      status: number;
      latencyMs: number;
      outcome: string;
      message?: string;
    }>;
  };
  toolCallId?: string;
  createdAt: string;
};

type AgentTaskRunWorktreeStatus = "creating" | "ready" | "failed" | "merged" | "discarded" | "cleaned";

type AgentTaskRunWorktreeDiff = {
  hasChanges: boolean;
  files: number;
  insertions?: number;
  deletions?: number;
  changedPaths: string[];
  updatedAt: string;
};

type AgentTaskRunWorktreePatchPreview = {
  text: string;
  bytes: number;
  lineCount: number;
  truncated: boolean;
  updatedAt: string;
};

type AgentTaskRunWorktreePullRequestFeedbackItem = {
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

type AgentTaskRunWorktreePullRequestFeedback = {
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

type AgentTaskRunWorktreePullRequestCheckItem = {
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

type AgentTaskRunWorktreePullRequestReviewNotification = {
  level: "info" | "success" | "warning";
  summary: string;
  detail?: string;
  createdAt: string;
};

type AgentTaskRunWorktreePullRequestReview = {
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

type AgentTaskRunWorktreePullRequest = {
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

type AgentTaskRunWorktreeConflict = {
  type: "sync";
  message: string;
  files: string[];
  originalHead?: string;
  taskHead?: string;
  detectedAt: string;
};

type AgentTaskRunWorktree = {
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

type AgentTaskRunPlan = {
  summary?: string;
  items: Array<{
    text: string;
    status?: "pending" | "in_progress" | "completed";
  }>;
  sourceMessageIndex?: number;
  updatedAt: string;
};

type AgentTaskRunPlanReviewStatus = "approved" | "revision_requested" | "cancelled";

type AgentTaskRunPlanReview = {
  status: AgentTaskRunPlanReviewStatus;
  updatedAt: string;
};

type AgentTaskRunCompletion = {
  summary?: string;
  items: Array<{
    text: string;
    status?: "completed" | "needs_followup" | "blocked";
    evidence?: Array<{
      kind: "file" | "command" | "report" | "check" | "note";
      value: string;
    }>;
  }>;
  sourceMessageIndex?: number;
  updatedAt: string;
};

type AgentTaskRunVerification = {
  status: "passed" | "failed" | "unknown";
  summary: string;
  commandCount: number;
  failedCommandCount: number;
  timedOutCommandCount?: number;
  parsedReportCount: number;
  failedReportCount: number;
  passedReportCount: number;
  unknownReportCount: number;
  updatedAt: string;
};

type AgentTaskRunVerificationStatus = AgentTaskRunVerification["status"];

type AgentTaskRunUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
};

type AgentTaskRun = {
  id: string;
  userMessageIndex: number;
  promptPreview: string;
  status: AgentTaskRunStatus;
  model?: string;
  providerName?: string;
  modelSelectionReason?: string;
  usage?: AgentTaskRunUsage;
  checkpoint?: {
    changedPaths: string[];
    capturedAt: string;
    revertedAt?: string;
  };
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

type TaskWorktreeInventoryItem = {
  sessionId: string;
  sessionTitle: string;
  taskRunId: string;
  promptPreview: string;
  status: AgentTaskRunStatus;
  verificationStatus?: AgentTaskRunVerificationStatus;
  verificationSummary?: string;
  worktreeStatus: AgentTaskRunWorktreeStatus;
  branch?: string;
  path?: string;
  folderExists: boolean;
  canOpen: boolean;
  canPreparePullRequest: boolean;
  canCreatePullRequest: boolean;
  canDiscard: boolean;
  canCleanup: boolean;
  pullRequestTitle?: string;
  pullRequestPreparedAt?: string;
  pullRequestUrl?: string;
  changedFiles?: number;
  updatedAt: string;
  createdAt?: string;
};

type TaskWorktreeInventoryResult = {
  worktrees: TaskWorktreeInventoryItem[];
};

type WorkspaceInfo = {
  root: string;
  gitBranch?: string;
  dirty: boolean;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  packageName?: string;
};

type DesktopState = {
  cwd: string;
  projectRoot: string | null;
  workspace: WorkspaceInfo;
  browser: BrowserState;
  config: {
    baseUrl: string;
    model: string;
    toolCalling: ProviderToolCallingMode;
    imageInput: ProviderImageInputMode;
    activeProviderId?: string;
    providers: LlmProviderProfile[];
    browserTaskModel?: BrowserTaskModelSettings;
    trustMode: TrustMode;
    apiKeyPresent: boolean;
    tavilyApiKeyPresent: boolean;
    mcpServers: McpServersConfig;
    workspacePolicies: WorkspaceCapabilityPolicies;
    workspacePolicyProfiles: WorkspacePolicyProfiles;
    disabledTools: string[];
  };
  sessionId?: string;
  messages: ChatMessage[];
  runningSessionIds: string[];
  modelSelection?: PublicModelSelection;
  agentLoop?: AgentLoopState;
  taskRuns?: AgentTaskRun[];
};

type BrowserTargetState = {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  lastError?: string;
  lastSnapshotAt?: string;
  lastScreenshotAt?: string;
  lastScreenshotPath?: string;
  owner?: "user" | "agent";
};

type BrowserTabState = BrowserTargetState;

type BrowserModeTargetState = BrowserTargetState & {
  mode: BrowserMode;
  activeTabId?: string;
  tabs?: BrowserTabState[];
};

type BrowserState = {
  paneOpen: boolean;
  defaultMode: BrowserMode;
  activeMode: BrowserMode;
  visible: BrowserModeTargetState;
  background: BrowserModeTargetState;
  collaboration?: {
    mode: "browse" | "element" | "region";
    pendingCount: number;
    activeAnnotationId?: string;
    handoff?: {
      id: number;
      prompt: string;
      screenshotPaths: string[];
    };
  };
};

type SessionSummary = {
  id: string;
  title: string;
  pinnedAt?: string;
  cwd: string;
  projectRoot: string | null;
  projectRootExists?: boolean;
  model?: string;
  modelMode?: "manual" | "auto";
  selectedModel?: string;
  selectedProviderName?: string;
  modelSelectionReason?: string;
  agentLoop?: AgentLoopState;
  taskRuns?: AgentTaskRun[];
  trustMode: TrustMode;
  messageCount: number;
  running: boolean;
  createdAt: string;
  updatedAt: string;
};

type PublicModelSelection = {
  mode: "manual" | "auto";
  model: string;
  providerName: string;
  reason: string;
};

type AgentRunResult = {
  output: string;
  sessionId: string;
  messages: ChatMessage[];
  newMessages: ChatMessage[];
  modelSelection?: PublicModelSelection;
  agentLoop?: AgentLoopState;
  taskRuns?: AgentTaskRun[];
  running?: boolean;
};

type AgentStreamEvent =
  | {
      type: "assistant_delta";
      sessionId?: string;
      delta: string;
    }
  | {
      type: "tool_call_delta";
      sessionId?: string;
      toolCallId: string;
      index: number;
      name: string;
      argumentsDelta: string;
      argumentsText: string;
    }
  | {
      type: "tool_call";
      sessionId?: string;
      call: ToolCall;
    }
  | {
      type: "tool_result";
      sessionId?: string;
      toolCallId: string;
      name: string;
      result: string;
    }
  | {
      type: "browser_task_progress";
      sessionId?: string;
      stepIndex: number;
      summary: string;
    };

type SessionLifecycleEvent = {
  type: "started" | "updated" | "completed" | "failed";
  sessionId: string;
  messages: ChatMessage[];
  sessions: SessionSummary[];
  runningSessionIds: string[];
  modelSelection?: PublicModelSelection;
  agentLoop?: AgentLoopState;
  taskRuns?: AgentTaskRun[];
  output?: string;
  error?: string;
};

type ApprovalPromptRequest = {
  actionType: "read" | "write" | "shell" | "mcp" | "network" | "browser";
  capability: AgentTaskRunCapability;
  summary: string;
  label: string;
  reason: string;
  risky: boolean;
  scope?: AgentTaskRunApprovalScope;
  changePreview?: AgentTaskRunApprovalChangePreview;
};

type ApprovalRequest = {
  id: string;
  message: string;
  request?: ApprovalPromptRequest;
};

type BrowserTaskModelSettings = {
  providerId?: string;
  baseUrl?: string;
  model?: string;
  maxSteps?: number;
  stepDelayMs?: number;
  apiKeyPresent: boolean;
};

type ConfigPatch = {
  apiKey?: string;
  tavilyApiKey?: string;
  baseUrl?: string;
  model?: string;
  toolCalling?: ProviderToolCallingMode;
  imageInput?: ProviderImageInputMode;
  activeProviderId?: string;
  providers?: LlmProviderPatch[];
  trustMode?: TrustMode;
  mcpServers?: McpServersConfig;
  workspacePolicies?: WorkspaceCapabilityPolicies;
  workspacePolicyProfiles?: WorkspacePolicyProfiles;
  browserTaskModel?: { providerId?: string; model?: string; maxSteps?: number; stepDelayMs?: number } | null;
  disabledTools?: string[];
};

type WorkspaceScaffoldOptions = {
  initGit?: boolean;
  npmPackage?: boolean;
  typescript?: boolean;
};

type ModelListResult = {
  models: string[];
};

type DoctorStatus = "pass" | "warn" | "fail" | "skip";

type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  detail?: string;
};

type DoctorCapabilityObservation = {
  capability: "toolCalling" | "imageInput";
  value: "disabled";
  source: "doctor";
  checkId: string;
  status: DoctorStatus;
  detail?: string;
};

type DoctorReport = {
  generatedAt: string;
  checks: DoctorCheck[];
  summary: Record<DoctorStatus, number>;
  capabilityObservations?: DoctorCapabilityObservation[];
};

type ToolStatus = "enabled" | "approval" | "blocked" | "network" | "privacy";

type ToolSummary = {
  name: string;
  description: string;
  parameters: string[];
  status: ToolStatus;
  statusLabel: string;
  scopeLabels: string[];
  disabled: boolean;
};

type ToolListResult = {
  tools: ToolSummary[];
};

type CapabilityPolicyEffect = "allow" | "prompt" | "deny";

type CapabilityPolicyModeSummary = {
  trustMode: TrustMode;
  effect: CapabilityPolicyEffect;
  label: string;
  reason: string;
  override?: CapabilityPolicyOverrideEffect;
  riskyEffect?: CapabilityPolicyEffect;
  riskyLabel?: string;
  riskyReason?: string;
  riskyOverride?: CapabilityPolicyOverrideEffect;
};

type CapabilityPolicySummary = {
  capability: AgentTaskRunCapability;
  label: string;
  description: string;
  examples: string[];
  risk: string;
  defaultPosture: string;
  modes: CapabilityPolicyModeSummary[];
};

type CapabilityPolicyResult = {
  currentTrustMode: TrustMode;
  source: "built-in" | "workspace";
  workspaceRoot: string;
  workspaceOverrides: WorkspaceCapabilityPolicyOverrides;
  workspaceScopeRules: WorkspaceScopePolicyRules;
  policies: CapabilityPolicySummary[];
};

type SkillSummary = {
  name: string;
  title: string;
  description: string;
  path: string;
};

type SkillListResult = {
  skills: SkillSummary[];
  skillsRoot: string;
};

type SkillCreateInput = {
  name: string;
  description?: string;
  instructions: string;
};

type SkillCreateResult = SkillListResult & {
  skill: SkillSummary;
};

type SessionListResult = {
  sessions: SessionSummary[];
};

type CompactContextResult = {
  state: DesktopState;
  compacted: boolean;
  compactedMessageCount: number;
  remainingMessageCount: number;
};

type ImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  detail?: ImageDetail;
};

type ImagePickerResult = {
  images: ImageAttachment[];
};

type ContextFileAttachment = {
  id: string;
  path: string;
  name: string;
  size: number;
  lineCount: number;
  content: string;
  truncated: boolean;
};

type ContextFilePickerResult = {
  files: ContextFileAttachment[];
};

type LocalImageResult = {
  mimeType: string;
  size: number;
  dataUrl: string;
};

type PromptPayload = {
  content: ChatContent;
  skills?: string[];
  reuseLastUserMessage?: boolean;
  retryFromUserMessageIndex?: number;
  loop?:
    | boolean
    | {
        enabled?: boolean;
        maxIterations?: number;
      };
  plan?:
    | boolean
    | {
        enabled?: boolean;
      };
  worktree?:
    | boolean
    | {
        enabled?: boolean;
        taskRunId?: string;
        replayOfTaskRunId?: string;
        plannedFromTaskRunId?: string;
      };
};

type DesktopApi = {
  getState(): Promise<DesktopState>;
  chooseWorkspace(): Promise<DesktopState>;
  openWorkspace(workspaceRoot: string): Promise<DesktopState>;
  chooseImages(): Promise<ImagePickerResult>;
  readLocalImage(filePath: string): Promise<LocalImageResult>;
  chooseContextFiles(): Promise<ContextFilePickerResult>;
  createWorkspace(options?: WorkspaceScaffoldOptions): Promise<DesktopState>;
  openJustChats(): Promise<DesktopState>;
  selectChatProject(projectRoot: string | null): Promise<DesktopState>;
  forgetMissingProject(projectRoot: string): Promise<DesktopState>;
  listSessions(): Promise<SessionListResult>;
  openSession(id: string): Promise<DesktopState>;
  newChat(): Promise<DesktopState>;
  updateSession(input: { id: string; title?: string; pinned?: boolean }): Promise<DesktopState>;
  deleteSession(id: string): Promise<DesktopState>;
  compactContext(): Promise<CompactContextResult>;
  summarizeContext(): Promise<CompactContextResult>;
  saveConfig(patch: ConfigPatch): Promise<DesktopState>;
  listModels(patch: ConfigPatch): Promise<ModelListResult>;
  runDoctor(patch: ConfigPatch): Promise<DoctorReport>;
  listTools(): Promise<ToolListResult>;
  getApiRequestLog(): Promise<ApiRequestLogEntry[]>;
  clearApiRequestLog(): Promise<boolean>;
  listCapabilityPolicies(): Promise<CapabilityPolicyResult>;
  readWorkspacePolicyBundle(): Promise<WorkspacePolicyBundleResult>;
  listSkills(): Promise<SkillListResult>;
  createSkill(input: SkillCreateInput): Promise<SkillCreateResult>;
  listTaskWorktrees(): Promise<TaskWorktreeInventoryResult>;
  sendPrompt(prompt: PromptPayload | string): Promise<AgentRunResult>;
  stopAgentLoop(sessionId?: string): Promise<DesktopState>;
  stopAgentRun(sessionId?: string): Promise<DesktopState>;
  undoTaskRun(input: { sessionId?: string; taskRunId: string }): Promise<{ state: DesktopState; revertedCount: number }>;
  taskWorktreeAction(input: {
    sessionId?: string;
    taskRunId: string;
    action:
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
    conflictPath?: string;
  }): Promise<DesktopState>;
  taskRunPlanAction(input: {
    sessionId?: string;
    taskRunId: string;
    action: "approve" | "request_revision" | "cancel";
  }): Promise<DesktopState>;
  openTaskRunEvidence(input: {
    sessionId?: string;
    taskRunId: string;
    artifactId: string;
    path: string;
    line?: number;
  }): Promise<{ path: string; line?: number }>;
  getBrowserState(): Promise<BrowserState>;
  setBrowserPaneOpen(open: boolean): Promise<BrowserState>;
  setBrowserDefaultMode(mode: BrowserMode): Promise<BrowserState>;
  setBrowserBounds(bounds: BrowserBounds): Promise<BrowserState>;
  setBrowserVisibleSuppressed(suppressed: boolean): Promise<BrowserState>;
  openBrowserUrl(args: { url: string; mode?: BrowserMode; tabId?: string; newTab?: boolean }): Promise<Record<string, unknown>>;
  browserNewTab(args?: { url?: string }): Promise<BrowserState>;
  browserSelectTab(tabId: string): Promise<BrowserState>;
  browserCloseTab(tabId: string): Promise<BrowserState>;
  browserGoBack(args?: BrowserMode | { mode?: BrowserMode; tabId?: string }): Promise<BrowserState>;
  browserGoForward(args?: BrowserMode | { mode?: BrowserMode; tabId?: string }): Promise<BrowserState>;
  browserReload(args?: BrowserMode | { mode?: BrowserMode; tabId?: string }): Promise<BrowserState>;
  browserStop(args?: BrowserMode | { mode?: BrowserMode; tabId?: string }): Promise<BrowserState>;
  captureBrowserScreenshot(args?: { mode?: BrowserMode; tabId?: string }): Promise<Record<string, unknown>>;
  respondApproval(id: string, approved: boolean): Promise<void>;
  onApprovalRequest(callback: (payload: ApprovalRequest) => void): () => void;
  onAgentEvent(callback: (payload: AgentStreamEvent) => void): () => void;
  onSessionEvent(callback: (payload: SessionLifecycleEvent) => void): () => void;
  onBrowserState(callback: (payload: BrowserState) => void): () => void;
  onApiRequestLog(callback: (entry: ApiRequestLogEntry) => void): () => void;
};

// Mirrors ApiRequestLogEntry in src/agent/OpenAICompatibleChatClient.ts. One model call's redacted
// diagnostics for the API request log panel.
type ApiRequestLogEntry = {
  id: string;
  at: string;
  model: string;
  streamed: boolean;
  status?: number;
  ok: boolean;
  outcome: "ok" | "empty" | "error";
  durationMs: number;
  retries: number;
  toolsOffered: string[];
  toolCalls: string[];
  droppedToolCalls: string[];
  contentChars: number;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  error?: string;
  requestMessages?: Array<{ role: string; content: string; toolCalls?: string[] }>;
  responseBody?: string;
};

interface Window {
  arivu: DesktopApi;
  shankinster: DesktopApi;
}

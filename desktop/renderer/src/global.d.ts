/// <reference types="vite/client" />

type TrustMode = "ask" | "readonly" | "trusted";
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

type AgentLoopState = {
  status: AgentLoopStatus;
  goal: string;
  iteration: number;
  maxIterations: number;
  startedAt: string;
  updatedAt: string;
  stopRequested?: boolean;
  lastDecision?: "continue" | "done" | "blocked";
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
  | "read_repo"
  | "write_workspace"
  | "run_command"
  | "network_fetch"
  | "browser_control"
  | "mcp_call"
  | "unknown";
type WorkspaceCapabilityPolicyOverrides = Partial<Record<WorkspacePolicyCapability, CapabilityPolicyOverrideEffect>>;
type WorkspaceScopePolicyRules = {
  blockedPathPrefixes?: string[];
  allowedNetworkDomains?: string[];
};
type WorkspaceCapabilityPolicy = {
  overrides: WorkspaceCapabilityPolicyOverrides;
  scopeRules: WorkspaceScopePolicyRules;
};
type WorkspaceCapabilityPolicies = Record<string, WorkspaceCapabilityPolicy>;

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

type AgentTaskRunArtifact = {
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
  executionProfile?: "host" | "container" | "sandbox";
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
  }>;
  sourceMessageIndex?: number;
  updatedAt: string;
};

type AgentTaskRunVerification = {
  status: "passed" | "failed" | "unknown";
  summary: string;
  commandCount: number;
  failedCommandCount: number;
  parsedReportCount: number;
  failedReportCount: number;
  passedReportCount: number;
  unknownReportCount: number;
  updatedAt: string;
};

type AgentTaskRunVerificationStatus = AgentTaskRunVerification["status"];

type AgentTaskRun = {
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
    activeProviderId?: string;
    providers: LlmProviderProfile[];
    trustMode: TrustMode;
    apiKeyPresent: boolean;
    tavilyApiKeyPresent: boolean;
    mcpServers: McpServersConfig;
    workspacePolicies: WorkspaceCapabilityPolicies;
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
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  lastError?: string;
  lastScreenshotPath?: string;
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
};

type SessionSummary = {
  id: string;
  title: string;
  pinnedAt?: string;
  cwd: string;
  projectRoot: string | null;
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

type ApprovalRequest = {
  id: string;
  message: string;
};

type ConfigPatch = {
  apiKey?: string;
  tavilyApiKey?: string;
  baseUrl?: string;
  model?: string;
  activeProviderId?: string;
  providers?: LlmProviderPatch[];
  trustMode?: TrustMode;
  mcpServers?: McpServersConfig;
  workspacePolicies?: WorkspaceCapabilityPolicies;
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

type DoctorReport = {
  generatedAt: string;
  checks: DoctorCheck[];
  summary: Record<DoctorStatus, number>;
};

type ToolStatus = "enabled" | "approval" | "blocked" | "network" | "privacy";

type ToolSummary = {
  name: string;
  description: string;
  parameters: string[];
  status: ToolStatus;
  statusLabel: string;
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
  loop?: boolean | {
    enabled?: boolean;
    maxIterations?: number;
  };
  plan?: boolean | {
    enabled?: boolean;
  };
  worktree?: boolean | {
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
  listSessions(): Promise<SessionListResult>;
  openSession(id: string): Promise<DesktopState>;
  newChat(): Promise<DesktopState>;
  updateSession(input: { id: string; title?: string; pinned?: boolean }): Promise<DesktopState>;
  deleteSession(id: string): Promise<DesktopState>;
  compactContext(): Promise<CompactContextResult>;
  saveConfig(patch: ConfigPatch): Promise<DesktopState>;
  listModels(patch: ConfigPatch): Promise<ModelListResult>;
  runDoctor(patch: ConfigPatch): Promise<DoctorReport>;
  listTools(): Promise<ToolListResult>;
  listCapabilityPolicies(): Promise<CapabilityPolicyResult>;
  listSkills(): Promise<SkillListResult>;
  createSkill(input: SkillCreateInput): Promise<SkillCreateResult>;
  listTaskWorktrees(): Promise<TaskWorktreeInventoryResult>;
  sendPrompt(prompt: PromptPayload | string): Promise<AgentRunResult>;
  stopAgentLoop(sessionId?: string): Promise<DesktopState>;
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
};

interface Window {
  arivu: DesktopApi;
  shankinster: DesktopApi;
}

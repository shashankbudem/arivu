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
  };
  sessionId?: string;
  messages: ChatMessage[];
  runningSessionIds: string[];
  modelSelection?: PublicModelSelection;
};

type BrowserTargetState = {
  mode: BrowserMode;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  lastError?: string;
  lastScreenshotPath?: string;
};

type BrowserState = {
  paneOpen: boolean;
  defaultMode: BrowserMode;
  visible: BrowserTargetState;
  background: BrowserTargetState;
};

type SessionSummary = {
  id: string;
  title: string;
  cwd: string;
  projectRoot: string | null;
  model?: string;
  modelMode?: "manual" | "auto";
  selectedModel?: string;
  selectedProviderName?: string;
  modelSelectionReason?: string;
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
  type: "started" | "completed" | "failed";
  sessionId: string;
  messages: ChatMessage[];
  sessions: SessionSummary[];
  runningSessionIds: string[];
  modelSelection?: PublicModelSelection;
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

type PromptPayload = {
  content: ChatContent;
  skills?: string[];
};

type DesktopApi = {
  getState(): Promise<DesktopState>;
  chooseWorkspace(): Promise<DesktopState>;
  chooseImages(): Promise<ImagePickerResult>;
  createWorkspace(options?: WorkspaceScaffoldOptions): Promise<DesktopState>;
  openJustChats(): Promise<DesktopState>;
  selectChatProject(projectRoot: string | null): Promise<DesktopState>;
  listSessions(): Promise<SessionListResult>;
  openSession(id: string): Promise<DesktopState>;
  newChat(): Promise<DesktopState>;
  deleteSession(id: string): Promise<DesktopState>;
  compactContext(): Promise<CompactContextResult>;
  saveConfig(patch: ConfigPatch): Promise<DesktopState>;
  listModels(patch: ConfigPatch): Promise<ModelListResult>;
  runDoctor(patch: ConfigPatch): Promise<DoctorReport>;
  listTools(): Promise<ToolListResult>;
  listSkills(): Promise<SkillListResult>;
  createSkill(input: SkillCreateInput): Promise<SkillCreateResult>;
  sendPrompt(prompt: PromptPayload | string): Promise<AgentRunResult>;
  getBrowserState(): Promise<BrowserState>;
  setBrowserPaneOpen(open: boolean): Promise<BrowserState>;
  setBrowserDefaultMode(mode: BrowserMode): Promise<BrowserState>;
  setBrowserBounds(bounds: BrowserBounds): Promise<BrowserState>;
  setBrowserVisibleSuppressed(suppressed: boolean): Promise<BrowserState>;
  openBrowserUrl(args: { url: string; mode?: BrowserMode }): Promise<Record<string, unknown>>;
  browserGoBack(mode?: BrowserMode): Promise<BrowserState>;
  browserGoForward(mode?: BrowserMode): Promise<BrowserState>;
  browserReload(mode?: BrowserMode): Promise<BrowserState>;
  browserStop(mode?: BrowserMode): Promise<BrowserState>;
  captureBrowserScreenshot(args?: { mode?: BrowserMode }): Promise<Record<string, unknown>>;
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

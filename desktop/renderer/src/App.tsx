import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Cpu,
  FileText,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  Globe,
  Image as ImageIcon,
  Info,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  Moon,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Rows3,
  Save,
  ScanLine,
  Search,
  Scissors,
  Server,
  Settings,
  Shield,
  Sun,
  TerminalSquare,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import { parseApprovalMessage, type ApprovalView, type SideBySideDiff } from "./approvalParsing";
import { estimateTokenCount, truncateTextToTokenBudget } from "./tokenBudget";
import {
  buildReportRemediationPrompt,
  buildTaskRunPullRequestReviewPrompt,
  buildTaskRunReplayFailureReviewPrompt,
  buildTaskRunVerificationRepairPrompt,
  buildTaskRunVerificationReplayPrompt,
  buildTaskRunVerificationRerunPrompt
} from "../../../src/agent/reportRemediation";
import { promptTextWithFileContext } from "../../../src/agent/fileContext";
import {
  buildTaskRunDiffComparison,
  buildTaskRunPlanSourceReview,
  buildTaskRunPullRequestReadiness,
  buildTaskRunReplayOutcomeGroups,
  type AgentTaskRunDiffComparison,
  type AgentTaskRunPlanSourceReview,
  type AgentTaskRunPullRequestReadiness,
  type AgentTaskRunReplayOutcomeGroup
} from "../../../src/agent/taskHistory";
import { buildTaskRunAuditMarkdown } from "../../../src/agent/taskRunAudit";
import { capabilityForToolName } from "../../../src/agent/toolCapabilities";
import arivuLogoUrl from "../../../assets/arivu-logo.svg";

type ViewMode = "chat" | "history" | "settings" | "ui";
type SidebarSectionId = "projects" | "chats";
type ResizeTarget = "sidebar" | "activity";
type ThemeMode = "dark" | "light";
type UiConceptId = "signal" | "lumen" | "graphite";
type SettingsFocus = "skills" | null;
type ProviderFormState = LlmProviderPatch & {
  apiKeyPresent?: boolean;
};

type PullRequestWatch = {
  sessionId: string;
  taskRunId: string;
  startedAt: string;
  lastRefreshedAt?: string;
  lastError?: string;
};

type PullRequestWatchView = {
  active: boolean;
  refreshing: boolean;
  lastRefreshedAt?: string;
  lastError?: string;
};

const AUTO_MODEL_VALUE = "auto";
const STANDALONE_PROJECT_VALUE = "__standalone__";
const COMPOSER_TOKEN_BUDGET = 8_000;
const DEFAULT_AGENT_LOOP_MAX_ITERATIONS = 5;
const MAX_IMAGE_ATTACHMENTS = 6;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CONTEXT_FILE_ATTACHMENTS = 6;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const SUPPORTED_IMAGE_EXTENSIONS: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};
const NEW_PROVIDER_NAME = "New provider";
const SIDEBAR_COLLAPSED_WIDTH = 68;
const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_MIN_WIDTH = 260;
const SIDEBAR_MAX_WIDTH = 460;
const ACTIVITY_COLLAPSED_WIDTH = 46;
const ACTIVITY_DEFAULT_WIDTH = 300;
const ACTIVITY_MIN_WIDTH = 232;
const ACTIVITY_MAX_WIDTH = 340;
const MAX_ACTIVITY_EVIDENCE_LINKS = 8;
const CHAT_OPTIONS_MENU_WIDTH = 150;
const PR_BACKGROUND_REFRESH_INTERVAL_MS = 90_000;
const TRUST_MODE_ORDER: TrustMode[] = ["readonly", "ask", "trusted"];
const WORKSPACE_POLICY_CAPABILITIES: WorkspacePolicyCapability[] = [
  "read_repo",
  "write_workspace",
  "run_command",
  "network_fetch",
  "browser_control",
  "mcp_call",
  "unknown"
];
const CHAT_OPTIONS_MENU_HEIGHT = 106;
const CHAT_OPTIONS_MENU_MARGIN = 8;
const CHAT_OPTIONS_MENU_GAP = 2;
const CONTEXT_COMPACT_RECENT_MESSAGE_COUNT = 8;
const UI_STATE_STORAGE_KEY = "arivu.uiState.v1";
const PROVIDER_PRESETS: LlmProviderPatch[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1"
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "moonshotai/kimi-k2.6"
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1"
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile"
  },
  {
    id: "local",
    name: "Local / Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.1"
  }
];
const DEFAULT_COLLAPSED_SECTIONS: Record<SidebarSectionId, boolean> = {
  projects: false,
  chats: false
};
const UI_CONCEPTS: Array<{
  id: UiConceptId;
  name: string;
  subtitle: string;
  icon: React.ComponentType<{ size?: number }>;
  swatches: string[];
  sampleMetrics: string[];
}> = [
  {
    id: "signal",
    name: "Signal",
    subtitle: "Dark command desk",
    icon: ScanLine,
    swatches: ["#0b0f12", "#19d6b3", "#e8c563", "#dce8ef"],
    sampleMetrics: ["trust", "diff", "shell"]
  },
  {
    id: "lumen",
    name: "Lumen",
    subtitle: "Bright technical lab",
    icon: LayoutDashboard,
    swatches: ["#f7f9fb", "#0f1720", "#208cff", "#f0b43c"],
    sampleMetrics: ["model", "tools", "git"]
  },
  {
    id: "graphite",
    name: "Graphite",
    subtitle: "Quiet glass terminal",
    icon: Rows3,
    swatches: ["#15191f", "#dfe6ec", "#7aa7ff", "#b7e36a"],
    sampleMetrics: ["agent", "files", "run"]
  }
];

type ActivityItem = {
  id: string;
  kind: "call" | "result" | "approval" | "system";
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

type ActivityPolicyDetail = {
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
  summary?: string;
};

type ActivityEvidenceLink = {
  id: string;
  label: string;
  title: string;
  taskRunId: string;
  artifactId: string;
  path: string;
  line?: number;
  kind: "report" | "source";
};

type ActivityGroupStatus = "running" | "done" | "waiting" | "failed";

type ActivityGroup = {
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

type ActivityModel = {
  items: ActivityItem[];
  systemItems: ActivityItem[];
  groups: ActivityGroup[];
  groupsByUserMessageIndex: Map<number, ActivityGroup>;
};

type VisibleMessageEntry = {
  message: ChatMessage;
  messageIndex: number;
  sourceIndexes: number[];
  key: string;
};

type DiffLine = {
  kind: "add" | "delete" | "context" | "meta";
  oldNumber?: number;
  newNumber?: number;
  text: string;
};

type DiffPreview = {
  title: string;
  lines: DiffLine[];
};

type ProjectSummary = {
  projectRoot: string;
  name: string;
  latestSessionId?: string;
  updatedAt?: string;
  pinnedAt?: string;
  chatCount: number;
  sessions: SessionSummary[];
};

type ProjectOption = {
  projectRoot: string;
  name: string;
  updatedAt?: string;
};

type PasteReview = {
  budget: number;
  fullText: string;
  truncatedText: string;
  pastedTokens: number;
  fullPromptTokens: number;
  truncatedPromptTokens: number;
  range: {
    start: number;
    end: number;
  };
};

type PersistedUiState = {
  theme?: ThemeMode;
  uiConcept?: UiConceptId;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  activityCollapsed?: boolean;
  activityWidth?: number;
  collapsedSections?: Partial<Record<SidebarSectionId, boolean>>;
};

type FailedPrompt = {
  messageIndex: number;
  content: ChatContent;
  skillNames: string[];
  planModeEnabled: boolean;
  loopEnabled: boolean;
  worktreeEnabled: boolean;
  worktreeTaskRunId?: string;
  worktreeReplayOfTaskRunId?: string;
  worktreePlannedFromTaskRunId?: string;
};

type SubmitPromptOptions = {
  reuseFailedPrompt?: boolean;
  skillNames?: string[];
  planModeEnabled?: boolean;
  loopEnabled?: boolean;
  worktreeEnabled?: boolean;
  worktreeTaskRunId?: string;
  worktreeReplayOfTaskRunId?: string;
  worktreePlannedFromTaskRunId?: string;
};

type WorktreeContinuation = {
  taskRunId: string;
  branch?: string;
  replayOfTaskRunId?: string;
};

type WorktreePlanSource = {
  taskRunId: string;
};

type DraftPromptOptions = {
  worktreeContinuation?: WorktreeContinuation;
  worktreePlanSource?: WorktreePlanSource;
  status?: string;
  confirmLabel?: string;
};

type TaskWorktreeAction =
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

type TaskRunPlanAction = "approve" | "request_revision" | "cancel";

type TaskWorktreeActionOptions = {
  conflictPath?: string;
};

type SlashCommandId = "compact" | "session" | "tools" | "skills" | "files" | "browser" | "plan" | "loop" | "worktree";

type SlashCommandDefinition = {
  id: SlashCommandId;
  command: string;
  title: string;
  description: string;
  keywords: string[];
};

type SlashCommandEntry = SlashCommandDefinition & {
  detail?: string;
  disabledReason?: string;
};

type CommandOutputRow = {
  label: string;
  value: string;
};

type CommandOutput = {
  title: string;
  subtitle?: string;
  rows: CommandOutputRow[];
};

const SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    id: "compact",
    command: "compact",
    title: "Compact context",
    description: "Summarize older messages locally and keep the recent chat window.",
    keywords: ["context", "summarize", "trim"]
  },
  {
    id: "session",
    command: "session",
    title: "Session details",
    description: "Show chat id, provider, context estimate, message counts, and workspace.",
    keywords: ["details", "status", "chat", "context", "tokens"]
  },
  {
    id: "tools",
    command: "tools",
    title: "Tools list",
    description: "Open the available tools list with statuses and parameters.",
    keywords: ["list", "available", "registry"]
  },
  {
    id: "skills",
    command: "skills",
    title: "Skills",
    description: "Open the local skills selector and load skills into this chat.",
    keywords: ["load", "local", "workflow", "skill"]
  },
  {
    id: "files",
    command: "files",
    title: "File context",
    description: "Attach workspace text files to the next prompt.",
    keywords: ["attach", "context", "file", "code", "mention"]
  },
  {
    id: "browser",
    command: "browser",
    title: "Browser window",
    description: "Open the separate browser window.",
    keywords: ["open", "page", "window", "visible", "dev"]
  },
  {
    id: "plan",
    command: "plan",
    title: "Plan approval",
    description: "Ask for a read-only plan before executing the next prompt.",
    keywords: ["approve", "review", "strategy", "before", "execute"]
  },
  {
    id: "loop",
    command: "loop",
    title: "Agent loop",
    description: "Toggle bounded loop mode for the next prompt.",
    keywords: ["continue", "iterate", "autonomous", "until", "done"]
  },
  {
    id: "worktree",
    command: "worktree",
    title: "Task worktree",
    description: "Run the next prompt in an isolated git worktree.",
    keywords: ["branch", "isolate", "checkout", "git", "sandbox"]
  }
];

export function App() {
  const [state, setState] = useState<DesktopState | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => loadPersistedUiState().theme ?? "dark");
  const [uiConcept, setUiConcept] = useState<UiConceptId>(() => loadPersistedUiState().uiConcept ?? "signal");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  const [fileAttachments, setFileAttachments] = useState<ContextFileAttachment[]>([]);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Starting");
  const [view, setView] = useState<ViewMode>("chat");
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryPrompt, setRetryPrompt] = useState<ChatContent | null>(null);
  const [failedPrompt, setFailedPrompt] = useState<FailedPrompt | null>(null);
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [compactingContext, setCompactingContext] = useState(false);
  const [availableTools, setAvailableTools] = useState<ToolSummary[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SkillSummary[]>([]);
  const [skillsRoot, setSkillsRoot] = useState("");
  const [pendingSkillNames, setPendingSkillNames] = useState<string[]>([]);
  const [agentPlanModeEnabled, setAgentPlanModeEnabled] = useState(false);
  const [agentLoopEnabled, setAgentLoopEnabled] = useState(false);
  const [agentWorktreeEnabled, setAgentWorktreeEnabled] = useState(false);
  const [worktreeContinuation, setWorktreeContinuation] = useState<WorktreeContinuation | null>(null);
  const [worktreePlanSource, setWorktreePlanSource] = useState<WorktreePlanSource | null>(null);
  const [worktreeActionBusy, setWorktreeActionBusy] = useState<string | null>(null);
  const [planReviewBusy, setPlanReviewBusy] = useState<string | null>(null);
  const [evidenceOpenBusy, setEvidenceOpenBusy] = useState<string | null>(null);
  const [watchedPullRequests, setWatchedPullRequests] = useState<Record<string, PullRequestWatch>>({});
  const [pullRequestWatchBusy, setPullRequestWatchBusy] = useState<Record<string, boolean>>({});
  const [focusedActivityRunId, setFocusedActivityRunId] = useState<string | null>(null);
  const [browserState, setBrowserState] = useState<BrowserState | null>(null);
  const [toolsPopoverOpen, setToolsPopoverOpen] = useState(false);
  const [skillsPopoverOpen, setSkillsPopoverOpen] = useState(false);
  const [composerOptionsOpen, setComposerOptionsOpen] = useState(false);
  const [settingsFocus, setSettingsFocus] = useState<SettingsFocus>(null);
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);
  const [commandOutput, setCommandOutput] = useState<CommandOutput | null>(null);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [chatSearchIndex, setChatSearchIndex] = useState(0);
  const [pasteReview, setPasteReview] = useState<PasteReview | null>(null);
  const [workspaceScaffoldOpen, setWorkspaceScaffoldOpen] = useState(false);
  const [openingWorkspaceRoot, setOpeningWorkspaceRoot] = useState<string | null>(null);
  const [openChatMenuId, setOpenChatMenuId] = useState<string | null>(null);
  const [openHistoryMenuId, setOpenHistoryMenuId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => loadPersistedUiState().sidebarCollapsed ?? false);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clamp(loadPersistedUiState().sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
  );
  const [activityCollapsed, setActivityCollapsed] = useState(() => loadPersistedUiState().activityCollapsed ?? true);
  const [activityWidth, setActivityWidth] = useState(() =>
    clamp(loadPersistedUiState().activityWidth ?? ACTIVITY_DEFAULT_WIDTH, ACTIVITY_MIN_WIDTH, ACTIVITY_MAX_WIDTH)
  );
  const [resizing, setResizing] = useState<ResizeTarget | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Record<SidebarSectionId, boolean>>(() => ({
    ...DEFAULT_COLLAPSED_SECTIONS,
    ...loadPersistedUiState().collapsedSections
  }));
  const [expandedProjectRoots, setExpandedProjectRoots] = useState<Record<string, boolean>>({});
  const [rememberedProjectOptions, setRememberedProjectOptions] = useState<Record<string, string>>({});
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const activityListRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const chatSearchInputRef = useRef<HTMLInputElement | null>(null);
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityFocusResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const activeSubmissionTokenRef = useRef<string | null>(null);
  const composerDragDepthRef = useRef(0);
  const pullRequestWatchInFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    void refresh();
    void loadSessions();
    void loadTools();
    void loadSkills();
    void loadBrowserState();
    const stopApprovals = window.arivu.onApprovalRequest((payload) => {
      setApproval(payload);
      setStatus("Approval required");
    });
    const stopAgentEvents = window.arivu.onAgentEvent((payload) => {
      applyAgentStreamEvent(payload);
    });
    const stopSessionEvents = window.arivu.onSessionEvent((payload) => {
      applySessionLifecycleEvent(payload);
    });
    const stopBrowserState = window.arivu.onBrowserState((payload) => {
      applyBrowserState(payload);
    });
    return () => {
      stopApprovals();
      stopAgentEvents();
      stopSessionEvents();
      stopBrowserState();
    };
  }, []);

  useEffect(() => {
    activeSessionIdRef.current = state?.sessionId;
  }, [state?.sessionId]);

  useEffect(() => {
    const sessionId = state?.sessionId;
    setWatchedPullRequests((current) => {
      const entries = Object.entries(current).filter(([, watch]) => {
        if (!sessionId || watch.sessionId !== sessionId) {
          return false;
        }
        if (!state?.taskRuns) {
          return true;
        }
        return state.taskRuns.some((run) => run.id === watch.taskRunId && Boolean(run.worktree?.pullRequest?.url));
      });
      if (entries.length === Object.keys(current).length) {
        return current;
      }
      return Object.fromEntries(entries);
    });
    setPullRequestWatchBusy((current) => {
      const entries = Object.entries(current).filter(([key]) => Boolean(sessionId && key.startsWith(`${sessionId}:`)));
      if (entries.length === Object.keys(current).length) {
        return current;
      }
      return Object.fromEntries(entries);
    });
  }, [state?.sessionId, state?.taskRuns]);

  useEffect(() => {
    const sessionId = state?.sessionId;
    if (!sessionId) {
      return;
    }
    const watches = Object.entries(watchedPullRequests).filter(([, watch]) => watch.sessionId === sessionId);
    if (watches.length === 0) {
      return;
    }
    const timer = window.setInterval(() => {
      for (const [key, watch] of watches) {
        void refreshWatchedPullRequest(key, watch, { silent: true });
      }
    }, PR_BACKGROUND_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [state?.sessionId, watchedPullRequests]);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current) {
        clearTimeout(copyResetTimeoutRef.current);
      }
      if (activityFocusResetTimeoutRef.current) {
        clearTimeout(activityFocusResetTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const list = messageListRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages, busy]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.uiConcept = uiConcept;
  }, [uiConcept]);

  useEffect(() => {
    savePersistedUiState({
      theme,
      uiConcept,
      sidebarCollapsed,
      sidebarWidth,
      activityCollapsed,
      activityWidth,
      collapsedSections
    });
  }, [theme, uiConcept, sidebarCollapsed, sidebarWidth, activityCollapsed, activityWidth, collapsedSections]);

  useEffect(() => {
    const input = promptInputRef.current;
    if (!input) {
      return;
    }
    input.style.height = "0px";
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 56), 180)}px`;
  }, [prompt]);

  useEffect(() => {
    if (!resizing) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (resizing === "sidebar") {
        setSidebarWidth(clamp(event.clientX, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
        return;
      }
      setActivityWidth(clamp(window.innerWidth - event.clientX, ACTIVITY_MIN_WIDTH, ACTIVITY_MAX_WIDTH));
    };

    const handlePointerUp = () => setResizing(null);

    document.body.classList.add("is-resizing");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });

    return () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [resizing]);

  useEffect(() => {
    if (!openChatMenuId && !openHistoryMenuId) {
      return;
    }

    const closeMenus = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".chat-options, .chat-options-menu")) {
        return;
      }
      setOpenChatMenuId(null);
      setOpenHistoryMenuId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenChatMenuId(null);
        setOpenHistoryMenuId(null);
      }
    };

    document.addEventListener("click", closeMenus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", closeMenus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openChatMenuId, openHistoryMenuId]);

  useEffect(() => {
    if (!toolsPopoverOpen && !skillsPopoverOpen && !composerOptionsOpen) {
      return;
    }

    const closePopover = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".composer-tools-region, .composer-skills-region, .composer-menu-region")) {
        return;
      }
      setToolsPopoverOpen(false);
      setSkillsPopoverOpen(false);
      setComposerOptionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setToolsPopoverOpen(false);
        setSkillsPopoverOpen(false);
        setComposerOptionsOpen(false);
      }
    };

    document.addEventListener("click", closePopover);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", closePopover);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [toolsPopoverOpen, skillsPopoverOpen, composerOptionsOpen]);

  const activityModel = useMemo(() => deriveActivityModel(messages, state), [messages, state]);
  const activity = activityModel.items;
  const activityGroups = activityModel.groups.filter((group) => group.items.length > 0 || group.run);
  const activityGroupByUserMessageIndex = activityModel.groupsByUserMessageIndex;
  const latestScreenshotActivity = useMemo(() => findLatestActivityScreenshot(activity), [activity]);
  const lastActivity = activity.at(-1);
  useEffect(() => {
    const list = activityListRef.current;
    if (activityCollapsed || !list) {
      return;
    }
    list.scrollTop = list.scrollHeight;
  }, [
    activityCollapsed,
    activity.length,
    latestScreenshotActivity?.imagePreview?.path,
    lastActivity?.id,
    lastActivity?.status,
    state?.sessionId
  ]);
  const promptTokens = useMemo(() => estimateTokenCount(promptTextWithFileContext(prompt, fileAttachments)), [fileAttachments, prompt]);
  const nonSystemMessageCount = useMemo(() => messages.filter((message) => message.role !== "system").length, [messages]);
  const estimatedContextTokens = useMemo(() => estimateContextTokens(messages), [messages]);
  const loadedSkillNames = useMemo(() => loadedSkillNamesFromMessages(messages), [messages]);
  const availableSkillByName = useMemo(() => new Map(availableSkills.map((skill) => [skill.name, skill])), [availableSkills]);
  const loadedSkills = useMemo(
    () => loadedSkillNames.map((name) => availableSkillByName.get(name) ?? skillSummaryFromName(name)),
    [availableSkillByName, loadedSkillNames]
  );
  const pendingSkills = useMemo(
    () => pendingSkillNames.map((name) => availableSkillByName.get(name) ?? skillSummaryFromName(name)),
    [availableSkillByName, pendingSkillNames]
  );
  const slashQuery = useMemo(() => parseSlashCommandQuery(prompt), [prompt]);
  const slashCommandEntries = useMemo(
    () =>
      buildSlashCommandEntries({
        state,
        busy,
        compactingContext,
        nonSystemMessageCount,
        availableToolCount: availableTools.length,
        availableSkillCount: availableSkills.length,
        pendingSkillCount: pendingSkillNames.length,
        agentPlanModeEnabled,
        agentLoopEnabled,
        agentWorktreeEnabled: agentWorktreeEnabled || Boolean(worktreeContinuation) || Boolean(worktreePlanSource),
        fileAttachmentCount: fileAttachments.length
      }),
    [
      agentPlanModeEnabled,
      agentLoopEnabled,
      agentWorktreeEnabled,
      worktreeContinuation,
      worktreePlanSource,
      availableSkills.length,
      availableTools.length,
      busy,
      compactingContext,
      nonSystemMessageCount,
      pendingSkillNames.length,
      fileAttachments.length,
      state
    ]
  );
  const filteredSlashCommands = useMemo(
    () => (slashQuery === null ? [] : filterSlashCommands(slashCommandEntries, slashQuery)),
    [slashCommandEntries, slashQuery]
  );
  const slashCommandMenuOpen = slashQuery !== null && !busy;
  const visibleMessages = useMemo(
    () => deriveVisibleMessages(messages),
    [messages]
  );
  const chatSearchMatches = useMemo(() => {
    const query = chatSearchQuery.trim().toLowerCase();
    if (!query) {
      return [];
    }
    return visibleMessages
      .map(({ message, key }) => ({
        key,
        text: chatContentToText(message.content).toLowerCase()
      }))
      .filter((entry) => entry.text.includes(query));
  }, [chatSearchQuery, visibleMessages]);
  const activeChatSearchKey = chatSearchMatches[chatSearchIndex]?.key;
  const projects = useMemo(() => deriveProjects(sessions, state), [sessions, state]);
  const projectOptions = useMemo(() => {
    const byRoot = new Map<string, ProjectOption>();

    for (const [projectRoot, name] of Object.entries(rememberedProjectOptions)) {
      byRoot.set(projectRoot, { projectRoot, name });
    }
    for (const project of projects) {
      byRoot.set(project.projectRoot, {
        projectRoot: project.projectRoot,
        name: project.name,
        updatedAt: project.updatedAt
      });
    }
    if (state?.projectRoot) {
      byRoot.set(state.projectRoot, {
        projectRoot: state.projectRoot,
        name: state.workspace.packageName ?? basename(state.workspace.root)
      });
    }

    return Array.from(byRoot.values()).sort((left, right) => {
      if (left.projectRoot === state?.projectRoot) {
        return -1;
      }
      if (right.projectRoot === state?.projectRoot) {
        return 1;
      }
      return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.name.localeCompare(right.name);
    });
  }, [projects, rememberedProjectOptions, state?.projectRoot, state?.workspace.packageName, state?.workspace.root]);

  useEffect(() => {
    const nextProjects = new Map<string, string>();
    for (const project of projects) {
      nextProjects.set(project.projectRoot, project.name);
    }
    if (state?.projectRoot) {
      nextProjects.set(state.projectRoot, state.workspace.packageName ?? basename(state.workspace.root));
    }
    if (nextProjects.size === 0) {
      return;
    }

    setRememberedProjectOptions((current) => {
      let changed = false;
      const merged = { ...current };
      for (const [projectRoot, name] of nextProjects) {
        if (merged[projectRoot] !== name) {
          merged[projectRoot] = name;
          changed = true;
        }
      }
      return changed ? merged : current;
    });
  }, [projects, state?.projectRoot, state?.workspace.packageName, state?.workspace.root]);

  useEffect(() => {
    if (!chatSearchOpen) {
      return;
    }
    requestAnimationFrame(() => chatSearchInputRef.current?.focus());
  }, [chatSearchOpen]);

  useEffect(() => {
    setSelectedSlashCommandIndex(firstEnabledSlashCommandIndex(filteredSlashCommands));
  }, [filteredSlashCommands, slashQuery]);

  useEffect(() => {
    setChatSearchIndex((current) => {
      if (chatSearchMatches.length === 0) {
        return 0;
      }
      return Math.min(current, chatSearchMatches.length - 1);
    });
  }, [chatSearchMatches.length]);

  useEffect(() => {
    if (!activeChatSearchKey || !messageListRef.current) {
      return;
    }
    const target = messageListRef.current.querySelector<HTMLElement>(`[data-message-search-key="${activeChatSearchKey}"]`);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeChatSearchKey]);

  useEffect(() => {
    if (!focusedActivityRunId || activityCollapsed) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      const list = activityListRef.current;
      if (!list) {
        return;
      }
      const target = Array.from(list.querySelectorAll<HTMLElement>("[data-activity-run-id]")).find(
        (element) => element.dataset.activityRunId === focusedActivityRunId
      );
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
    });

    return () => cancelAnimationFrame(frame);
  }, [activityCollapsed, focusedActivityRunId, activityGroups.length]);

  async function refresh() {
    try {
      const next = await window.arivu.getState();
      applyDesktopState(next);
      void loadSessions();
      void loadTools();
      void loadSkills();
      setStatus("Ready");
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    }
  }

  async function chooseWorkspace() {
    setError(null);
    const next = await window.arivu.chooseWorkspace();
    applyDesktopState(next);
    void loadSessions();
    setStatus("Workspace opened");
  }

  async function openWorkspace(projectRoot: string) {
    if (openingWorkspaceRoot) {
      return;
    }

    setOpeningWorkspaceRoot(projectRoot);
    setError(null);
    setOpenChatMenuId(null);
    setOpenHistoryMenuId(null);
    try {
      const next = await window.arivu.openWorkspace(projectRoot);
      applyDesktopState(next);
      void loadSessions();
      setStatus(`Workspace opened: ${basename(projectRoot)}`);
    } catch (err) {
      setError(formatError(err));
      setStatus("Open workspace failed");
    } finally {
      setOpeningWorkspaceRoot((current) => (current === projectRoot ? null : current));
    }
  }

  function createWorkspace() {
    setWorkspaceScaffoldOpen(true);
  }

  async function confirmCreateWorkspace(options: WorkspaceScaffoldOptions) {
    setError(null);
    setWorkspaceScaffoldOpen(false);
    try {
      const next = await window.arivu.createWorkspace(options);
      applyDesktopState(next);
      void loadSessions();
      setStatus("Workspace created");
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    }
  }

  async function startNewChat() {
    setError(null);
    try {
      const next = await window.arivu.newChat();
      applyDesktopState(next);
      setView("chat");
      setStatus("New chat without a project");
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    }
  }

  async function openSession(id: string) {
    try {
      setOpenChatMenuId(null);
      setOpenHistoryMenuId(null);
      const next = await window.arivu.openSession(id);
      applyDesktopState(next);
      setView("chat");
      setError(null);
      setStatus(`Opened session ${next.sessionId ?? ""}`.trim());
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    }
  }

  async function deleteSession(session: SessionSummary) {
    setOpenChatMenuId(null);
    setOpenHistoryMenuId(null);
    const confirmed = window.confirm(`Delete "${session.title}" from chat history? This cannot be undone.`);
    if (!confirmed) {
      return;
    }
    const activeSessionId = state?.sessionId;

    try {
      const next = await window.arivu.deleteSession(session.id);
      applyDesktopState(next);
      await loadSessions();
      if (session.id === activeSessionId) {
        setView("chat");
        setStatus("Deleted current chat");
      } else {
        setStatus("Deleted chat");
      }
      setError(null);
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    }
  }

  async function renameSession(session: SessionSummary) {
    setOpenChatMenuId(null);
    setOpenHistoryMenuId(null);
    const nextTitle = window.prompt("Rename chat", session.title);
    if (nextTitle === null) {
      return;
    }
    const trimmed = nextTitle.trim();
    if (!trimmed) {
      setError("Chat name cannot be empty.");
      setStatus("Rename cancelled");
      return;
    }
    if (trimmed === session.title) {
      return;
    }

    try {
      const next = await window.arivu.updateSession({ id: session.id, title: trimmed });
      applyDesktopState(next);
      await loadSessions();
      setStatus("Renamed chat");
      setError(null);
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    }
  }

  async function toggleSessionPin(session: SessionSummary) {
    setOpenChatMenuId(null);
    setOpenHistoryMenuId(null);
    try {
      const next = await window.arivu.updateSession({ id: session.id, pinned: !session.pinnedAt });
      applyDesktopState(next);
      await loadSessions();
      setStatus(session.pinnedAt ? "Unpinned chat" : "Pinned chat");
      setError(null);
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    }
  }

  async function loadSessions() {
    setLoadingSessions(true);
    try {
      const result = await window.arivu.listSessions();
      setSessions(result.sessions);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoadingSessions(false);
    }
  }

  async function loadTools(): Promise<ToolSummary[] | null> {
    try {
      const result = await window.arivu.listTools();
      setAvailableTools(result.tools);
      return result.tools;
    } catch (err) {
      setError(formatError(err));
      return null;
    }
  }

  async function loadSkills(): Promise<SkillSummary[] | null> {
    try {
      const result = await window.arivu.listSkills();
      setAvailableSkills(result.skills);
      setSkillsRoot(result.skillsRoot);
      return result.skills;
    } catch (err) {
      setError(formatError(err));
      return null;
    }
  }

  async function loadBrowserState() {
    try {
      const next = await window.arivu.getBrowserState();
      applyBrowserState(next);
    } catch (err) {
      setError(formatError(err));
    }
  }

  function applyBrowserState(next: BrowserState) {
    setBrowserState(next);
    setState((current) => (current ? { ...current, browser: next } : current));
  }

  async function setBrowserPaneOpen(open: boolean) {
    try {
      const next = await window.arivu.setBrowserPaneOpen(open);
      applyBrowserState(next);
      setStatus(open ? "Browser window opened" : "Browser window hidden");
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    }
  }

  function openSkillsSettings() {
    setComposerOptionsOpen(false);
    setToolsPopoverOpen(false);
    setSkillsPopoverOpen(false);
    setSettingsFocus("skills");
    setView("settings");
    void loadSkills();
  }

  function loadSkillForNextPrompt(skill: SkillSummary) {
    if (loadedSkillNames.includes(skill.name)) {
      setStatus(`$${skill.name} is already loaded in this chat`);
      requestAnimationFrame(() => promptInputRef.current?.focus());
      return;
    }
    setPendingSkillNames((current) => (current.includes(skill.name) ? current : [...current, skill.name]));
    setError(null);
    setStatus(`Queued $${skill.name}`);
    requestAnimationFrame(() => promptInputRef.current?.focus());
  }

  function removePendingSkill(name: string) {
    setPendingSkillNames((current) => current.filter((skillName) => skillName !== name));
    setStatus(`Removed $${name}`);
    requestAnimationFrame(() => promptInputRef.current?.focus());
  }

  async function chooseImages() {
    if (busy) {
      return;
    }
    try {
      const result = await window.arivu.chooseImages();
      if (result.images.length === 0) {
        return;
      }
      setImageAttachments((current) => mergeImageAttachments(current, result.images));
      setStatus(result.images.length === 1 ? "Attached image" : `Attached ${result.images.length} images`);
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    }
  }

  async function chooseContextFiles() {
    if (busy) {
      return;
    }
    const slots = Math.max(0, MAX_CONTEXT_FILE_ATTACHMENTS - fileAttachments.length);
    if (slots === 0) {
      setError(`You can attach up to ${MAX_CONTEXT_FILE_ATTACHMENTS} files.`);
      setStatus("File context limit reached");
      return;
    }

    try {
      const result = await window.arivu.chooseContextFiles();
      if (result.files.length === 0) {
        return;
      }
      const merged = mergeFileAttachments(fileAttachments, result.files);
      setFileAttachments(merged);
      const addedCount = Math.max(0, merged.length - fileAttachments.length);
      if (addedCount > 0) {
        setStatus(addedCount === 1 ? "Attached file context" : `Attached ${addedCount} files`);
      } else {
        setStatus("File context updated");
      }
      setError(null);
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    }
  }

  async function attachImageFiles(files: File[], source: "pasted" | "selected" | "dropped") {
    if (busy) {
      setStatus("Wait for current response before attaching images");
      return;
    }
    const slots = Math.max(0, MAX_IMAGE_ATTACHMENTS - imageAttachments.length);
    if (slots === 0) {
      setError(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`);
      setStatus("Image limit reached");
      return;
    }

    try {
      const images = await Promise.all(files.slice(0, slots).map(fileToImageAttachment));
      setImageAttachments((current) => mergeImageAttachments(current, images));
      setStatus(images.length === 1 ? `${capitalize(source)} image attached` : `${capitalize(source)} ${images.length} images`);
      setError(null);
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    }
  }

  function resetComposerDragState() {
    composerDragDepthRef.current = 0;
    setComposerDragActive(false);
  }

  function handleComposerDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasFileTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    if (!hasPotentialImageTransfer(event.dataTransfer)) {
      resetComposerDragState();
      return;
    }
    composerDragDepthRef.current += 1;
    setComposerDragActive(true);
  }

  function handleComposerDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasFileTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    if (!hasPotentialImageTransfer(event.dataTransfer)) {
      event.dataTransfer.dropEffect = "none";
      resetComposerDragState();
      return;
    }
    event.dataTransfer.dropEffect = busy ? "none" : "copy";
    setComposerDragActive(true);
  }

  function handleComposerDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!composerDragActive) {
      return;
    }
    event.preventDefault();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current === 0) {
      setComposerDragActive(false);
    }
  }

  function handleComposerDrop(event: ReactDragEvent<HTMLDivElement>) {
    const files = imageFilesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) {
      if (hasFileTransfer(event.dataTransfer)) {
        event.preventDefault();
        setError("Drop PNG, JPEG, WebP, or GIF images.");
        setStatus("Unsupported image drop");
      }
      resetComposerDragState();
      return;
    }

    event.preventDefault();
    resetComposerDragState();
    void attachImageFiles(files, "dropped");
  }

  function removeImageAttachment(id: string) {
    setImageAttachments((current) => current.filter((image) => image.id !== id));
  }

  function removeFileAttachment(id: string) {
    setFileAttachments((current) => current.filter((file) => file.id !== id));
  }

  async function selectChatProject(projectRoot: string | null) {
    try {
      setError(null);
      const next = await window.arivu.selectChatProject(projectRoot);
      applyDesktopState(next);
      setStatus(projectRoot ? `Project selected: ${basename(projectRoot)}` : "No project selected");
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    }
  }

  async function compactContext(): Promise<boolean> {
    if (busy || compactingContext || !state?.sessionId) {
      return false;
    }

    const confirmed = window.confirm(
      `Compact this chat's context? Older messages will be summarized locally and the most recent ${CONTEXT_COMPACT_RECENT_MESSAGE_COUNT} messages will remain. This cannot be undone.`
    );
    if (!confirmed) {
      return false;
    }

    setCompactingContext(true);
    setError(null);
    try {
      const result = await window.arivu.compactContext();
      applyDesktopState(result.state);
      await loadSessions();
      setStatus(
        result.compacted
          ? `Compacted ${formatNumber(result.compactedMessageCount)} older messages`
          : "Context already compact"
      );
      return true;
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
      return false;
    } finally {
      setCompactingContext(false);
    }
  }

  async function handleTaskWorktreeAction(run: AgentTaskRun, action: TaskWorktreeAction, options: TaskWorktreeActionOptions = {}) {
    if (!state?.sessionId) {
      return;
    }
    if (action === "create_pr" && !confirmCreatePullRequest(run.worktree?.pullRequest)) {
      return;
    }

    const busyKey = `${run.id}:${action}`;
    setWorktreeActionBusy(busyKey);
    setError(null);
    try {
      const next = await window.arivu.taskWorktreeAction({
        sessionId: state.sessionId,
        taskRunId: run.id,
        action,
        ...options
      });
      applyDesktopStateSnapshot(next);
      await loadSessions();
      setStatus(taskWorktreeActionStatus(action));
    } catch (err) {
      setError(formatError(err));
      setStatus("Task worktree action failed");
    } finally {
      setWorktreeActionBusy((current) => (current === busyKey ? null : current));
    }
  }

  async function refreshWatchedPullRequest(
    key: string,
    watch: PullRequestWatch,
    options: { silent?: boolean } = {}
  ) {
    if (pullRequestWatchInFlightRef.current.has(key)) {
      return;
    }
    pullRequestWatchInFlightRef.current.add(key);
    setPullRequestWatchBusy((current) => ({ ...current, [key]: true }));
    if (!options.silent) {
      setError(null);
      setStatus("Refreshing watched PR");
    }
    try {
      const next = await window.arivu.taskWorktreeAction({
        sessionId: watch.sessionId,
        taskRunId: watch.taskRunId,
        action: "refresh_pr"
      });
      if (activeSessionIdRef.current === watch.sessionId) {
        applyDesktopStateSnapshot(next);
      }
      await loadSessions();
      const lastRefreshedAt = new Date().toISOString();
      setWatchedPullRequests((current) => {
        if (!current[key]) {
          return current;
        }
        return {
          ...current,
          [key]: {
            ...current[key],
            lastRefreshedAt,
            lastError: undefined
          }
        };
      });
      if (!options.silent) {
        setStatus("Watching PR in background");
      }
    } catch (err) {
      const message = formatError(err);
      setWatchedPullRequests((current) => {
        if (!current[key]) {
          return current;
        }
        return {
          ...current,
          [key]: {
            ...current[key],
            lastError: message
          }
        };
      });
      if (!options.silent) {
        setError(message);
        setStatus("PR watch refresh failed");
      }
    } finally {
      pullRequestWatchInFlightRef.current.delete(key);
      setPullRequestWatchBusy((current) => {
        if (!current[key]) {
          return current;
        }
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }

  function handleTogglePullRequestWatch(run: AgentTaskRun) {
    if (!state?.sessionId) {
      return;
    }
    if (!run.worktree?.pullRequest?.url) {
      setStatus("Create the PR before watching it");
      return;
    }
    const key = pullRequestWatchKey(state.sessionId, run.id);
    if (watchedPullRequests[key]) {
      setWatchedPullRequests((current) => {
        if (!current[key]) {
          return current;
        }
        const next = { ...current };
        delete next[key];
        return next;
      });
      setStatus("Stopped watching PR");
      return;
    }

    const watch: PullRequestWatch = {
      sessionId: state.sessionId,
      taskRunId: run.id,
      startedAt: new Date().toISOString()
    };
    setWatchedPullRequests((current) => ({ ...current, [key]: watch }));
    setStatus("Watching PR in background");
    void refreshWatchedPullRequest(key, watch);
  }

  async function handleTaskRunPlanAction(run: AgentTaskRun, action: TaskRunPlanAction) {
    if (!state?.sessionId) {
      return;
    }

    const busyKey = `${run.id}:${action}`;
    setPlanReviewBusy(busyKey);
    setError(null);
    try {
      const next = await window.arivu.taskRunPlanAction({
        sessionId: state.sessionId,
        taskRunId: run.id,
        action
      });
      applyDesktopStateSnapshot(next);
      await loadSessions();
      setStatus(taskRunPlanActionStatus(action));
    } catch (err) {
      setError(formatError(err));
      setStatus("Plan review action failed");
    } finally {
      setPlanReviewBusy((current) => (current === busyKey ? null : current));
    }
  }

  function handleFocusTaskRunAttempt(run: AgentTaskRun) {
    setView("chat");
    setActivityCollapsed(false);
    setFocusedActivityRunId(run.id);
    setStatus(
      run.worktree?.replayOfTaskRunId
        ? "Showing replay attempt details"
        : run.worktree?.continuedFromTaskRunId
          ? "Showing repair attempt details"
          : "Showing original attempt details"
    );

    if (activityFocusResetTimeoutRef.current) {
      clearTimeout(activityFocusResetTimeoutRef.current);
    }
    activityFocusResetTimeoutRef.current = setTimeout(() => {
      setFocusedActivityRunId((current) => (current === run.id ? null : current));
    }, 3500);
  }

  async function handleOpenEvidence(link: ActivityEvidenceLink) {
    if (!state?.sessionId) {
      return;
    }

    setEvidenceOpenBusy(link.id);
    setError(null);
    try {
      const result = await window.arivu.openTaskRunEvidence({
        sessionId: state.sessionId,
        taskRunId: link.taskRunId,
        artifactId: link.artifactId,
        path: link.path,
        line: link.line
      });
      setStatus(link.line ? `Opened ${basename(result.path)}:${link.line}` : `Opened ${basename(result.path)}`);
    } catch (err) {
      setError(formatError(err));
      setStatus("Open evidence failed");
    } finally {
      setEvidenceOpenBusy((current) => (current === link.id ? null : current));
    }
  }

  function handleDraftRemediationPrompt(draftText: string, options: DraftPromptOptions = {}) {
    if (prompt.trim() || imageAttachments.length > 0 || fileAttachments.length > 0) {
      const confirmed = window.confirm(options.confirmLabel ?? "Replace the current composer draft with a repair prompt from this report evidence?");
      if (!confirmed) {
        return;
      }
    }

    setPrompt(draftText);
    setImageAttachments([]);
    setFileAttachments([]);
    if (options.worktreeContinuation) {
      setWorktreeContinuation(options.worktreeContinuation);
      setWorktreePlanSource(null);
      setAgentWorktreeEnabled(false);
      setAgentPlanModeEnabled(false);
      setAgentLoopEnabled(false);
    } else if (options.worktreePlanSource) {
      setWorktreePlanSource(options.worktreePlanSource);
      setWorktreeContinuation(null);
      setAgentWorktreeEnabled(false);
      setAgentPlanModeEnabled(false);
      setAgentLoopEnabled(false);
    } else {
      setWorktreeContinuation(null);
      setWorktreePlanSource(null);
    }
    setError(null);
    setStatus(options.status ?? "Drafted repair prompt from report evidence");
    setView("chat");
    requestAnimationFrame(() => {
      const input = promptInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      const end = draftText.length;
      input.setSelectionRange(end, end);
    });
  }

  function applyDesktopState(next: DesktopState) {
    activeSubmissionTokenRef.current = null;
    applyDesktopStateSnapshot(next);
    setRetryPrompt(null);
    setFailedPrompt(null);
    setImageAttachments([]);
    setFileAttachments([]);
    setPendingSkillNames([]);
    setCommandOutput(null);
  }

  function applyDesktopStateSnapshot(next: DesktopState) {
    setState(next);
    setMessages(next.messages);
    setBusy(isSessionRunning(next, next.sessionId));
    setBrowserState(next.browser);
  }

  function handleModelSaved(next: DesktopState) {
    applyDesktopState(next);
    setError(null);
    setStatus(`Model switched to ${modelDisplayName(next.config.model)}`);
  }

  function handleModelError(message: string) {
    setError(message);
    setStatus("Error");
  }

  function moveChatSearch(direction: 1 | -1) {
    if (chatSearchMatches.length === 0) {
      return;
    }
    setChatSearchIndex((current) => (current + direction + chatSearchMatches.length) % chatSearchMatches.length);
  }

  function applyAgentStreamEvent(event: AgentStreamEvent) {
    if (event.sessionId && event.sessionId !== activeSessionIdRef.current) {
      return;
    }
    setMessages((current) => applyStreamEventToMessages(current, event));
  }

  function applySessionLifecycleEvent(event: SessionLifecycleEvent) {
    const activeSessionId = activeSessionIdRef.current;
    setSessions(event.sessions);
    setBusy(Boolean(activeSessionId && event.runningSessionIds.includes(activeSessionId)));
    setState((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        runningSessionIds: event.runningSessionIds,
        ...(current.sessionId === event.sessionId
          ? { messages: event.messages, modelSelection: event.modelSelection, agentLoop: event.agentLoop, taskRuns: event.taskRuns }
          : {})
      };
    });

    if (activeSessionId === event.sessionId) {
      setMessages(event.messages);
      if (event.type === "completed") {
        setError(null);
        setRetryPrompt(null);
        setFailedPrompt(null);
        setStatus(agentLoopStatusFromEvent(event) ?? modelSelectionStatus(event.modelSelection) ?? `Saved session ${event.sessionId}`);
      } else if (event.type === "failed") {
        const lastUserMessage = findLastUserMessage(event.messages);
        setError(event.error ?? "Agent run failed.");
        setRetryPrompt(lastUserMessage?.content ?? null);
        setFailedPrompt(
          lastUserMessage
            ? {
                messageIndex: lastUserMessage.index,
                content: lastUserMessage.content,
                skillNames: [],
                planModeEnabled: Boolean(event.taskRuns?.at(-1)?.planMode?.enabled),
                loopEnabled: Boolean(event.agentLoop),
                worktreeEnabled: Boolean(event.taskRuns?.at(-1)?.worktree?.enabled)
              }
            : null
        );
        setStatus("Error");
      } else {
        setStatus(agentLoopStatusFromEvent(event) ?? modelSelectionStatus(event.modelSelection) ?? "Running agent");
      }
      return;
    }

    if (event.type === "completed") {
      setStatus(event.agentLoop ? `Background ${agentLoopStatusLabel(event.agentLoop).toLowerCase()}` : "Background chat saved");
    } else if (event.type === "failed") {
      setStatus("Background chat failed");
    }
  }

  function handlePromptChange(value: string) {
    setPrompt(value);
    if (value.startsWith("/")) {
      setComposerOptionsOpen(false);
      setToolsPopoverOpen(false);
      setSkillsPopoverOpen(false);
    }
    if (value.trim()) {
      setCommandOutput(null);
    }
  }

  function handleComposerSubmit() {
    if (slashQuery !== null) {
      const selectedCommand = filteredSlashCommands[selectedSlashCommandIndex];
      if (selectedCommand) {
        void executeSlashCommand(selectedCommand);
        return;
      }
      setError(`No slash command matches "${prompt.trim()}".`);
      setStatus("Unknown slash command");
      return;
    }
    void submitPrompt();
  }

  function handlePromptKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (slashCommandMenuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedSlashCommandIndex((current) => nextEnabledSlashCommandIndex(filteredSlashCommands, current, 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedSlashCommandIndex((current) => nextEnabledSlashCommandIndex(filteredSlashCommands, current, -1));
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        const selectedCommand = filteredSlashCommands[selectedSlashCommandIndex];
        if (selectedCommand) {
          void executeSlashCommand(selectedCommand);
        } else {
          setError(`No slash command matches "${prompt.trim()}".`);
          setStatus("Unknown slash command");
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPrompt("");
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      handleComposerSubmit();
    }
  }

  async function executeSlashCommand(command: SlashCommandEntry) {
    if (command.disabledReason) {
      setStatus(command.disabledReason);
      return;
    }

    setError(null);
    setComposerOptionsOpen(false);
    setToolsPopoverOpen(false);
    setSkillsPopoverOpen(false);
    setCommandOutput(null);

    if (command.id === "compact") {
      const compacted = await compactContext();
      if (compacted) {
        setPrompt("");
      }
      requestAnimationFrame(() => promptInputRef.current?.focus());
      return;
    }

    if (command.id === "loop") {
      setAgentPlanModeEnabled(false);
      setWorktreePlanSource(null);
      setAgentLoopEnabled((current) => {
        const next = !current;
        setStatus(next ? `Agent loop armed for ${DEFAULT_AGENT_LOOP_MAX_ITERATIONS} iterations` : "Agent loop off");
        return next;
      });
      setPrompt("");
      requestAnimationFrame(() => promptInputRef.current?.focus());
      return;
    }

    if (command.id === "plan") {
      setWorktreeContinuation(null);
      setWorktreePlanSource(null);
      setAgentLoopEnabled(false);
      setAgentWorktreeEnabled(false);
      setAgentPlanModeEnabled((current) => {
        const next = !current;
        setStatus(next ? "Plan approval armed for the next prompt" : "Plan approval off");
        return next;
      });
      setPrompt("");
      requestAnimationFrame(() => promptInputRef.current?.focus());
      return;
    }

    if (command.id === "worktree") {
      setAgentPlanModeEnabled(false);
      setWorktreeContinuation(null);
      setWorktreePlanSource(null);
      setAgentWorktreeEnabled((current) => {
        const next = !current;
        setStatus(next ? "Task worktree armed for the next prompt" : "Task worktree off");
        return next;
      });
      setPrompt("");
      requestAnimationFrame(() => promptInputRef.current?.focus());
      return;
    }

    setPrompt("");

    if (command.id === "session") {
      if (!state) {
        return;
      }
      setCommandOutput(
        buildSessionCommandOutput({
          state,
          messages,
          estimatedContextTokens,
          availableToolCount: availableTools.length,
          imageAttachmentCount: imageAttachments.length,
          fileAttachmentCount: fileAttachments.length
        })
      );
      setStatus("Session details ready");
      requestAnimationFrame(() => promptInputRef.current?.focus());
      return;
    }

    if (command.id === "skills") {
      const skills = await loadSkills();
      setSkillsPopoverOpen(true);
      setToolsPopoverOpen(false);
      setStatus(`Showing ${formatNumber((skills ?? availableSkills).length)} skills`);
      requestAnimationFrame(() => promptInputRef.current?.focus());
      return;
    }

    if (command.id === "files") {
      await chooseContextFiles();
      requestAnimationFrame(() => promptInputRef.current?.focus());
      return;
    }

    if (command.id === "browser") {
      await setBrowserPaneOpen(true);
      setToolsPopoverOpen(false);
      setSkillsPopoverOpen(false);
      requestAnimationFrame(() => promptInputRef.current?.focus());
      return;
    }

    const tools = await loadTools();
    setToolsPopoverOpen(true);
    setSkillsPopoverOpen(false);
    setStatus(`Showing ${formatNumber((tools ?? availableTools).length)} tools`);
    requestAnimationFrame(() => promptInputRef.current?.focus());
  }

  async function submitPrompt(content?: ChatContent, options: SubmitPromptOptions = {}) {
    const usingComposer = content === undefined;
    const nextContent = content ?? createPromptContent(prompt, imageAttachments, fileAttachments);
    const nextSkillNames = usingComposer ? pendingSkillNames : options.skillNames ?? [];
    const nextPlanModeEnabled = options.planModeEnabled ?? (usingComposer ? agentPlanModeEnabled : false);
    const nextLoopEnabled = nextPlanModeEnabled ? false : options.loopEnabled ?? (usingComposer ? agentLoopEnabled : false);
    const nextWorktreeTaskRunId = options.worktreeTaskRunId ?? (usingComposer ? worktreeContinuation?.taskRunId : undefined);
    const nextWorktreeReplayOfTaskRunId =
      options.worktreeReplayOfTaskRunId ?? (usingComposer ? worktreeContinuation?.replayOfTaskRunId : undefined);
    const nextWorktreePlannedFromTaskRunId =
      options.worktreePlannedFromTaskRunId ?? (usingComposer ? worktreePlanSource?.taskRunId : undefined);
    const nextWorktreeEnabled = nextPlanModeEnabled
      ? false
      : options.worktreeEnabled ??
        (usingComposer ? agentWorktreeEnabled || Boolean(nextWorktreeTaskRunId) || Boolean(nextWorktreePlannedFromTaskRunId) : false);
    if (!chatContentHasRenderableContent(nextContent) || busy) {
      return;
    }

    const canReuseFailedPrompt =
      options.reuseFailedPrompt === true &&
      failedPrompt !== null &&
      chatContentEquals(failedPrompt.content, nextContent) &&
      messages[failedPrompt.messageIndex]?.role === "user" &&
      chatContentEquals(messages[failedPrompt.messageIndex]?.content ?? "", nextContent);

    if (usingComposer) {
      setPrompt("");
      setImageAttachments([]);
      setFileAttachments([]);
      setAgentPlanModeEnabled(false);
      setAgentLoopEnabled(false);
      setAgentWorktreeEnabled(false);
      setWorktreeContinuation(null);
      setWorktreePlanSource(null);
    }
    setToolsPopoverOpen(false);
    setCommandOutput(null);
    setBusy(true);
    setStatus("Running agent");
    setError(null);
    setRetryPrompt(null);
    setFailedPrompt(null);
    const submissionToken = randomId();
    activeSubmissionTokenRef.current = submissionToken;
    const messagesBeforeRun = messages;
    const failedMessageIndex = canReuseFailedPrompt ? failedPrompt.messageIndex : messagesBeforeRun.length;
    if (!canReuseFailedPrompt) {
      setMessages((current) => [...current, { role: "user", content: nextContent }]);
    }

    try {
      const result = await window.arivu.sendPrompt({
        content: nextContent,
        skills: nextSkillNames,
        reuseLastUserMessage: canReuseFailedPrompt,
        loop: nextLoopEnabled
          ? {
              enabled: true,
              maxIterations: DEFAULT_AGENT_LOOP_MAX_ITERATIONS
            }
          : undefined,
        plan: nextPlanModeEnabled
          ? {
              enabled: true
            }
          : undefined,
        worktree: nextWorktreeEnabled
          ? {
              enabled: true,
              taskRunId: nextWorktreeTaskRunId,
              replayOfTaskRunId: nextWorktreeReplayOfTaskRunId,
              plannedFromTaskRunId: nextWorktreePlannedFromTaskRunId
            }
          : undefined
      });
      const stillViewingSubmittedChat = activeSubmissionTokenRef.current === submissionToken;
      if (stillViewingSubmittedChat) {
        activeSubmissionTokenRef.current = null;
        activeSessionIdRef.current = result.sessionId;
        setMessages(result.messages);
        setState((current) =>
          current
            ? {
                ...current,
                sessionId: result.sessionId,
                messages: result.messages,
                modelSelection: result.modelSelection,
                agentLoop: result.agentLoop,
                taskRuns: result.taskRuns,
                runningSessionIds: result.running
                  ? Array.from(new Set([...current.runningSessionIds, result.sessionId]))
                  : current.runningSessionIds.filter((id) => id !== result.sessionId)
              }
            : current
        );
        setBusy(Boolean(result.running));
        setStatus(modelSelectionStatus(result.modelSelection) ?? (result.running ? "Running agent" : `Saved session ${result.sessionId}`));
      }
      if (nextSkillNames.length > 0) {
        setPendingSkillNames((current) => current.filter((name) => !nextSkillNames.includes(name)));
      }
      void loadSessions();
    } catch (err) {
      if (activeSubmissionTokenRef.current === submissionToken) {
        activeSubmissionTokenRef.current = null;
        setMessages(canReuseFailedPrompt ? messagesBeforeRun : [...messagesBeforeRun, { role: "user", content: nextContent }]);
        if (usingComposer && nextLoopEnabled) {
          setAgentLoopEnabled(true);
        }
        if (usingComposer && nextPlanModeEnabled) {
          setAgentPlanModeEnabled(true);
        }
        if (usingComposer && nextWorktreeEnabled) {
          if (nextWorktreeTaskRunId) {
            setWorktreeContinuation({ taskRunId: nextWorktreeTaskRunId, replayOfTaskRunId: nextWorktreeReplayOfTaskRunId });
            setWorktreePlanSource(null);
          } else if (nextWorktreePlannedFromTaskRunId) {
            setWorktreePlanSource({ taskRunId: nextWorktreePlannedFromTaskRunId });
            setAgentWorktreeEnabled(false);
          } else {
            setAgentWorktreeEnabled(true);
            setWorktreePlanSource(null);
          }
        }
        setBusy(false);
        setError(formatError(err));
        setRetryPrompt(nextContent);
        setFailedPrompt({
          messageIndex: failedMessageIndex,
          content: nextContent,
          skillNames: nextSkillNames,
          planModeEnabled: nextPlanModeEnabled,
          loopEnabled: nextLoopEnabled,
          worktreeEnabled: nextWorktreeEnabled,
          worktreeTaskRunId: nextWorktreeTaskRunId,
          worktreeReplayOfTaskRunId: nextWorktreeReplayOfTaskRunId,
          worktreePlannedFromTaskRunId: nextWorktreePlannedFromTaskRunId
        });
        setStatus("Error");
      }
    }
  }

  function retryLastPrompt() {
    if (!retryPrompt || busy) {
      return;
    }
    void submitPrompt(retryPrompt, {
      reuseFailedPrompt: canReuseFailedPrompt(retryPrompt),
      skillNames: failedPrompt?.skillNames ?? [],
      planModeEnabled: failedPrompt?.planModeEnabled ?? false,
      loopEnabled: failedPrompt?.loopEnabled ?? false,
      worktreeEnabled: failedPrompt?.worktreeEnabled ?? false,
      worktreeTaskRunId: failedPrompt?.worktreeTaskRunId,
      worktreeReplayOfTaskRunId: failedPrompt?.worktreeReplayOfTaskRunId,
      worktreePlannedFromTaskRunId: failedPrompt?.worktreePlannedFromTaskRunId
    });
  }

  function canReuseFailedPrompt(value: ChatContent) {
    return (
      failedPrompt !== null &&
      chatContentEquals(failedPrompt.content, value) &&
      messages[failedPrompt.messageIndex]?.role === "user" &&
      chatContentEquals(messages[failedPrompt.messageIndex]?.content ?? "", value)
    );
  }

  function retryPromptForAssistant(index: number) {
    const message = visibleMessages[index]?.message;
    if (message?.role !== "assistant") {
      return null;
    }

    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const previous = visibleMessages[cursor]?.message;
      if (previous?.role === "user") {
        return previous.content;
      }
    }
    return null;
  }

  async function stopAgentLoop() {
    if (!state?.sessionId || !agentLoopRunning) {
      return;
    }
    try {
      const next = await window.arivu.stopAgentLoop(state.sessionId);
      applyDesktopState(next);
      setStatus("Stopping agent loop");
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    }
  }

  async function copyMessageContent(content: ChatContent, messageKey: string) {
    try {
      await writeClipboardText(chatContentToText(content));
      setCopiedMessageKey(messageKey);
      setStatus("Copied message");
      if (copyResetTimeoutRef.current) {
        clearTimeout(copyResetTimeoutRef.current);
      }
      copyResetTimeoutRef.current = setTimeout(() => {
        setCopiedMessageKey(null);
        copyResetTimeoutRef.current = null;
      }, 1400);
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    }
  }

  function editPromptContent(content: ChatContent) {
    setPrompt(chatContentTextOnly(content));
    setImageAttachments(imageAttachmentsFromContent(content));
    setFileAttachments([]);
    setToolsPopoverOpen(false);
    setError(null);
    setStatus("Editing query");
    requestAnimationFrame(() => {
      promptInputRef.current?.focus();
      const end = chatContentTextOnly(content).length;
      promptInputRef.current?.setSelectionRange(end, end);
    });
  }

  function handlePromptPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const imageFiles = imageFilesFromClipboard(event.clipboardData);
    if (imageFiles.length > 0) {
      event.preventDefault();
      void attachImageFiles(imageFiles, "pasted");
      return;
    }

    const text = event.clipboardData.getData("text");
    if (!text.trim()) {
      return;
    }

    const target = event.currentTarget;
    const start = target.selectionStart ?? prompt.length;
    const end = target.selectionEnd ?? start;
    const promptWithoutSelection = `${prompt.slice(0, start)}${prompt.slice(end)}`;
    const fullPrompt = `${prompt.slice(0, start)}${text}${prompt.slice(end)}`;
    const fullPromptTokens = estimateTokenCount(fullPrompt);

    if (fullPromptTokens <= COMPOSER_TOKEN_BUDGET) {
      return;
    }

    event.preventDefault();
    const remainingTokens = Math.max(0, COMPOSER_TOKEN_BUDGET - estimateTokenCount(promptWithoutSelection));
    const truncated = truncateTextToTokenBudget(text, remainingTokens);
    const truncatedPrompt = `${prompt.slice(0, start)}${truncated.text}${prompt.slice(end)}`;
    setPasteReview({
      budget: COMPOSER_TOKEN_BUDGET,
      fullText: text,
      truncatedText: truncated.text,
      pastedTokens: estimateTokenCount(text),
      fullPromptTokens,
      truncatedPromptTokens: estimateTokenCount(truncatedPrompt),
      range: { start, end }
    });
    setStatus("Large paste detected");
  }

  function insertPaste(text: string, range: PasteReview["range"]) {
    setPrompt((current) => {
      const start = Math.min(range.start, current.length);
      const end = Math.min(Math.max(range.end, start), current.length);
      return `${current.slice(0, start)}${text}${current.slice(end)}`;
    });
  }

  function acceptReviewedPaste(mode: "truncated" | "full") {
    if (!pasteReview) {
      return;
    }
    insertPaste(mode === "truncated" ? pasteReview.truncatedText : pasteReview.fullText, pasteReview.range);
    setStatus(mode === "truncated" ? "Inserted truncated paste" : "Inserted full paste");
    setPasteReview(null);
  }

  function toggleSidebarSection(section: SidebarSectionId) {
    setCollapsedSections((current) => ({ ...current, [section]: !current[section] }));
  }

  function toggleProject(projectRoot: string) {
    setExpandedProjectRoots((current) => ({ ...current, [projectRoot]: !(current[projectRoot] ?? projectRoot === state?.projectRoot) }));
  }

  async function respondApproval(approved: boolean) {
    if (!approval) {
      return;
    }
    await window.arivu.respondApproval(approval.id, approved);
    setApproval(null);
    setStatus(approved ? "Approved" : "Denied");
  }

  if (!state) {
    return (
      <main className="boot">
        <img className="boot-mark" src={arivuLogoUrl} alt="" />
        <div>
          <h1>Arivu</h1>
          <p>{status}</p>
        </div>
      </main>
    );
  }

  const workspaceName = state.projectRoot === null ? "No project selected" : state.workspace.packageName ?? basename(state.workspace.root);
  const workspaceDetail = state.projectRoot === null ? "Standalone chats" : state.workspace.root;
  const gitValue = state.projectRoot === null ? "none" : `${state.workspace.gitBranch ?? "none"}${state.workspace.dirty ? " *" : ""}`;
  const recentProjects = projects.slice(0, 5);
  const standaloneSessions = sessions.filter((session) => session.projectRoot === null).sort(compareSessionsForDisplay).slice(0, 5);
  const chatStarted = Boolean(state.sessionId) || messages.some((message) => message.role !== "system");
  const canSelectChatProject = !chatStarted && !busy;
  const canCompactContext =
    Boolean(state.sessionId) &&
    nonSystemMessageCount > CONTEXT_COMPACT_RECENT_MESSAGE_COUNT &&
    !busy &&
    !compactingContext;
  const effectiveSidebarWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth;
  const toolActivityCount = activity.filter((item) => item.kind !== "system").length;
  const effectiveActivityWidth = activityCollapsed ? ACTIVITY_COLLAPSED_WIDTH : clamp(activityWidth, ACTIVITY_MIN_WIDTH, ACTIVITY_MAX_WIDTH);
  const browserOpen = Boolean(browserState?.paneOpen);
  const activeAgentLoop = state.agentLoop;
  const agentLoopRunning = Boolean(activeAgentLoop && ["running", "stopping"].includes(activeAgentLoop.status));
  const agentLoopLabel = activeAgentLoop ? agentLoopStatusLabel(activeAgentLoop) : "Loop off";
  const workspaceGridClassName = [
    "workspace-grid",
    activityCollapsed ? "activity-collapsed" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main
      className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}
      style={{ "--sidebar-width": `${effectiveSidebarWidth}px` } as React.CSSProperties}
    >
      <aside className={sidebarCollapsed ? "sidebar collapsed" : "sidebar"}>
        <div className="brand-row">
          <img className="brand-mark" src={arivuLogoUrl} alt="" />
          {!sidebarCollapsed ? <div className="brand-copy">
            <div className="brand-title">Arivu</div>
          </div> : null}
          <button
            className="icon-button sidebar-collapse-button"
            type="button"
            onClick={() => setSidebarCollapsed((current) => !current)}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        <button className="primary-command" type="button" onClick={() => void startNewChat()}>
          <Plus size={17} />
          <span>New chat</span>
        </button>

        {!sidebarCollapsed ? <div className="workspace-actions">
          <button className="secondary-command" type="button" onClick={chooseWorkspace}>
            <FolderOpen size={16} />
            Open
          </button>
          <button className="secondary-command" type="button" onClick={() => void createWorkspace()}>
            <FolderPlus size={16} />
            New workspace
          </button>
        </div> : null}

        {!sidebarCollapsed ? <section className={collapsedSections.projects ? "sidebar-section projects-section collapsed-section" : "sidebar-section projects-section"}>
          <div className="section-row">
            <button
              className="section-toggle"
              type="button"
              aria-expanded={!collapsedSections.projects}
              onClick={() => toggleSidebarSection("projects")}
              title={collapsedSections.projects ? "Expand workspaces" : "Collapse workspaces"}
            >
              {collapsedSections.projects ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <span className="section-label">Workspaces</span>
            </button>
          </div>
          {!collapsedSections.projects ? <div className="recent-project-list">
            {recentProjects.length === 0 ? <div className="empty-sidebar-list">No recent workspaces yet.</div> : null}
            {recentProjects.map((project) => {
              const expanded = expandedProjectRoots[project.projectRoot] ?? project.projectRoot === state.projectRoot;
              const projectOpenBusy = openingWorkspaceRoot === project.projectRoot;
              return (
                <div
                  key={project.projectRoot}
                  className={project.projectRoot === state.projectRoot ? "project-group active" : "project-group"}
                >
                  <div
                    className="project-row"
                    title={project.projectRoot}
                  >
                    <button
                      className="project-expand-button"
                      type="button"
                      onClick={() => toggleProject(project.projectRoot)}
                      title={expanded ? "Hide workspace chats" : "Show workspace chats"}
                      aria-label={expanded ? `Hide chats for ${project.name}` : `Show chats for ${project.name}`}
                      aria-expanded={expanded}
                    >
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <button
                      className="project-open-button"
                      type="button"
                      disabled={Boolean(openingWorkspaceRoot)}
                      onClick={() => void openWorkspace(project.projectRoot)}
                      title={`Open workspace ${project.projectRoot}`}
                      aria-current={project.projectRoot === state.projectRoot ? "page" : undefined}
                    >
                      {projectOpenBusy ? <RefreshCw className="project-folder-icon spinning" size={14} /> : <FolderOpen className="project-folder-icon" size={14} />}
                      <span className="recent-project-main">
                        <strong>{project.name}</strong>
                        <span>{projectOpenBusy ? "Opening..." : project.chatCount === 0 ? "Current workspace" : `${project.chatCount} chats`}</span>
                      </span>
                    </button>
                  </div>
                  {expanded ? (
                    <div className="project-chat-list">
                      {project.sessions.length === 0 ? <div className="empty-sidebar-list">No chats in this project yet.</div> : null}
                      {project.sessions.map((session) => (
                        <SidebarChatItem
                          key={session.id}
                          session={session}
                          active={session.id === state.sessionId}
                          menuOpen={openChatMenuId === session.id}
                          className="project-chat-item"
                          onOpen={() => void openSession(session.id)}
                          onToggleMenu={() => setOpenChatMenuId((current) => current === session.id ? null : session.id)}
                          onRename={() => void renameSession(session)}
                          onTogglePin={() => void toggleSessionPin(session)}
                          onDelete={() => void deleteSession(session)}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div> : null}
        </section> : null}

        {!sidebarCollapsed ? <section className={collapsedSections.chats ? "sidebar-section chats-section collapsed-section" : "sidebar-section chats-section"}>
          <div className="section-row">
            <button
              className="section-toggle"
              type="button"
              aria-expanded={!collapsedSections.chats}
              onClick={() => toggleSidebarSection("chats")}
              title={collapsedSections.chats ? "Expand chats" : "Collapse chats"}
            >
              {collapsedSections.chats ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <span className="section-label">Chats</span>
            </button>
            {!collapsedSections.chats ? (
              <button className="text-command" type="button" onClick={() => setView("history")}>
                View all
              </button>
            ) : null}
          </div>
          {!collapsedSections.chats ? <div className="recent-chat-list">
            {loadingSessions ? <div className="empty-sidebar-list">Loading chats...</div> : null}
            {!loadingSessions && standaloneSessions.length === 0 ? (
              <div className="empty-sidebar-list">No standalone chats yet.</div>
            ) : null}
            {!loadingSessions
              ? standaloneSessions.map((session) => (
                  <SidebarChatItem
                    key={session.id}
                    session={session}
                    active={session.id === state.sessionId}
                    menuOpen={openChatMenuId === session.id}
                    onOpen={() => void openSession(session.id)}
                    onToggleMenu={() => setOpenChatMenuId((current) => current === session.id ? null : session.id)}
                    onRename={() => void renameSession(session)}
                    onTogglePin={() => void toggleSessionPin(session)}
                    onDelete={() => void deleteSession(session)}
                  />
                ))
              : null}
          </div> : null}
        </section> : null}

        {!sidebarCollapsed ? <div className="sidebar-footer">
          <span>{status}</span>
        </div> : null}
      </aside>
      {!sidebarCollapsed ? (
        <div
          className="panel-resize-handle sidebar-resize-handle"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          onPointerDown={(event) => {
            event.preventDefault();
            setResizing("sidebar");
          }}
        />
      ) : null}

      <section className="main-panel">
        <header className="topbar">
          <div className="topbar-context">
            <div className="workspace-heading">
              <h1 title={workspaceDetail}>{workspaceName}</h1>
              <span className="workspace-header-path" title={workspaceDetail}>{workspaceDetail}</span>
              <RuntimeDetails state={state} gitValue={gitValue} />
            </div>
          </div>
          <div className="topbar-actions">
            <ThemeToggle theme={theme} onChange={setTheme} />
            <button
              type="button"
              className={view === "ui" ? "ghost-button topbar-icon-action has-tooltip active" : "ghost-button topbar-icon-action has-tooltip"}
              onClick={() => setView((current) => current === "ui" ? "chat" : "ui")}
              aria-label="UI samples"
              data-tooltip="UI samples"
            >
              <Palette size={14} />
            </button>
            <button
              type="button"
              className={browserState?.paneOpen ? "ghost-button topbar-icon-action has-tooltip active" : "ghost-button topbar-icon-action has-tooltip"}
              onClick={() => {
                setView("chat");
                void setBrowserPaneOpen(!browserState?.paneOpen);
              }}
              aria-label={browserState?.paneOpen ? "Hide browser window" : "Show browser window"}
              data-tooltip={browserState?.paneOpen ? "Hide browser window" : "Show browser window"}
            >
              <Globe size={14} />
            </button>
            <button
              type="button"
              className={chatSearchOpen ? "ghost-button topbar-icon-action has-tooltip active" : "ghost-button topbar-icon-action has-tooltip"}
              onClick={() => {
                setView("chat");
                setChatSearchOpen((current) => !current);
              }}
              aria-label="Search chat"
              data-tooltip="Search chat"
            >
              <Search size={14} />
            </button>
            <button
              type="button"
              className={view === "settings" ? "ghost-button topbar-icon-action has-tooltip active" : "ghost-button topbar-icon-action has-tooltip"}
              onClick={() => {
                setSettingsFocus(null);
                setView((current) => current === "settings" ? "chat" : "settings");
              }}
              aria-label="Settings"
              data-tooltip="Settings"
            >
              <Settings size={14} />
            </button>
            <button
              type="button"
              className="ghost-button topbar-icon-action has-tooltip"
              onClick={() => void refresh()}
              aria-label="Refresh state"
              data-tooltip="Refresh state"
            >
              <RefreshCw size={14} />
            </button>
            <button
              type="button"
              className="ghost-button topbar-icon-action has-tooltip"
              disabled={!canCompactContext}
              onClick={() => void compactContext()}
              aria-label="Compact context"
              data-tooltip="Compact context"
            >
              <Scissors size={14} />
            </button>
            <button
              type="button"
              className="ghost-button topbar-icon-action has-tooltip"
              disabled={busy}
              onClick={() => setPrompt("Reply with exactly OK.")}
              aria-label="Test prompt"
              data-tooltip="Test prompt"
            >
              <Play size={14} />
            </button>
          </div>
        </header>

        {view === "chat" ? (
          <section
            className={workspaceGridClassName}
            style={
              {
                "--activity-width": `${effectiveActivityWidth}px`
              } as React.CSSProperties
            }
          >
            <section className="conversation-panel" aria-label="Conversation">
              {chatSearchOpen ? (
                <ChatSearchBar
                  inputRef={chatSearchInputRef}
                  query={chatSearchQuery}
                  currentIndex={chatSearchIndex}
                  matchCount={chatSearchMatches.length}
                  onQueryChange={(value) => {
                    setChatSearchQuery(value);
                    setChatSearchIndex(0);
                  }}
                  onPrevious={() => moveChatSearch(-1)}
                  onNext={() => moveChatSearch(1)}
                  onClose={() => {
                    setChatSearchOpen(false);
                    setChatSearchQuery("");
                    setChatSearchIndex(0);
                  }}
                />
              ) : null}
              <div className="message-list" ref={messageListRef}>
                {visibleMessages.length === 0 ? (
                  <EmptyConversation />
                ) : (
                  visibleMessages.map(({ message, messageIndex, sourceIndexes, key: messageKey }, index) => {
                    const failedUserPrompt =
                      message.role === "user" &&
                      failedPrompt !== null &&
                      sourceIndexes.includes(failedPrompt.messageIndex) &&
                      chatContentEquals(failedPrompt.content, message.content);
                    const assistantPromptToRetry = retryPromptForAssistant(index);
                    const promptToRetry = failedUserPrompt ? message.content : assistantPromptToRetry;
                    const activityGroup =
                      message.role === "user"
                        ? sourceIndexes
                            .map((sourceIndex) => activityGroupByUserMessageIndex.get(sourceIndex))
                            .find((group): group is ActivityGroup => Boolean(group && group.items.length > 0))
                        : undefined;
                    return (
                      <Fragment key={messageKey}>
                        <MessageBubble
                          message={message}
                          searchKey={messageKey}
                          searchActive={activeChatSearchKey === messageKey}
                          theme={theme}
                          busy={busy}
                          copied={copiedMessageKey === messageKey}
                          canRetry={Boolean(promptToRetry)}
                          canEdit={message.role === "user"}
                          onCopy={() => void copyMessageContent(message.content, messageKey)}
                          onRetry={() => {
                            if (failedUserPrompt) {
                              void submitPrompt(message.content, {
                                reuseFailedPrompt: true,
                                skillNames: failedPrompt?.skillNames ?? [],
                                planModeEnabled: failedPrompt?.planModeEnabled ?? false,
                                loopEnabled: failedPrompt?.loopEnabled ?? false,
                                worktreeEnabled: failedPrompt?.worktreeEnabled ?? false,
                                worktreeTaskRunId: failedPrompt?.worktreeTaskRunId,
                                worktreeReplayOfTaskRunId: failedPrompt?.worktreeReplayOfTaskRunId,
                                worktreePlannedFromTaskRunId: failedPrompt?.worktreePlannedFromTaskRunId
                              });
                              return;
                            }
                            if (assistantPromptToRetry) {
                              void submitPrompt(assistantPromptToRetry);
                            }
                          }}
                          onEdit={() => editPromptContent(message.content)}
                        />
                        {activityGroup && activityGroup.items.length > 0 ? <ToolRunSummary group={activityGroup} /> : null}
                      </Fragment>
                    );
                  })
                )}
                {busy ? (
                  <div className={agentLoopRunning ? "agent-thinking loop-active" : "agent-thinking"}>
                    <span className="pulse-dot" />
                    <span>{agentLoopRunning && activeAgentLoop ? agentLoopLabel : "Agent is working"}</span>
                    {agentLoopRunning ? (
                      <button
                        type="button"
                        onClick={() => void stopAgentLoop()}
                        disabled={activeAgentLoop?.status === "stopping"}
                        title="Stop agent loop after the current iteration"
                        aria-label="Stop agent loop"
                      >
                        <X size={13} />
                        Stop
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {error ? (
                <div className="error-strip">
                  <span>{error}</span>
                  {retryPrompt ? (
                    <button
                      type="button"
                      onClick={retryLastPrompt}
                      disabled={busy}
                      title="Retry query"
                      aria-label="Retry query"
                    >
                      <RotateCcw size={14} />
                      <span className="message-action-tooltip" aria-hidden="true">Retry query</span>
                    </button>
                  ) : null}
                </div>
              ) : null}

              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleComposerSubmit();
                }}
              >
                <div
                  className={composerDragActive ? "composer-surface drag-active" : "composer-surface"}
                  onDragEnter={handleComposerDragEnter}
                  onDragOver={handleComposerDragOver}
                  onDragLeave={handleComposerDragLeave}
                  onDrop={handleComposerDrop}
                >
                  {composerDragActive ? (
                    <div className="composer-drop-overlay" aria-hidden="true">
                      <ImageIcon size={18} />
                      <span>{busy ? "Wait for current response" : "Drop images"}</span>
                    </div>
                  ) : null}
                  <textarea
                    ref={promptInputRef}
                    value={prompt}
                    onChange={(event) => handlePromptChange(event.target.value)}
                    onPaste={handlePromptPaste}
                    placeholder="Ask Arivu to inspect, edit, test, explain, or type / for commands..."
                    rows={1}
                    onKeyDown={handlePromptKeyDown}
                    aria-controls={slashCommandMenuOpen ? "slash-command-menu" : undefined}
                    aria-expanded={slashCommandMenuOpen}
                  />
                  {slashCommandMenuOpen ? (
                    <SlashCommandMenu
                      commands={filteredSlashCommands}
                      selectedIndex={selectedSlashCommandIndex}
                      query={slashQuery ?? ""}
                      onSelect={(command) => void executeSlashCommand(command)}
                      onHighlight={setSelectedSlashCommandIndex}
                    />
                  ) : null}
                  {commandOutput ? <CommandOutputPanel output={commandOutput} onClose={() => setCommandOutput(null)} /> : null}
                  {loadedSkills.length > 0 || pendingSkills.length > 0 ? (
                    <SkillContextStrip loadedSkills={loadedSkills} pendingSkills={pendingSkills} onRemovePending={removePendingSkill} />
                  ) : null}
                  {imageAttachments.length > 0 ? (
                    <ImageAttachmentStrip images={imageAttachments} onRemove={removeImageAttachment} />
                  ) : null}
                  {fileAttachments.length > 0 ? (
                    <FileAttachmentStrip files={fileAttachments} onRemove={removeFileAttachment} />
                  ) : null}
                  {toolsPopoverOpen ? <ToolPanel tools={availableTools} /> : null}
                  {skillsPopoverOpen ? (
                    <SkillPanel
                      skills={availableSkills}
                      skillsRoot={skillsRoot}
                      loadedSkillNames={loadedSkillNames}
                      pendingSkillNames={pendingSkillNames}
                      onLoadSkill={loadSkillForNextPrompt}
                      onRefresh={() => void loadSkills()}
                      onAddSkill={openSkillsSettings}
                    />
                  ) : null}
                  <div className="composer-footer">
                    <div className="composer-meta">
                      <div className="composer-menu-region">
                        <button
                          className={composerOptionsOpen ? "composer-plus-button active" : "composer-plus-button"}
                          type="button"
                          onClick={() => {
                            setToolsPopoverOpen(false);
                            setSkillsPopoverOpen(false);
                            setComposerOptionsOpen((current) => !current);
                          }}
                          disabled={busy}
                          aria-expanded={composerOptionsOpen}
                          aria-label="Prompt options"
                          title="Prompt options"
                        >
                          <Plus size={18} />
                        </button>
                        {composerOptionsOpen ? (
                          <ComposerOptionsMenu
                            state={state}
                            busy={busy}
                            canSelectChatProject={canSelectChatProject}
                            selectedImageCount={imageAttachments.length}
                            selectedFileCount={fileAttachments.length}
                            toolsOpen={toolsPopoverOpen}
                            skillsOpen={skillsPopoverOpen}
                            skillCount={availableSkills.length}
                            browserOpen={browserOpen}
                            projects={projectOptions}
                            onSelectProject={(projectRoot) => void selectChatProject(projectRoot)}
                            onOpenWorkspace={() => void chooseWorkspace()}
                            onChooseImages={() => void chooseImages()}
                            onChooseContextFiles={() => void chooseContextFiles()}
                            onToggleTools={() => {
                              setToolsPopoverOpen((current) => !current);
                              setSkillsPopoverOpen(false);
                              setComposerOptionsOpen(false);
                            }}
                            onToggleSkills={() => {
                              setSkillsPopoverOpen((current) => !current);
                              setToolsPopoverOpen(false);
                              setComposerOptionsOpen(false);
                              void loadSkills();
                            }}
                            onToggleBrowser={() => {
                              setComposerOptionsOpen(false);
                              void setBrowserPaneOpen(!browserOpen);
                            }}
                            onOpenSettings={() => {
                              setComposerOptionsOpen(false);
                              setSkillsPopoverOpen(false);
                              setSettingsFocus(null);
                              setView("settings");
                            }}
                            onOpenSkillsSettings={openSkillsSettings}
                          />
                        ) : null}
                      </div>
                      <ModelSwitcher
                        state={state}
                        busy={busy}
                        onSaved={handleModelSaved}
                        onError={handleModelError}
                        onOpen={() => {
                          setComposerOptionsOpen(false);
                          setToolsPopoverOpen(false);
                          setSkillsPopoverOpen(false);
                        }}
                      />
                      <button
                        className={agentPlanModeEnabled ? "composer-plan-button active" : "composer-plan-button"}
                        type="button"
                        onClick={() => {
                          setAgentPlanModeEnabled((current) => {
                            const next = !current;
                            if (next) {
                              setAgentLoopEnabled(false);
                              setAgentWorktreeEnabled(false);
                              setWorktreeContinuation(null);
                              setWorktreePlanSource(null);
                            }
                            setStatus(next ? "Plan approval armed for the next prompt" : "Plan approval off");
                            return next;
                          });
                        }}
                        disabled={busy}
                        title={agentPlanModeEnabled ? "Turn off plan approval" : "Ask for a read-only plan before executing"}
                        aria-label={agentPlanModeEnabled ? "Turn off plan approval" : "Turn on plan approval for the next prompt"}
                        aria-pressed={agentPlanModeEnabled}
                      >
                        <ListChecks size={14} />
                        <span>{agentPlanModeEnabled ? "Plan on" : "Plan"}</span>
                      </button>
                      <button
                        className={agentWorktreeEnabled || worktreeContinuation || worktreePlanSource ? "composer-worktree-button active" : "composer-worktree-button"}
                        type="button"
                        onClick={() => {
                          setAgentPlanModeEnabled(false);
                          if (worktreeContinuation || worktreePlanSource) {
                            setWorktreeContinuation(null);
                            setWorktreePlanSource(null);
                            setAgentWorktreeEnabled(false);
                            setStatus(worktreePlanSource ? "Approved-plan worktree off" : "Task worktree continuation off");
                            return;
                          }
                          setAgentWorktreeEnabled((current) => {
                            const next = !current;
                            setStatus(next ? "Task worktree armed for the next prompt" : "Task worktree off");
                            return next;
                          });
                        }}
                        disabled={busy || state?.projectRoot === null}
                        title={
                          state?.projectRoot === null
                            ? "Select a git project before using task worktrees"
                            : worktreeContinuation
                              ? worktreeContinuation.replayOfTaskRunId
                                ? `Replay checks in ${worktreeContinuation.branch ?? "existing task worktree"} for the next prompt`
                                : `Continue ${worktreeContinuation.branch ?? "existing task worktree"} for the next prompt`
                              : worktreePlanSource
                                ? `Run approved plan ${shortRunId(worktreePlanSource.taskRunId)} in a new task worktree`
                              : agentWorktreeEnabled
                              ? "Turn off task worktree"
                              : "Run the next prompt in an isolated git worktree"
                        }
                        aria-label={agentWorktreeEnabled || worktreeContinuation || worktreePlanSource ? "Turn off task worktree" : "Turn on task worktree for the next prompt"}
                        aria-pressed={Boolean(agentWorktreeEnabled || worktreeContinuation || worktreePlanSource)}
                      >
                        <GitBranch size={14} />
                        <span>
                          {worktreeContinuation?.replayOfTaskRunId
                            ? "Replay"
                            : worktreeContinuation
                              ? "Continue"
                              : worktreePlanSource
                                ? "Plan tree"
                                : agentWorktreeEnabled
                                  ? "Tree on"
                                  : "Worktree"}
                        </span>
                      </button>
                      <button
                        className={agentLoopEnabled ? "composer-loop-button active" : "composer-loop-button"}
                        type="button"
                        onClick={() => {
                          setAgentPlanModeEnabled(false);
                          setAgentLoopEnabled((current) => !current);
                          setStatus(!agentLoopEnabled ? `Agent loop armed for ${DEFAULT_AGENT_LOOP_MAX_ITERATIONS} iterations` : "Agent loop off");
                        }}
                        disabled={busy}
                        title={agentLoopEnabled ? "Turn off agent loop" : "Turn on agent loop for the next prompt"}
                        aria-label={agentLoopEnabled ? "Turn off agent loop" : "Turn on agent loop for the next prompt"}
                        aria-pressed={agentLoopEnabled}
                      >
                        <RefreshCw size={14} />
                        <span>{agentLoopEnabled ? "Loop on" : "Loop"}</span>
                      </button>
                      <span className={promptTokens > COMPOSER_TOKEN_BUDGET ? "composer-meter over" : "composer-meter"}>
                        {formatNumber(promptTokens)} / {formatNumber(COMPOSER_TOKEN_BUDGET)} tok
                      </span>
                    </div>
                    <button
                      className="composer-send-button icon-send-button"
                      type="submit"
                      disabled={busy || slashQuery !== null || !chatContentHasRenderableContent(createPromptContent(prompt, imageAttachments, fileAttachments))}
                      title="Send prompt"
                      aria-label="Send prompt"
                    >
                      <SendArrowIcon size={22} />
                    </button>
                  </div>
                </div>
              </form>
            </section>

            {!activityCollapsed ? (
              <div
                className="panel-resize-handle activity-resize-handle"
                role="separator"
                aria-label="Resize activity panel"
                aria-orientation="vertical"
                onPointerDown={(event) => {
                  event.preventDefault();
                  setResizing("activity");
                }}
              />
            ) : null}

            <aside className={activityCollapsed ? "activity-panel collapsed" : "activity-panel"} aria-label="Tool activity">
              <div className="panel-heading">
                <div className="panel-heading-title">
                  <Activity size={17} />
                  <span>Activity</span>
                  <span className="activity-count-badge">{toolActivityCount}</span>
                </div>
                <button
                  className="icon-button panel-collapse-button"
                  type="button"
                  onClick={() => setActivityCollapsed((current) => !current)}
                  title={activityCollapsed ? "Expand activity" : "Collapse activity"}
                  aria-label={activityCollapsed ? "Expand activity" : "Collapse activity"}
                >
                  {activityCollapsed ? <Activity size={16} /> : <ChevronRight size={16} />}
                  {activityCollapsed && toolActivityCount > 0 ? <span className="activity-count-badge rail">{toolActivityCount}</span> : null}
                </button>
              </div>
              {!activityCollapsed ? (
                <div className="activity-content">
                  {latestScreenshotActivity?.imagePreview ? (
                    <LatestActivityScreenshot item={latestScreenshotActivity} />
                  ) : null}
                  <div className="activity-list" ref={activityListRef}>
                    {activity.length === 0 ? (
                      <div className="empty-activity">Tool calls and approvals will appear here.</div>
                    ) : (
                      <>
                        {activityModel.systemItems.map((item) => (
                          <ActivityRow key={item.id} item={item} />
                        ))}
                        {activityGroups.map((group) => (
                          <ActivityGroupCard
                            key={group.id}
                            group={group}
                            currentSessionId={state?.sessionId}
                            focusedRunId={focusedActivityRunId}
                            worktreeActionBusy={worktreeActionBusy}
                            planReviewBusy={planReviewBusy}
                            evidenceOpenBusy={evidenceOpenBusy}
                            pullRequestWatches={watchedPullRequests}
                            pullRequestWatchBusy={pullRequestWatchBusy}
                            canCreateWorktree={Boolean(state && state.projectRoot !== null)}
                            onTaskWorktreeAction={handleTaskWorktreeAction}
                            onTaskRunPlanAction={handleTaskRunPlanAction}
                            onTogglePullRequestWatch={handleTogglePullRequestWatch}
                            onFocusTaskRun={handleFocusTaskRunAttempt}
                            onOpenEvidence={handleOpenEvidence}
                            onDraftRemediation={handleDraftRemediationPrompt}
                          />
                        ))}
                      </>
                    )}
                  </div>
                </div>
              ) : null}
            </aside>
          </section>
        ) : view === "history" ? (
          <HistoryView
            sessions={sessions}
            loading={loadingSessions}
            activeSessionId={state.sessionId}
            openMenuId={openHistoryMenuId}
            onReload={() => void loadSessions()}
            onOpen={openSession}
            onRename={renameSession}
            onTogglePin={toggleSessionPin}
            onDelete={deleteSession}
            onToggleMenu={(id) => setOpenHistoryMenuId((current) => current === id ? null : id)}
            onError={(message) => {
              setError(message);
              setStatus("Error");
            }}
          />
        ) : view === "settings" ? (
          <SettingsView
            state={state}
            skills={availableSkills}
            skillsRoot={skillsRoot}
            focusSection={settingsFocus}
            onFocusSettled={() => setSettingsFocus(null)}
            onSkillsChanged={(nextSkills, nextSkillsRoot) => {
              setAvailableSkills(nextSkills);
              setSkillsRoot(nextSkillsRoot);
            }}
            onSaved={(next) => {
              applyDesktopState(next);
              setStatus("Settings saved");
              setView("chat");
            }}
            onStateUpdated={(next) => {
              applyDesktopState(next);
              void loadSessions();
            }}
          />
        ) : (
          <UiLabView activeConcept={uiConcept} onSelect={setUiConcept} />
        )}
      </section>

      {approval ? <ApprovalDialog approval={approval} onRespond={(approved) => void respondApproval(approved)} /> : null}
      {workspaceScaffoldOpen ? (
        <WorkspaceScaffoldDialog
          onCancel={() => setWorkspaceScaffoldOpen(false)}
          onCreate={(options) => void confirmCreateWorkspace(options)}
        />
      ) : null}
      {pasteReview ? (
        <PasteReviewDialog
          review={pasteReview}
          onCancel={() => {
            setPasteReview(null);
            setStatus("Paste cancelled");
          }}
          onInsertFull={() => acceptReviewedPaste("full")}
          onInsertTruncated={() => acceptReviewedPaste("truncated")}
        />
      ) : null}
    </main>
  );
}

function RuntimeDetails({ state, gitValue }: { state: DesktopState; gitValue: string }) {
  const details = [
    { label: "Provider", value: activeProviderName(state.config) },
    { label: "Model", value: modelDisplayName(state.config.model) },
    ...(state.modelSelection?.mode === "auto"
      ? [{ label: "Auto picked", value: `${state.modelSelection.model} (${state.modelSelection.providerName})` }]
      : []),
    { label: "Base URL", value: state.config.baseUrl },
    { label: "Trust", value: state.config.trustMode },
    { label: "Git", value: gitValue },
    { label: "API key", value: state.config.apiKeyPresent ? "saved" : "missing" },
    { label: "Tavily", value: state.config.tavilyApiKeyPresent ? "saved" : "missing" }
  ];

  return (
    <div className="runtime-details">
      <button
        type="button"
        className="runtime-details-button"
        aria-label="Runtime details"
        aria-describedby="runtime-details-popover"
      >
        <Info size={13} />
      </button>
      <div className="runtime-details-popover" id="runtime-details-popover" role="tooltip">
        <dl className="runtime-detail-list">
          {details.map((detail) => (
            <div className="runtime-detail-row" key={detail.label}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function ChatSearchBar({
  inputRef,
  query,
  currentIndex,
  matchCount,
  onQueryChange,
  onPrevious,
  onNext,
  onClose
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  currentIndex: number;
  matchCount: number;
  onQueryChange: (value: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const countLabel = query.trim() ? (matchCount > 0 ? `${currentIndex + 1} / ${matchCount}` : "No matches") : "Find in chat";
  return (
    <div className="chat-search-bar" role="search">
      <Search size={15} />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search chat"
        aria-label="Search chat"
      />
      <span className={matchCount === 0 && query.trim() ? "chat-search-count empty" : "chat-search-count"}>{countLabel}</span>
      <button className="icon-button compact-icon-button" type="button" onClick={onPrevious} disabled={matchCount === 0} title="Previous match">
        <ChevronLeft size={14} />
      </button>
      <button className="icon-button compact-icon-button" type="button" onClick={onNext} disabled={matchCount === 0} title="Next match">
        <ChevronRight size={14} />
      </button>
      <button className="icon-button compact-icon-button" type="button" onClick={onClose} title="Close search" aria-label="Close search">
        <X size={14} />
      </button>
    </div>
  );
}

function ThemeToggle({ theme, onChange }: { theme: ThemeMode; onChange: (theme: ThemeMode) => void }) {
  return (
    <div className="theme-toggle" role="group" aria-label="Color theme">
      <button
        type="button"
        className={theme === "light" ? "theme-toggle-button has-tooltip active" : "theme-toggle-button has-tooltip"}
        onClick={() => onChange("light")}
        aria-pressed={theme === "light"}
        aria-label="Light mode"
        data-tooltip="Light mode"
      >
        <Sun size={13} />
        <span className="sr-only">Light mode</span>
      </button>
      <button
        type="button"
        className={theme === "dark" ? "theme-toggle-button has-tooltip active" : "theme-toggle-button has-tooltip"}
        onClick={() => onChange("dark")}
        aria-pressed={theme === "dark"}
        aria-label="Dark mode"
        data-tooltip="Dark mode"
      >
        <Moon size={13} />
        <span className="sr-only">Dark mode</span>
      </button>
    </div>
  );
}

function SendArrowIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 16.25V8.45m0 0-3.15 3.15M12 8.45l3.15 3.15"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ComposerOptionsMenu({
  state,
  busy,
  canSelectChatProject,
  selectedImageCount,
  selectedFileCount,
  toolsOpen,
  skillsOpen,
  skillCount,
  browserOpen,
  projects,
  onSelectProject,
  onOpenWorkspace,
  onChooseImages,
  onChooseContextFiles,
  onToggleTools,
  onToggleSkills,
  onToggleBrowser,
  onOpenSettings,
  onOpenSkillsSettings
}: {
  state: DesktopState;
  busy: boolean;
  canSelectChatProject: boolean;
  selectedImageCount: number;
  selectedFileCount: number;
  toolsOpen: boolean;
  skillsOpen: boolean;
  skillCount: number;
  browserOpen: boolean;
  projects: ProjectOption[];
  onSelectProject: (projectRoot: string | null) => void;
  onOpenWorkspace: () => void;
  onChooseImages: () => void;
  onChooseContextFiles: () => void;
  onToggleTools: () => void;
  onToggleSkills: () => void;
  onToggleBrowser: () => void;
  onOpenSettings: () => void;
  onOpenSkillsSettings: () => void;
}) {
  return (
    <div className="composer-options-menu" role="menu" aria-label="Prompt options">
      {canSelectChatProject ? (
        <div className="composer-option-row">
          <span className="composer-option-label">
            <FolderOpen size={15} />
            Project
          </span>
          <ChatProjectSelector
            selectedProjectRoot={state.projectRoot}
            projects={projects}
            onSelect={onSelectProject}
            onOpenWorkspace={onOpenWorkspace}
          />
        </div>
      ) : null}
      <div className="composer-option-row">
        <span className="composer-option-label">
          <ImageIcon size={15} />
          Images
        </span>
        <ImageAttachButton count={selectedImageCount} disabled={busy} onClick={onChooseImages} />
      </div>
      <div className="composer-option-row">
        <span className="composer-option-label">
          <FileText size={15} />
          Files
        </span>
        <FileAttachButton
          count={selectedFileCount}
          disabled={busy || state.projectRoot === null}
          disabledReason={busy ? "Wait for the current response before attaching file context" : "Open a workspace before attaching file context"}
          onClick={onChooseContextFiles}
        />
      </div>
      <div className="composer-option-row">
        <span className="composer-option-label">
          <Wrench size={15} />
          Tools
        </span>
        <ToolButton open={toolsOpen} onToggle={onToggleTools} />
      </div>
      <div className="composer-option-row">
        <span className="composer-option-label">
          <Globe size={15} />
          Browser
        </span>
        <div className="browser-option-controls">
          <button
            className={browserOpen ? "composer-tool-button active" : "composer-tool-button"}
            type="button"
            onClick={onToggleBrowser}
            title={browserOpen ? "Hide browser window" : "Show browser window"}
          >
            <Globe size={15} />
            {browserOpen ? "Window open" : "Window"}
          </button>
          <span className="browser-option-note">Agent runs hidden</span>
        </div>
      </div>
      <div className="composer-option-row">
        <span className="composer-option-label">
          <FileText size={15} />
          Skills
        </span>
        <SkillButton open={skillsOpen} count={skillCount} onToggle={onToggleSkills} />
      </div>
      <button className="composer-option-row composer-option-action" type="button" onClick={onOpenSkillsSettings}>
        <span className="composer-option-label">
          <Plus size={15} />
          Add skill
        </span>
        <span>{skillCount} installed</span>
      </button>
      <button className="composer-option-row composer-option-action" type="button" onClick={onOpenSettings}>
        <span className="composer-option-label">
          <Server size={15} />
          MCP
        </span>
        <span>{Object.keys(state.config.mcpServers).length} servers</span>
      </button>
    </div>
  );
}

function ImageAttachButton({
  count,
  disabled,
  onClick
}: {
  count: number;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = count > 0 ? `Attach images (${count})` : "Attach images";
  return (
    <button
      className={count > 0 ? "composer-tool-button active" : "composer-tool-button"}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      <ImageIcon size={15} />
      Images
    </button>
  );
}

function FileAttachButton({
  count,
  disabled,
  disabledReason,
  onClick
}: {
  count: number;
  disabled: boolean;
  disabledReason: string;
  onClick: () => void;
}) {
  const label = count > 0 ? `Attach file context (${count})` : "Attach file context";
  return (
    <button
      className={count > 0 ? "composer-tool-button active" : "composer-tool-button"}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledReason : label}
      aria-label={label}
    >
      <FileText size={15} />
      Files
    </button>
  );
}

function ImageAttachmentStrip({
  images,
  onRemove
}: {
  images: ImageAttachment[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="image-attachment-strip" aria-label="Attached images">
      {images.map((image) => (
        <figure className="image-attachment" key={image.id}>
          <img src={image.dataUrl} alt={image.name} />
          <button type="button" onClick={() => onRemove(image.id)} title="Remove image" aria-label={`Remove ${image.name}`}>
            <X size={12} />
          </button>
        </figure>
      ))}
    </div>
  );
}

function FileAttachmentStrip({
  files,
  onRemove
}: {
  files: ContextFileAttachment[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="file-attachment-strip" aria-label="Attached file context">
      <span className="skill-context-label">
        <FileText size={13} />
        Files
      </span>
      {files.map((file) => (
        <span className="file-context-chip" key={file.id} title={`${file.path} - ${formatBytes(file.size)} - ${formatNumber(file.lineCount)} lines`}>
          <FileText size={13} />
          <span>{file.path}</span>
          <small>{file.truncated ? "truncated" : `${formatNumber(file.lineCount)} lines`}</small>
          <button type="button" onClick={() => onRemove(file.id)} title={`Remove ${file.name}`} aria-label={`Remove ${file.name}`}>
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

function SkillContextStrip({
  loadedSkills,
  pendingSkills,
  onRemovePending
}: {
  loadedSkills: SkillSummary[];
  pendingSkills: SkillSummary[];
  onRemovePending: (name: string) => void;
}) {
  return (
    <div className="skill-context-strip" aria-label="Chat skills">
      <span className="skill-context-label">
        <FileText size={13} />
        Skills
      </span>
      {loadedSkills.map((skill) => (
        <span className="skill-context-chip loaded" key={`loaded-${skill.name}`} title={`Loaded in chat: $${skill.name}`}>
          <Check size={12} />
          ${skill.name}
        </span>
      ))}
      {pendingSkills.map((skill) => (
        <span className="skill-context-chip pending" key={`pending-${skill.name}`} title={`Queued for next prompt: $${skill.name}`}>
          <span>${skill.name}</span>
          <button type="button" onClick={() => onRemovePending(skill.name)} aria-label={`Remove $${skill.name}`}>
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

function ToolButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="composer-tools-region tool-popover-root">
      <button
        className={open ? "composer-tool-button active" : "composer-tool-button"}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title="Available tools"
      >
        <Wrench size={15} />
        Tools
      </button>
    </div>
  );
}

function SkillButton({ open, count, onToggle }: { open: boolean; count: number; onToggle: () => void }) {
  const label = count === 1 ? "Show 1 skill" : `Show ${count} skills`;
  return (
    <div className="composer-skills-region skill-popover-root">
      <button
        className={open ? "composer-tool-button active" : "composer-tool-button"}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={label}
      >
        <FileText size={15} />
        Skills
      </button>
    </div>
  );
}

function SlashCommandMenu({
  commands,
  selectedIndex,
  query,
  onSelect,
  onHighlight
}: {
  commands: SlashCommandEntry[];
  selectedIndex: number;
  query: string;
  onSelect: (command: SlashCommandEntry) => void;
  onHighlight: (index: number) => void;
}) {
  return (
    <div id="slash-command-menu" className="slash-command-menu" role="listbox" aria-label="Slash commands">
      <div className="slash-command-heading">
        <strong>Slash commands</strong>
        <span>{commands.length > 0 ? `${commands.length}` : "No match"}</span>
      </div>
      <div className="slash-command-list">
        {commands.length === 0 ? (
          <div className="slash-command-empty">No command matches /{query}</div>
        ) : (
          commands.map((command, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                key={command.id}
                id={`slash-command-${command.id}`}
                className={selected ? "slash-command-row selected" : "slash-command-row"}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={Boolean(command.disabledReason)}
                onMouseEnter={() => onHighlight(index)}
                onClick={() => onSelect(command)}
              >
                <span className="slash-command-icon" aria-hidden="true">
                  <SlashCommandIcon id={command.id} />
                </span>
                <span className="slash-command-copy">
                  <span className="slash-command-title">
                    <code>/{command.command}</code>
                    <strong>{command.title}</strong>
                  </span>
                  <span>{command.disabledReason ?? command.description}</span>
                  {command.detail ? <small>{command.detail}</small> : null}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function SlashCommandIcon({ id }: { id: SlashCommandId }) {
  if (id === "compact") {
    return <Scissors size={15} />;
  }
  if (id === "tools") {
    return <Wrench size={15} />;
  }
  if (id === "skills") {
    return <FileText size={15} />;
  }
  if (id === "browser") {
    return <Globe size={15} />;
  }
  if (id === "loop") {
    return <RefreshCw size={15} />;
  }
  if (id === "worktree") {
    return <GitBranch size={15} />;
  }
  return <Info size={15} />;
}

function CommandOutputPanel({ output, onClose }: { output: CommandOutput; onClose: () => void }) {
  return (
    <section className="command-output-panel" aria-label={output.title} aria-live="polite">
      <div className="command-output-heading">
        <div>
          <strong>{output.title}</strong>
          {output.subtitle ? <span>{output.subtitle}</span> : null}
        </div>
        <button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="Close command output">
          <X size={14} />
        </button>
      </div>
      <dl className="command-output-grid">
        {output.rows.map((row) => (
          <div key={row.label} className="command-output-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ToolPanel({ tools }: { tools: ToolSummary[] }) {
  return (
    <div className="composer-tools-region tool-popover" role="dialog" aria-label="Available tools">
      <div className="tool-popover-heading">
        <strong>Available tools</strong>
        <span>{tools.length}</span>
      </div>
      <div className="tool-list">
        {tools.length === 0 ? (
          <div className="tool-empty">No tools loaded.</div>
        ) : (
          tools.map((tool) => (
            <article key={tool.name} className="tool-row">
              <div className="tool-row-top">
                <code>{tool.name}</code>
                <span className={`tool-status ${tool.status}`}>{tool.statusLabel}</span>
              </div>
              <p>{tool.description}</p>
              {tool.parameters.length > 0 ? <span className="tool-params">{tool.parameters.join(", ")}</span> : null}
            </article>
          ))
        )}
      </div>
    </div>
  );
}

function UiLabView({
  activeConcept,
  onSelect
}: {
  activeConcept: UiConceptId;
  onSelect: (concept: UiConceptId) => void;
}) {
  return (
    <section className="ui-lab-panel">
      <div className="ui-lab-grid">
        {UI_CONCEPTS.map((concept) => {
          const Icon = concept.icon;
          const selected = concept.id === activeConcept;
          return (
            <article key={concept.id} className={selected ? "ui-sample-card selected" : "ui-sample-card"}>
              <div className={`ui-sample-preview ${concept.id}`} aria-hidden="true">
                <div className="sample-sidebar">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="sample-main">
                  <div className="sample-topline">
                    <span />
                    <span />
                  </div>
                  <div className="sample-chat-lines">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="sample-composer" />
                </div>
                <div className="sample-rail">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
              <div className="ui-sample-body">
                <div className="ui-sample-heading">
                  <div className="ui-sample-icon">
                    <Icon size={18} />
                  </div>
                  <div>
                    <h2>{concept.name}</h2>
                    <p>{concept.subtitle}</p>
                  </div>
                </div>
                <div className="ui-swatch-row" aria-label={`${concept.name} palette`}>
                  {concept.swatches.map((swatch) => (
                    <span key={swatch} style={{ background: swatch }} />
                  ))}
                </div>
                <div className="ui-sample-metrics">
                  {concept.sampleMetrics.map((metric) => (
                    <span key={metric}>{metric}</span>
                  ))}
                </div>
                <button className={selected ? "ui-sample-action selected" : "ui-sample-action"} type="button" onClick={() => onSelect(concept.id)}>
                  {selected ? <Check size={16} /> : <Palette size={16} />}
                  {selected ? "Selected" : "Apply"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ChatProjectSelector({
  selectedProjectRoot,
  projects,
  onSelect,
  onOpenWorkspace
}: {
  selectedProjectRoot: string | null;
  projects: ProjectOption[];
  onSelect: (projectRoot: string | null) => void;
  onOpenWorkspace: () => void;
}) {
  return (
    <div className="chat-project-selector" title="Project for this new chat">
      <FolderOpen size={15} />
      <select
        aria-label="Project for this new chat"
        value={selectedProjectRoot ?? STANDALONE_PROJECT_VALUE}
        onChange={(event) => onSelect(event.target.value === STANDALONE_PROJECT_VALUE ? null : event.target.value)}
      >
        <option value={STANDALONE_PROJECT_VALUE}>No project</option>
        {projects.map((project) => (
          <option key={project.projectRoot} value={project.projectRoot}>
            {project.name}
          </option>
        ))}
      </select>
      <button
        className="icon-button compact-icon-button"
        type="button"
        onClick={onOpenWorkspace}
        title="Open workspace"
        aria-label="Open workspace"
      >
        <FolderOpen size={15} />
      </button>
    </div>
  );
}

function SkillPanel({
  skills,
  skillsRoot,
  loadedSkillNames,
  pendingSkillNames,
  onLoadSkill,
  onRefresh,
  onAddSkill
}: {
  skills: SkillSummary[];
  skillsRoot: string;
  loadedSkillNames: string[];
  pendingSkillNames: string[];
  onLoadSkill: (skill: SkillSummary) => void;
  onRefresh: () => void;
  onAddSkill: () => void;
}) {
  return (
    <div className="composer-skills-region skill-popover" role="dialog" aria-label="Available skills">
      <div className="tool-popover-heading">
        <strong>Available skills</strong>
        <span>{skills.length}</span>
      </div>
      <div className="skill-list">
        {skills.length === 0 ? (
          <div className="tool-empty">No skills installed.</div>
        ) : (
          skills.map((skill) => {
            const loaded = loadedSkillNames.includes(skill.name);
            const pending = pendingSkillNames.includes(skill.name);
            return (
              <article key={skill.name} className={loaded || pending ? "skill-row active" : "skill-row"}>
                <div className="tool-row-top">
                  <code>${skill.name}</code>
                  <button
                    className={loaded || pending ? "skill-load-button active" : "skill-load-button"}
                    type="button"
                    onClick={() => onLoadSkill(skill)}
                    disabled={loaded}
                    aria-label={`${loaded ? "Loaded" : pending ? "Queued" : "Load"} $${skill.name}`}
                  >
                    {loaded ? "Loaded" : pending ? "Queued" : "Load"}
                  </button>
                </div>
                <strong>{skill.title}</strong>
                {skill.description ? <p>{skill.description}</p> : null}
                <span className="skill-path" title={skill.path}>{skill.path}</span>
              </article>
            );
          })
        )}
      </div>
      <div className="skill-popover-actions">
        <span title={skillsRoot}>{skillsRoot || "Global skills directory"}</span>
        <button className="secondary-command" type="button" onClick={onRefresh}>
          <RefreshCw size={15} />
          Refresh
        </button>
        <button className="secondary-command" type="button" onClick={onAddSkill}>
          <Plus size={15} />
          Add skill
        </button>
      </div>
    </div>
  );
}

function ModelSwitcher({
  state,
  busy,
  onSaved,
  onError,
  onOpen
}: {
  state: DesktopState;
  busy: boolean;
  onSaved: (state: DesktopState) => void;
  onError: (message: string) => void;
  onOpen?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const modelLabel = modelDisplayName(state.config.model);

  async function selectModel(nextModel: string) {
    if (!nextModel || saving) {
      return;
    }
    if (nextModel === state.config.model) {
      setOpen(false);
      return;
    }

    setSaving(true);
    try {
      const next = await window.arivu.saveConfig({ model: nextModel });
      onSaved(next);
      setOpen(false);
    } catch (err) {
      const message = formatError(err);
      onError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="model-switcher">
      <button
        className="model-dialog-trigger"
        type="button"
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
        disabled={busy || saving}
        title="Switch model"
        aria-label={`Switch model. Current model: ${modelLabel}`}
      >
        <Cpu size={15} />
        <span>{modelLabel}</span>
        <Search size={13} />
      </button>
      {open ? (
        <ModelPickerDialog
          currentModel={state.config.model}
          baseUrl={state.config.baseUrl}
          onSelect={(model) => void selectModel(model)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ModelPickerDialog({
  currentModel,
  baseUrl,
  apiKey,
  onSelect,
  onClose
}: {
  currentModel: string;
  baseUrl: string;
  apiKey?: string;
  onSelect: (model: string) => void;
  onClose: () => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => searchRef.current?.focus());
    void loadModels();
  }, []);

  const options = useMemo(() => Array.from(new Set([AUTO_MODEL_VALUE, currentModel, ...models])).filter(Boolean), [currentModel, models]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? options.filter((model) => model.toLowerCase().includes(needle)) : options;
  }, [options, query]);
  const manualModel = query.trim();
  const showCustomModelAction = Boolean(error || notice || (manualModel && filtered.length === 0 && !loading));

  async function loadModels() {
    if (!baseUrl.trim()) {
      setModels([]);
      setNotice(null);
      setError("Enter a provider URL to load models, or enter a model ID manually.");
      return;
    }

    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.arivu.listModels({
        baseUrl,
        apiKey: apiKey?.trim() || undefined
      });
      setModels(result.models);
      if (result.models.length === 0) {
        setNotice("No models were returned by this provider. Enter a model ID manually.");
      }
    } catch (err) {
      setModels([]);
      setError(`${formatError(err)} Enter a model ID manually if this provider does not expose /models.`);
    } finally {
      setLoading(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop">
      <section className="model-dialog" role="dialog" aria-modal="true" aria-label="Select model">
        <div className="model-dialog-header">
          <div className="approval-icon">
            <Cpu size={23} />
          </div>
          <div>
            <h2>Select model</h2>
            <p>{baseUrl}</p>
          </div>
          <button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="Close model picker">
            <X size={14} />
          </button>
        </div>
        <div className="model-search-field">
          <Search size={15} />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={showCustomModelAction ? "Search or enter model ID" : "Search models"}
            aria-label="Search models"
          />
          <button className="icon-button compact-icon-button" type="button" onClick={() => void loadModels()} disabled={loading} title="Refresh models">
            <RefreshCw size={14} />
          </button>
        </div>
        {error ? <div className="model-dialog-note error-note">{error}</div> : null}
        {!error && notice ? <div className="model-dialog-note">{notice}</div> : null}
        {!error && loading ? <div className="model-dialog-note">Loading available models...</div> : null}
        <div className="model-result-list">
          {filtered.length === 0 && !loading ? <div className="model-empty">No matching models.</div> : null}
          {filtered.map((model) => (
            <button
              key={model}
              className={model === currentModel ? "model-result selected" : "model-result"}
              type="button"
              title={isAutoModelId(model) ? "Automatically pick a model for each prompt." : model}
              onClick={() => onSelect(model)}
            >
              <span>{modelDisplayName(model)}</span>
              {model === currentModel ? <Check size={15} /> : null}
            </button>
          ))}
        </div>
        {showCustomModelAction ? (
          <div className="custom-model-row">
            <button className="secondary-command" type="button" onClick={() => onSelect(manualModel)} disabled={!manualModel}>
              Use custom
            </button>
          </div>
        ) : null}
      </section>
    </div>,
    document.body
  );
}

function HistoryView({
  sessions,
  loading,
  activeSessionId,
  openMenuId,
  onReload,
  onOpen,
  onRename,
  onTogglePin,
  onDelete,
  onToggleMenu,
  onError
}: {
  sessions: SessionSummary[];
  loading: boolean;
  activeSessionId?: string;
  openMenuId: string | null;
  onReload: () => void;
  onOpen: (id: string) => Promise<void>;
  onRename: (session: SessionSummary) => Promise<void>;
  onTogglePin: (session: SessionSummary) => Promise<void>;
  onDelete: (session: SessionSummary) => Promise<void>;
  onToggleMenu: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function openSession(id: string) {
    setOpeningId(id);
    try {
      await onOpen(id);
    } catch (err) {
      onError(formatError(err));
    } finally {
      setOpeningId(null);
    }
  }

  async function deleteSession(session: SessionSummary) {
    setDeletingId(session.id);
    try {
      await onDelete(session);
    } catch (err) {
      onError(formatError(err));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="history-panel">
      <div className="history-toolbar">
        <div>
          <div className="section-label">Saved Sessions</div>
          <h2>Conversation history</h2>
        </div>
        <button className="ghost-button" type="button" onClick={onReload} disabled={loading}>
          <RefreshCw size={16} />
          Reload
        </button>
      </div>

      {loading ? <div className="history-empty">Loading history...</div> : null}
      {!loading && sessions.length === 0 ? <div className="history-empty">No saved sessions yet.</div> : null}

      <div className="history-list">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={session.id === activeSessionId ? "history-item active" : "history-item"}
          >
            <button
              className="history-row"
              type="button"
              onClick={() => void openSession(session.id)}
              disabled={openingId === session.id || deletingId === session.id}
            >
              <div className="history-main">
                <strong>{session.title}</strong>
                {session.pinnedAt ? <Pin className="chat-pin-indicator" size={12} aria-label="Pinned chat" /> : null}
                {session.running ? <span className="chat-loading-dot" title="Response loading" aria-label="Response loading" /> : null}
              </div>
              <div className="history-details">
                <span>{formatDateTime(session.updatedAt)}</span>
                {session.pinnedAt ? <span title={`Pinned ${formatDateTime(session.pinnedAt)}`}>Pinned</span> : null}
                <span title={session.cwd}>{basename(session.cwd)}</span>
                <span title={sessionModelTitle(session)}>{sessionModelLabel(session)}</span>
                {session.agentLoop ? <span title={agentLoopStatusLabel(session.agentLoop)}>{sessionLoopLabel(session.agentLoop)}</span> : null}
                <span>{session.messageCount} messages</span>
              </div>
            </button>
            <ChatOptionsMenu
              open={openMenuId === session.id}
              title={session.title}
              pinned={Boolean(session.pinnedAt)}
              disabled={deletingId === session.id}
              onToggle={() => onToggleMenu(session.id)}
              onRename={() => void onRename(session)}
              onTogglePin={() => void onTogglePin(session)}
              onDelete={() => void deleteSession(session)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function SidebarChatItem({
  session,
  active,
  menuOpen,
  className,
  onOpen,
  onToggleMenu,
  onRename,
  onTogglePin,
  onDelete
}: {
  session: SessionSummary;
  active: boolean;
  menuOpen: boolean;
  className?: string;
  onOpen: () => void;
  onToggleMenu: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const classes = ["recent-chat-item", active ? "active" : "", className ?? ""].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      <button className="recent-chat-row" type="button" onClick={onOpen}>
        <div className="recent-chat-main">
          <strong>{session.title}</strong>
          {session.pinnedAt ? <Pin className="chat-pin-indicator" size={11} aria-label="Pinned chat" /> : null}
          {session.running ? <span className="chat-loading-dot" title="Response loading" aria-label="Response loading" /> : null}
        </div>
        <div className="recent-chat-details">
          <span>{formatDateTime(session.updatedAt)}</span>
          {session.pinnedAt ? <span title={`Pinned ${formatDateTime(session.pinnedAt)}`}>Pinned</span> : null}
          <span title={sessionModelTitle(session)}>{sessionModelLabel(session)}</span>
          {session.agentLoop ? <span title={agentLoopStatusLabel(session.agentLoop)}>{sessionLoopLabel(session.agentLoop)}</span> : null}
          <span>{session.messageCount} messages</span>
        </div>
      </button>
      <ChatOptionsMenu
        open={menuOpen}
        title={session.title}
        pinned={Boolean(session.pinnedAt)}
        onToggle={onToggleMenu}
        onRename={onRename}
        onTogglePin={onTogglePin}
        onDelete={onDelete}
      />
    </div>
  );
}

function ChatOptionsMenu({
  open,
  title,
  pinned,
  disabled,
  onToggle,
  onRename,
  onTogglePin,
  onDelete
}: {
  open: boolean;
  title: string;
  pinned: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }

    const updateMenuPosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      const maxLeft = Math.max(CHAT_OPTIONS_MENU_MARGIN, window.innerWidth - CHAT_OPTIONS_MENU_WIDTH - CHAT_OPTIONS_MENU_MARGIN);
      const left = clamp(rect.right - CHAT_OPTIONS_MENU_WIDTH, CHAT_OPTIONS_MENU_MARGIN, maxLeft);
      const topBelow = rect.bottom + CHAT_OPTIONS_MENU_GAP;
      const topAbove = rect.top - CHAT_OPTIONS_MENU_HEIGHT - CHAT_OPTIONS_MENU_GAP;
      const hasRoomBelow = topBelow + CHAT_OPTIONS_MENU_HEIGHT <= window.innerHeight - CHAT_OPTIONS_MENU_MARGIN;
      const top = hasRoomBelow ? topBelow : Math.max(CHAT_OPTIONS_MENU_MARGIN, topAbove);

      setMenuPosition({ left, top });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open]);

  const menu = open && menuPosition ? createPortal(
    <div
      className="chat-options-menu"
      role="menu"
      style={{
        left: menuPosition.left,
        position: "fixed",
        right: "auto",
        top: menuPosition.top
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <button className="chat-menu-item" type="button" onClick={onRename} role="menuitem">
        <Pencil size={14} />
        Rename
      </button>
      <button className="chat-menu-item" type="button" onClick={onTogglePin} role="menuitem">
        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
        {pinned ? "Unpin" : "Pin"}
      </button>
      <button className="chat-menu-item danger" type="button" onClick={onDelete} role="menuitem">
        <Trash2 size={14} />
        Delete
      </button>
    </div>,
    document.body
  ) : null;

  return (
    <div className={open ? "chat-options open" : "chat-options"} onClick={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        className="icon-button chat-options-button"
        type="button"
        onClick={onToggle}
        disabled={disabled}
        title={`Options for ${title}`}
        aria-label={`Options for ${title}`}
        aria-expanded={open}
      >
        <MoreHorizontal size={15} />
      </button>
      {menu}
    </div>
  );
}

function EmptyConversation() {
  return (
    <div className="empty-conversation">
      <div className="empty-icon">
        <MessageSquare size={26} />
      </div>
      <h2>Start with the task, not the setup.</h2>
      <p>Ask for a code review, a fix, an explanation, or a small implementation. Tool activity and approvals stay visible on the right.</p>
    </div>
  );
}

function MessageBubble({
  message,
  searchKey,
  searchActive,
  theme,
  busy,
  copied,
  canRetry,
  canEdit,
  onCopy,
  onRetry,
  onEdit
}: {
  message: ChatMessage;
  searchKey: string;
  searchActive: boolean;
  theme: ThemeMode;
  busy: boolean;
  copied: boolean;
  canRetry: boolean;
  canEdit: boolean;
  onCopy: () => void;
  onRetry: () => void;
  onEdit: () => void;
}) {
  const isUser = message.role === "user";
  const copyLabel = copied ? "Copied" : "Copy message";
  return (
    <article
      className={`${isUser ? "message user-message" : "message assistant-message"}${searchActive ? " search-active" : ""}`}
      data-message-search-key={searchKey}
    >
      <div className="message-heading">
        <div className="message-label">{isUser ? "You" : "Agent"}</div>
      </div>
      {isUser ? (
        <UserMessageContent content={message.content} />
      ) : (
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: (props) => <MarkdownCode {...props} theme={theme} /> }}>
            {chatContentToText(message.content)}
          </ReactMarkdown>
        </div>
      )}
      <div className="message-actions">
        {canEdit ? (
          <button
            className="message-action-button"
            type="button"
            onClick={onEdit}
            disabled={busy}
            title="Edit query"
            aria-label="Edit query"
          >
            <Pencil size={13} />
            <span className="message-action-tooltip" aria-hidden="true">Edit query</span>
          </button>
        ) : null}
        {canRetry ? (
          <button
            className="message-action-button"
            type="button"
            onClick={onRetry}
            disabled={busy}
            title="Retry query"
            aria-label="Retry query"
          >
            <RotateCcw size={13} />
            <span className="message-action-tooltip" aria-hidden="true">Retry query</span>
          </button>
        ) : null}
        <button
          className="message-action-button"
          type="button"
          onClick={onCopy}
          title={copyLabel}
          aria-label={copyLabel}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span className="message-action-tooltip" aria-hidden="true">{copyLabel}</span>
        </button>
      </div>
    </article>
  );
}

function MarkdownCode({ className, children, theme, ...props }: ComponentPropsWithoutRef<"code"> & { theme: ThemeMode }) {
  const code = String(children ?? "").replace(/\n$/, "");
  const language = /language-([a-zA-Z0-9_+-]+)/.exec(className ?? "")?.[1];
  const looksLikeBlock = Boolean(language) || code.includes("\n");

  if (!looksLikeBlock) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  return <CodeBlock code={code} language={language ?? "text"} theme={theme} />;
}

function CodeBlock({ code, language, theme }: { code: string; language: string; theme: ThemeMode }) {
  const [html, setHtml] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function highlight() {
      try {
        const nextHtml = await highlightCode(code, language, theme);
        if (!cancelled) {
          setHtml(nextHtml);
        }
      } catch {
        if (!cancelled) {
          setHtml("");
        }
      }
    }
    void highlight();
    return () => {
      cancelled = true;
    };
  }, [code, language, theme]);

  async function copyCode() {
    await writeClipboardText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{languageLabel(language)}</span>
        <button type="button" className="code-copy-button" onClick={() => void copyCode()} title="Copy code" aria-label="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      {html ? (
        <div className="code-block-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-block-fallback">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

async function highlightCode(code: string, language: string, theme: ThemeMode) {
  const { codeToHtml } = await import("shiki");
  const shikiTheme = theme === "light" ? "github-light" : "github-dark";
  try {
    return await codeToHtml(code, { lang: language || "text", theme: shikiTheme });
  } catch {
    return codeToHtml(code, { lang: "text", theme: shikiTheme });
  }
}

function languageLabel(language: string) {
  return language === "text" ? "text" : language;
}

function UserMessageContent({ content }: { content: ChatContent }) {
  const text = chatContentTextOnly(content);
  const images = imagePartsFromContent(content);
  return (
    <div className="user-message-content">
      {text ? <pre>{text}</pre> : null}
      {images.length > 0 ? (
        <div className="message-image-grid">
          {images.map((image, index) => (
            <figure className="message-image" key={`${image.image_url.url.slice(0, 48)}-${index}`}>
              <img src={image.image_url.url} alt={image.name ?? `Attached image ${index + 1}`} />
            </figure>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolRunSummary({ group }: { group: ActivityGroup }) {
  const [expanded, setExpanded] = useState(group.status === "running");
  const toolItems = group.items.filter((item) => item.kind !== "system");
  if (toolItems.length === 0) {
    return null;
  }

  return (
    <section className={`tool-run-summary ${group.status}`} aria-label={`Activity for ${group.title}`}>
      <button
        className="tool-run-summary-button"
        type="button"
        aria-expanded={expanded}
        title={expanded ? "Collapse tool calls" : "Expand tool calls"}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="tool-run-icon">{group.status === "running" ? <span className="pulse-dot" /> : <TerminalSquare size={13} />}</span>
        <strong>{toolRunSummaryLabel(group)}</strong>
        <span>{group.title}</span>
      </button>
      {group.run ? <TaskRunMeta run={group.run} compact /> : null}
      {expanded ? (
        <div className="tool-run-list">
          {toolItems.map((item, itemIndex) => {
            const detailPreview = toolRunDetailPreview(item);
            return (
              <div className={`tool-run-item ${item.kind}${item.status ? ` status-${item.status}` : ""}`} key={item.id}>
                <span className="tool-run-step">{itemIndex + 1}</span>
                <span className="tool-run-kind">{toolRunKindLabel(item)}</span>
                <strong>{item.title}</strong>
                {item.status ? <span className={`activity-status ${item.status}`}>{activityStatusLabel(item.status)}</span> : null}
                {item.imagePreview ? <span className="tool-run-chip">Screenshot</span> : null}
                {item.policy ? <ActivityPolicyChip policy={item.policy} compact /> : null}
                {item.summary ? <p>{item.summary}</p> : null}
                {detailPreview ? <pre>{detailPreview}</pre> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function ActivityGroupCard({
  group,
  currentSessionId,
  focusedRunId,
  worktreeActionBusy,
  planReviewBusy,
  evidenceOpenBusy,
  pullRequestWatches,
  pullRequestWatchBusy,
  canCreateWorktree,
  onTaskWorktreeAction,
  onTaskRunPlanAction,
  onTogglePullRequestWatch,
  onFocusTaskRun,
  onOpenEvidence,
  onDraftRemediation
}: {
  group: ActivityGroup;
  currentSessionId?: string;
  focusedRunId: string | null;
  worktreeActionBusy: string | null;
  planReviewBusy: string | null;
  evidenceOpenBusy: string | null;
  pullRequestWatches: Record<string, PullRequestWatch>;
  pullRequestWatchBusy: Record<string, boolean>;
  canCreateWorktree: boolean;
  onTaskWorktreeAction: (run: AgentTaskRun, action: TaskWorktreeAction, options?: TaskWorktreeActionOptions) => void;
  onTaskRunPlanAction: (run: AgentTaskRun, action: TaskRunPlanAction) => void;
  onTogglePullRequestWatch: (run: AgentTaskRun) => void;
  onFocusTaskRun: (run: AgentTaskRun) => void;
  onOpenEvidence: (link: ActivityEvidenceLink) => void;
  onDraftRemediation: (draftText: string, options?: DraftPromptOptions) => void;
}) {
  const [collapsed, setCollapsed] = useState(group.status !== "running");
  const [copiedAudit, setCopiedAudit] = useState(false);
  const auditCopyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolItemCount = group.items.filter((item) => item.kind !== "system").length;
  const focused = Boolean(group.run && group.run.id === focusedRunId);
  const planApprovalPrompt = group.run ? buildTaskRunPlanApprovalPrompt(group.run) : undefined;
  const planWorktreePrompt = group.run ? buildTaskRunPlanApprovalPrompt(group.run, { worktree: true }) : undefined;

  useEffect(() => {
    if (focused) {
      setCollapsed(false);
    }
  }, [focused]);

  useEffect(() => {
    return () => {
      if (auditCopyResetTimeoutRef.current) {
        clearTimeout(auditCopyResetTimeoutRef.current);
      }
    };
  }, []);

  async function copyAuditSummary() {
    if (!group.run) {
      return;
    }
    try {
      await writeClipboardText(buildTaskRunAuditMarkdown(group.run));
      setCopiedAudit(true);
      if (auditCopyResetTimeoutRef.current) {
        clearTimeout(auditCopyResetTimeoutRef.current);
      }
      auditCopyResetTimeoutRef.current = setTimeout(() => {
        setCopiedAudit(false);
        auditCopyResetTimeoutRef.current = null;
      }, 1400);
    } catch {
      setCopiedAudit(false);
    }
  }

  return (
    <section
      className={`activity-group ${group.status}${focused ? " focus-active" : ""}`}
      data-activity-run-id={group.run?.id}
    >
      <button
        className="activity-group-header"
        type="button"
        aria-expanded={!collapsed}
        title={collapsed ? "Expand query tool activity" : "Collapse query tool activity"}
        onClick={() => setCollapsed((current) => !current)}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <div className="activity-group-title">
          <span>Query</span>
          <strong>{group.title}</strong>
        </div>
        <span className="activity-group-count">{toolEventCountLabel(toolItemCount)}</span>
        <span className={`activity-status ${group.status}`}>{activityStatusLabel(group.status)}</span>
      </button>
      {group.run ? (
        <button
          className="activity-group-audit-button"
          type="button"
          onClick={() => void copyAuditSummary()}
          title={copiedAudit ? "Copied audit summary" : "Copy audit summary"}
          aria-label={copiedAudit ? "Copied audit summary" : "Copy audit summary"}
        >
          {copiedAudit ? <Check size={12} /> : <Copy size={12} />}
        </button>
      ) : null}
      {!collapsed ? (
        <div className="activity-group-body">
          {group.run ? <TaskRunMeta run={group.run} /> : null}
          {group.run?.verification ? <TaskRunVerification verification={group.run.verification} /> : null}
          {group.run?.plan ? (
            <TaskRunPlan
              plan={group.run.plan}
              planReview={group.run.planReview}
              approvalPrompt={planApprovalPrompt}
              worktreePrompt={planWorktreePrompt}
              canCreateWorktree={canCreateWorktree}
              actionBusyKey={planReviewBusy}
              runId={group.run.id}
              onDraftApproval={(draftText) =>
                onDraftRemediation(draftText, {
                  status: "Approved-plan prompt drafted",
                  confirmLabel: "Replace the composer with this approved-plan prompt?"
                })
              }
              onDraftWorktreeApproval={(draftText) =>
                group.run &&
                onDraftRemediation(draftText, {
                  worktreePlanSource: { taskRunId: group.run.id },
                  status: "Approved plan drafted in a task worktree",
                  confirmLabel: "Replace the composer and arm a new task worktree for this approved plan?"
                })
              }
              onPlanAction={(action) => group.run && onTaskRunPlanAction(group.run, action)}
            />
          ) : null}
          {group.run ? (
            <TaskWorktreeActions
              run={group.run}
              sourceRun={group.sourceRun}
              planSourceRun={group.planSourceRun}
              attemptRuns={group.worktreeAttemptRuns}
              focusedRunId={focusedRunId}
              busyKey={worktreeActionBusy}
              pullRequestWatch={pullRequestWatchForRun(currentSessionId, group.run, pullRequestWatches, pullRequestWatchBusy)}
              onAction={onTaskWorktreeAction}
              onTogglePullRequestWatch={onTogglePullRequestWatch}
              onFocusAttempt={onFocusTaskRun}
              onDraftRemediation={onDraftRemediation}
            />
          ) : null}
          {group.items.map((item) => (
            <ActivityRow
              key={item.id}
              item={item}
              defaultCollapsed
              evidenceOpenBusy={evidenceOpenBusy}
              onOpenEvidence={onOpenEvidence}
              onDraftRemediation={onDraftRemediation}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function TaskWorktreeActions({
  run,
  sourceRun,
  planSourceRun,
  attemptRuns,
  focusedRunId,
  busyKey,
  pullRequestWatch,
  onAction,
  onTogglePullRequestWatch,
  onFocusAttempt,
  onDraftRemediation
}: {
  run: AgentTaskRun;
  sourceRun?: AgentTaskRun;
  planSourceRun?: AgentTaskRun;
  attemptRuns?: AgentTaskRun[];
  focusedRunId: string | null;
  busyKey: string | null;
  pullRequestWatch: PullRequestWatchView;
  onAction: (run: AgentTaskRun, action: TaskWorktreeAction, options?: TaskWorktreeActionOptions) => void;
  onTogglePullRequestWatch: (run: AgentTaskRun) => void;
  onFocusAttempt: (run: AgentTaskRun) => void;
  onDraftRemediation: (draftText: string, options?: DraftPromptOptions) => void;
}) {
  const worktree = run.worktree;
  if (!worktree?.enabled) {
    return null;
  }

  const actions = taskWorktreeActionsForRun(run);
  const diffLabel = worktreeDiffLabel(worktree.diff);
  const busy = busyKey?.startsWith(`${run.id}:`) ?? false;
  const patchPreview = worktreePatchDiffPreview(worktree.patchPreview);
  const verificationGate = taskWorktreeVerificationGate(run, sourceRun);
  const verificationRepairPrompt = buildTaskRunVerificationRepairPrompt(run);
  const verificationRerunPrompt = buildTaskRunVerificationRerunPrompt(run, sourceRun);
  const pullRequestReviewPrompt = buildTaskRunPullRequestReviewPrompt(run);
  const planSourceReview = buildTaskRunPlanSourceReview(run, planSourceRun);
  return (
    <div className="task-worktree-panel">
      <div className="task-worktree-summary">
        <GitBranch size={13} />
        <span title={worktree.path ?? worktree.error}>
          {worktree.branch ?? "Task worktree"} - {worktreeStatusLabel(worktree.status)}
        </span>
        {diffLabel ? <strong>{diffLabel}</strong> : null}
      </div>
      {worktree.error ? <p className="task-worktree-error">{worktree.error}</p> : null}
      {planSourceReview ? <TaskWorktreePlanSourceReview review={planSourceReview} /> : null}
      {verificationGate ? <p className={`task-worktree-gate ${verificationGate.status}`}>{verificationGate.message}</p> : null}
      {worktree.conflict ? (
        <TaskWorktreeConflictCard
          run={run}
          busyKey={busyKey}
          onAction={onAction}
        />
      ) : null}
      <TaskWorktreeAttemptTimeline
        runs={attemptRuns ?? []}
        currentRunId={run.id}
        focusedRunId={focusedRunId}
        busyKey={busyKey}
        onFocusAttempt={onFocusAttempt}
        onOpenAttempt={(attempt) => onAction(attempt, "open")}
        onDraftRemediation={onDraftRemediation}
      />
      {actions.length > 0 ? (
        <div className="task-worktree-actions">
          {actions.map((action) => {
            const actionBusy = busyKey === `${run.id}:${action.id}`;
            return (
              <button
                key={action.id}
                type="button"
                onClick={() => onAction(run, action.id)}
                disabled={busy || action.disabled}
                title={action.disabledReason ?? action.title}
                aria-label={action.title}
              >
                {actionBusy ? <span className="pulse-dot" /> : action.icon}
                {action.label}
              </button>
            );
          })}
          {verificationRepairPrompt ? (
            <button
              type="button"
              disabled={busy}
              title="Draft a repair prompt and continue this task worktree"
              onClick={() =>
                onDraftRemediation(verificationRepairPrompt, {
                  worktreeContinuation: { taskRunId: run.id, branch: worktree.branch },
                  status: "Drafted repair prompt for task worktree",
                  confirmLabel: "Replace the current composer draft with a repair prompt for this task worktree?"
                })
              }
            >
              <Wrench size={12} />
              Fix verification
            </button>
          ) : null}
          {verificationRerunPrompt ? (
            <button
              type="button"
              disabled={busy}
              title="Draft a prompt that reruns verification in this task worktree"
              onClick={() =>
                onDraftRemediation(verificationRerunPrompt, {
                  worktreeContinuation: { taskRunId: run.id, branch: worktree.branch },
                  status: "Drafted verification rerun prompt for task worktree",
                  confirmLabel: "Replace the current composer draft with a verification rerun prompt for this task worktree?"
                })
              }
            >
              <RefreshCw size={12} />
              Rerun checks
            </button>
          ) : null}
        </div>
      ) : null}
      {worktree.pullRequest ? (
        <TaskWorktreePullRequestCard
          run={run}
          pullRequest={worktree.pullRequest}
          reviewPrompt={pullRequestReviewPrompt}
          busy={busy}
          watch={pullRequestWatch}
          onAction={onAction}
          onToggleWatch={onTogglePullRequestWatch}
          onDraftRemediation={onDraftRemediation}
        />
      ) : null}
      {patchPreview ? (
        <div className="task-worktree-patch">
          <div className="task-worktree-patch-note">
            <span>{worktree.patchPreview?.truncated ? "Patch preview truncated" : "Patch preview ready"}</span>
            <strong>{formatBytes(worktree.patchPreview?.bytes ?? 0)}</strong>
          </div>
          <DiffBlock preview={patchPreview} />
        </div>
      ) : null}
    </div>
  );
}

function TaskWorktreePlanSourceReview({ review }: { review: AgentTaskRunPlanSourceReview }) {
  const visiblePaths = review.changedPaths.slice(0, 4);
  const hiddenPathCount = Math.max(0, review.changedPaths.length - visiblePaths.length);
  return (
    <div className="task-worktree-plan-source">
      <div className="task-worktree-plan-source-heading">
        <ListChecks size={12} />
        <div>
          <strong>Approved plan source</strong>
          <span>
            {shortRunId(review.sourceRunId)}
            {review.reviewStatus ? ` - ${planReviewStatusLabel(review.reviewStatus)}` : ""}
            {review.reviewUpdatedAt ? ` - ${formatDateTime(review.reviewUpdatedAt)}` : ""}
          </span>
        </div>
      </div>
      {review.sourcePromptPreview ? <p>{review.sourcePromptPreview}</p> : null}
      {review.planSummary ? <p>{review.planSummary}</p> : null}
      {review.completionNotes.length > 0 ? (
        <div className="task-worktree-plan-source-completion">
          <div className="task-worktree-plan-source-completion-heading">
            <strong>Completion notes</strong>
            <span className={review.completionStatus}>{planCompletionStatusLabel(review.completionStatus)}</span>
          </div>
          <p>{review.completionSummary}</p>
          <ol>
            {review.completionNotes.map((note, index) => (
              <li className={`completion-${note.status}`} key={`${note.text}-${index}`}>
                <span>{planCompletionStatusLabel(note.status)}</span>
                <div>
                  <strong>{note.text}</strong>
                  <small>
                    {[note.planStatus ? `Plan ${planItemStatusLabel(note.planStatus).toLowerCase()}` : undefined, ...note.evidence]
                      .filter(Boolean)
                      .join(" - ")}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <div className="task-worktree-plan-source-cues">
        {review.cues.map((cue) => (
          <span key={`${cue.status}-${cue.text}`} className={cue.status}>
            {planSourceCueIcon(cue.status)}
            {cue.text}
          </span>
        ))}
      </div>
      {visiblePaths.length > 0 ? (
        <div className="task-worktree-plan-source-paths">
          {visiblePaths.map((changedPath) => (
            <code key={changedPath}>{changedPath}</code>
          ))}
          {hiddenPathCount > 0 ? <code>+{hiddenPathCount} more</code> : null}
        </div>
      ) : null}
    </div>
  );
}

function planSourceCueIcon(status: AgentTaskRunPlanSourceReview["cues"][number]["status"]) {
  switch (status) {
    case "passed":
      return <Check size={11} />;
    case "failed":
      return <AlertTriangle size={11} />;
    default:
      return <Info size={11} />;
  }
}

function planCompletionStatusLabel(status: AgentTaskRunPlanSourceReview["completionStatus"]) {
  switch (status) {
    case "supported":
      return "Supported";
    case "blocked":
      return "Blocked";
    case "needs_evidence":
      return "Needs evidence";
  }
}

function TaskWorktreeConflictCard({
  run,
  busyKey,
  onAction
}: {
  run: AgentTaskRun;
  busyKey: string | null;
  onAction: (run: AgentTaskRun, action: TaskWorktreeAction, options?: TaskWorktreeActionOptions) => void;
}) {
  const conflict = run.worktree?.conflict;
  if (!conflict) {
    return null;
  }
  const visibleFiles = conflict.files.slice(0, 6);
  const hiddenCount = conflict.files.length - visibleFiles.length;
  const busy = busyKey?.startsWith(`${run.id}:`) ?? false;
  return (
    <div className="task-worktree-conflict" aria-label="Task worktree conflict resolution">
      <div className="task-worktree-conflict-heading">
        <AlertTriangle size={13} />
        <span>Conflict resolution</span>
        <strong>{formatDateTime(conflict.detectedAt)}</strong>
      </div>
      <p>{conflict.message}</p>
      {visibleFiles.length > 0 ? (
        <ul>
          {visibleFiles.map((file) => (
            <li key={file}>
              <button
                type="button"
                onClick={() => onAction(run, "open_conflict_file", { conflictPath: file })}
                disabled={busy}
                title={`Open ${file}`}
              >
                <FileText size={11} />
                <span>{truncateMiddle(file, 54)}</span>
              </button>
            </li>
          ))}
          {hiddenCount > 0 ? (
            <li>
              <MoreHorizontal size={11} />
              <span>{formatNumber(hiddenCount)} more file{hiddenCount === 1 ? "" : "s"}</span>
            </li>
          ) : null}
        </ul>
      ) : null}
      <div className="task-worktree-conflict-actions">
        <button type="button" onClick={() => onAction(run, "open")} disabled={busy} title="Open this worktree to resolve conflicts">
          <FolderOpen size={12} />
          Open
        </button>
        <button type="button" onClick={() => onAction(run, "continue_conflict")} disabled={busy} title="Continue after conflicts are resolved and staged">
          <Check size={12} />
          Continue
        </button>
        <button type="button" onClick={() => onAction(run, "abort_conflict")} disabled={busy} title="Abort this sync and return to the previous task branch state">
          <RotateCcw size={12} />
          Abort
        </button>
      </div>
    </div>
  );
}

function TaskWorktreeAttemptTimeline({
  runs,
  currentRunId,
  focusedRunId,
  busyKey,
  onFocusAttempt,
  onOpenAttempt,
  onDraftRemediation
}: {
  runs: AgentTaskRun[];
  currentRunId: string;
  focusedRunId: string | null;
  busyKey: string | null;
  onFocusAttempt: (run: AgentTaskRun) => void;
  onOpenAttempt: (run: AgentTaskRun) => void;
  onDraftRemediation: (draftText: string, options?: DraftPromptOptions) => void;
}) {
  const [compareRunId, setCompareRunId] = useState<string | null>(null);
  if (runs.length <= 1) {
    return null;
  }
  const currentRun = runs.find((run) => run.id === currentRunId) ?? runs.at(-1);
  const comparisonRun = compareRunId ? runs.find((run) => run.id === compareRunId) : undefined;
  const comparison =
    currentRun && comparisonRun
      ? attemptComparisonForRuns(runs, comparisonRun, currentRun)
      : undefined;
  const replayOutcomeGroups = buildTaskRunReplayOutcomeGroups(runs);
  const runsById = new Map(runs.map((attempt) => [attempt.id, attempt]));

  return (
    <div className="task-worktree-attempts" aria-label="Task worktree repair history">
      <div className="task-worktree-attempts-heading">
        <ListChecks size={13} />
        <span>Repair history</span>
        <strong>{runs.length} attempts</strong>
      </div>
      <ol>
        {runs.map((attempt, index) => {
          const verificationStatus = attempt.verification?.status ?? "unknown";
          const stage = attempt.worktree?.replayOfTaskRunId ? "Replay" : attempt.worktree?.continuedFromTaskRunId ? "Continuation" : "Original";
          const isCurrent = attempt.id === currentRunId;
          const focused = attempt.id === focusedRunId;
          const openAction = taskWorktreeActionsForRun(attempt).find((action) => action.id === "open");
          const openBusy = busyKey === `${attempt.id}:open`;
          const compareAvailable = Boolean(
            currentRun &&
              (attempt.id !== currentRun.id || runs.findIndex((run) => run.id === attempt.id) > 0)
          );
          const replayPrompt = currentRun ? buildTaskRunVerificationReplayPrompt(attempt, currentRun) : undefined;
          const meta = [
            isCurrent ? "Current" : stage,
            taskRunStatusLabel(attempt.status),
            attempt.worktree?.replayOfTaskRunId ? `Replay of ${shortRunId(attempt.worktree.replayOfTaskRunId)}` : undefined,
            attempt.verification ? verificationStatusLabel(attempt.verification.status) : "Verification unknown",
            formatDateTime(attempt.updatedAt)
          ].filter((part): part is string => Boolean(part));
          return (
            <li key={attempt.id} className={`status-${verificationStatus}${focused ? " focus-active" : ""}`}>
              <span className="task-worktree-attempt-index">{index + 1}</span>
              <div>
                <strong title={attempt.promptPreview}>{attempt.promptPreview || stage}</strong>
                <small>{meta.join(" - ")}</small>
              </div>
              <div className="task-worktree-attempt-actions">
                <button type="button" onClick={() => onFocusAttempt(attempt)} title="Show this attempt's Activity details">
                  <MessageSquare size={11} />
                  Details
                </button>
                {compareAvailable ? (
                  <button type="button" onClick={() => setCompareRunId(attempt.id)} title="Compare this attempt with the current attempt">
                    <Rows3 size={11} />
                    Compare
                  </button>
                ) : null}
                {replayPrompt && currentRun?.worktree ? (
                  <button
                    type="button"
                    onClick={() =>
                      onDraftRemediation(replayPrompt, {
                        worktreeContinuation: { taskRunId: currentRun.id, branch: currentRun.worktree?.branch, replayOfTaskRunId: attempt.id },
                        status: "Drafted replay checks prompt for task worktree",
                        confirmLabel: "Replace the current composer draft with a replay-checks prompt for this task worktree?"
                      })
                    }
                    title="Draft a prompt that replays this attempt's verification commands in the current worktree"
                  >
                    <RefreshCw size={11} />
                    Replay
                  </button>
                ) : null}
                {openAction ? (
                  <button
                    type="button"
                    onClick={() => onOpenAttempt(attempt)}
                    disabled={Boolean(busyKey) || openAction.disabled}
                    title={openAction.disabledReason ?? "Open this attempt's managed worktree"}
                  >
                    {openBusy ? <span className="pulse-dot" /> : <FolderOpen size={11} />}
                    Open
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {replayOutcomeGroups.length > 0 ? (
        <TaskWorktreeReplayOutcomes
          groups={replayOutcomeGroups}
          runsById={runsById}
          currentRun={currentRun}
          onFocusAttempt={onFocusAttempt}
          onDraftRemediation={onDraftRemediation}
        />
      ) : null}
      {comparison ? (
        <TaskWorktreeAttemptComparison
          from={comparison.from}
          to={comparison.to}
          onClose={() => setCompareRunId(null)}
        />
      ) : null}
    </div>
  );
}

function TaskWorktreeAttemptComparison({
  from,
  to,
  onClose
}: {
  from: AgentTaskRun;
  to: AgentTaskRun;
  onClose: () => void;
}) {
  const diffComparison = buildTaskRunDiffComparison(from, to);
  const rows = [
    ["Prompt", attemptPromptLabel(from), attemptPromptLabel(to)],
    ["Run", taskRunStatusLabel(from.status), taskRunStatusLabel(to.status)],
    ["Verification", attemptVerificationLabel(from), attemptVerificationLabel(to)],
    ["Commands", attemptCommandEvidenceLabel(from), attemptCommandEvidenceLabel(to)],
    ["Reports", attemptReportEvidenceLabel(from), attemptReportEvidenceLabel(to)],
    ["Changes", attemptWorktreeChangeLabel(from), attemptWorktreeChangeLabel(to)],
    ["Replay", attemptReplayLabel(from), attemptReplayLabel(to)],
    ["Updated", formatDateTime(from.updatedAt), formatDateTime(to.updatedAt)]
  ];

  return (
    <div className="task-worktree-attempt-comparison" aria-label="Repair attempt comparison">
      <div className="task-worktree-attempt-comparison-heading">
        <Rows3 size={13} />
        <span>Compare attempts</span>
        <button type="button" onClick={onClose} title="Close comparison" aria-label="Close comparison">
          <X size={12} />
        </button>
      </div>
      <div className="task-worktree-attempt-comparison-grid">
        <span />
        <strong title={from.promptPreview}>{from.id === to.id ? "Selected" : "Selected attempt"}</strong>
        <strong title={to.promptPreview}>Current attempt</strong>
        {rows.map(([label, left, right]) => (
          <Fragment key={label}>
            <span>{label}</span>
            <small title={left}>{left}</small>
            <small title={right}>{right}</small>
          </Fragment>
        ))}
      </div>
      <TaskWorktreeAttemptDiffDetails comparison={diffComparison} />
    </div>
  );
}

function TaskWorktreeReplayOutcomes({
  groups,
  runsById,
  currentRun,
  onFocusAttempt,
  onDraftRemediation
}: {
  groups: AgentTaskRunReplayOutcomeGroup[];
  runsById: Map<string, AgentTaskRun>;
  currentRun: AgentTaskRun | undefined;
  onFocusAttempt: (run: AgentTaskRun) => void;
  onDraftRemediation: (draftText: string, options?: DraftPromptOptions) => void;
}) {
  return (
    <div className="task-worktree-replay-outcomes" aria-label="Replay outcomes">
      <div className="task-worktree-replay-outcomes-heading">
        <RefreshCw size={12} />
        <span>Replay outcomes</span>
        <strong>{groups.reduce((total, group) => total + group.outcomes.length, 0)} replay{groups.reduce((total, group) => total + group.outcomes.length, 0) === 1 ? "" : "s"}</strong>
      </div>
      {groups.map((group) => {
        const evidenceRun = runsById.get(group.evidenceRunId);
        const outcomeRuns = group.outcomes.map((outcome) => runsById.get(outcome.runId)).filter((run): run is AgentTaskRun => Boolean(run));
        const reviewPrompt =
          evidenceRun && currentRun ? buildTaskRunReplayFailureReviewPrompt(evidenceRun, outcomeRuns, currentRun) : undefined;
        const outcomeSummary = replayOutcomeSummary(group);
        return (
          <div key={group.evidenceRunId} className="task-worktree-replay-group">
            <div className="task-worktree-replay-group-heading">
              <div>
                <strong title={group.evidencePromptPreview}>
                  Evidence {shortRunId(group.evidenceRunId)}
                </strong>
                <small>
                  {[
                    group.evidenceVerificationStatus ? `Evidence ${verificationStatusLabel(group.evidenceVerificationStatus)}` : "Evidence status unknown",
                    outcomeSummary,
                    group.latestOutcome ? formatDateTime(group.latestOutcome.updatedAt) : undefined
                  ]
                    .filter((part): part is string => Boolean(part))
                    .join(" - ")}
                </small>
              </div>
              {reviewPrompt && currentRun?.worktree ? (
                <button
                  type="button"
                  onClick={() =>
                    onDraftRemediation(reviewPrompt, {
                      worktreeContinuation: {
                        taskRunId: currentRun.id,
                        branch: currentRun.worktree?.branch,
                        replayOfTaskRunId: group.evidenceRunId
                      },
                      status: "Drafted replay failure review prompt for task worktree",
                      confirmLabel: "Replace the current composer draft with a replay failure review prompt for this task worktree?"
                    })
                  }
                  title="Draft a review prompt for repeated failed replay checks"
                >
                  <Wrench size={11} />
                  Review
                </button>
              ) : null}
            </div>
            <div className="task-worktree-replay-list">
              {group.outcomes.map((outcome) => {
                const run = runsById.get(outcome.runId);
                const status = outcome.verificationStatus ?? "unknown";
                return (
                  <button
                    key={outcome.runId}
                    type="button"
                    className={`status-${status}`}
                    onClick={() => (run ? onFocusAttempt(run) : undefined)}
                    disabled={!run}
                    title={outcome.verificationSummary ?? outcome.promptPreview ?? outcome.runId}
                  >
                    <span>{shortRunId(outcome.runId)}</span>
                    <strong>{verificationStatusLabel(status)}</strong>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TaskWorktreeAttemptDiffDetails({ comparison }: { comparison: AgentTaskRunDiffComparison }) {
  const visibleDeltas = comparison.pathDeltas.slice(0, 8);
  const hiddenCount = comparison.pathDeltas.length - visibleDeltas.length;
  const counters = [
    `${formatNumber(comparison.right.pathCount)} current path${comparison.right.pathCount === 1 ? "" : "s"}`,
    comparison.added.length ? `${formatNumber(comparison.added.length)} added` : undefined,
    comparison.removed.length ? `${formatNumber(comparison.removed.length)} removed` : undefined,
    comparison.shared.length ? `${formatNumber(comparison.shared.length)} shared` : undefined,
    attemptChangeStatsLabel(comparison.right)
  ].filter((part): part is string => Boolean(part));

  return (
    <div className="task-worktree-diff-details" aria-label="Attempt file-level comparison">
      <div className="task-worktree-diff-details-heading">
        <FileText size={12} />
        <span>File delta</span>
        <strong>{counters.join(" - ") || "No changed paths recorded"}</strong>
      </div>
      {comparison.pathDeltas.length > 0 ? (
        <ul>
          {visibleDeltas.map((delta) => (
            <li key={delta.path} className={`state-${delta.state}`}>
              <span>{attemptPathDeltaLabel(delta.state)}</span>
              <strong title={delta.path}>{truncateMiddle(delta.path, 54)}</strong>
              <small title={attemptPathDeltaSources(delta)}>{attemptPathDeltaSources(delta)}</small>
            </li>
          ))}
          {hiddenCount > 0 ? (
            <li className="state-hidden">
              <span>More</span>
              <strong>{formatNumber(hiddenCount)} more path{hiddenCount === 1 ? "" : "s"}</strong>
              <small>Open patch preview for full diff evidence.</small>
            </li>
          ) : null}
        </ul>
      ) : (
        <p>No per-file diff evidence was stored for these attempts.</p>
      )}
    </div>
  );
}

function attemptComparisonForRuns(runs: AgentTaskRun[], selectedRun: AgentTaskRun, currentRun: AgentTaskRun) {
  if (selectedRun.id !== currentRun.id) {
    return { from: selectedRun, to: currentRun };
  }
  const selectedIndex = runs.findIndex((run) => run.id === selectedRun.id);
  const previous = selectedIndex > 0 ? runs[selectedIndex - 1] : undefined;
  return previous ? { from: previous, to: currentRun } : undefined;
}

function attemptPromptLabel(run: AgentTaskRun) {
  return run.promptPreview ? truncateMiddle(run.promptPreview, 70) : "(no prompt)";
}

function shortRunId(id: string) {
  return truncateMiddle(id, 18);
}

function attemptVerificationLabel(run: AgentTaskRun) {
  const verification = run.verification;
  if (!verification) {
    return "No verification captured";
  }
  const stats = [
    `${verificationStatusLabel(verification.status)}`,
    `${formatNumber(verification.commandCount)} cmd`,
    verification.failedCommandCount ? `${formatNumber(verification.failedCommandCount)} failed` : undefined,
    verification.parsedReportCount ? `${formatNumber(verification.parsedReportCount)} reports` : undefined,
    verification.failedReportCount ? `${formatNumber(verification.failedReportCount)} failed reports` : undefined
  ].filter((part): part is string => Boolean(part));
  return stats.join(" - ");
}

function attemptCommandEvidenceLabel(run: AgentTaskRun) {
  const commands = run.artifacts.filter((artifact) => artifact.kind === "command_output");
  if (!commands.length) {
    return "No command evidence";
  }
  const failed = commands.filter((artifact) => artifact.exitCode !== undefined && artifact.exitCode !== 0).length;
  const latest = commands.at(-1);
  const command = latest?.command ? truncateMiddle(latest.command, 42) : latest?.title ?? "command";
  return `${formatNumber(commands.length)} command${commands.length === 1 ? "" : "s"}${failed ? `, ${formatNumber(failed)} failed` : ""} - ${command}`;
}

function attemptReportEvidenceLabel(run: AgentTaskRun) {
  const reports = run.artifacts.flatMap((artifact) => artifact.kind === "command_output" ? artifact.testReports ?? [] : []);
  if (!reports.length) {
    return "No parsed reports";
  }
  const failed = reports.filter((report) => report.status === "failed").length;
  const latest = reports.at(-1);
  return `${formatNumber(reports.length)} report${reports.length === 1 ? "" : "s"}${failed ? `, ${formatNumber(failed)} failed` : ""} - ${latest?.summary ?? latest?.path ?? "report"}`;
}

function attemptWorktreeChangeLabel(run: AgentTaskRun) {
  const diffLabel = worktreeDiffLabel(run.worktree?.diff);
  if (diffLabel) {
    return diffLabel;
  }
  const patch = run.worktree?.patchPreview;
  if (patch) {
    return `Patch ${formatBytes(patch.bytes)}${patch.truncated ? " truncated" : ""}`;
  }
  const patchArtifacts = run.artifacts.filter((artifact) => artifact.kind === "patch" || artifact.kind === "file_change");
  if (patchArtifacts.length) {
    return `${formatNumber(patchArtifacts.length)} edit artifact${patchArtifacts.length === 1 ? "" : "s"}`;
  }
  return "No change summary";
}

function attemptReplayLabel(run: AgentTaskRun) {
  return run.worktree?.replayOfTaskRunId ? `Replay of ${shortRunId(run.worktree.replayOfTaskRunId)}` : "Not a replay";
}

function replayOutcomeSummary(group: AgentTaskRunReplayOutcomeGroup) {
  const parts = [
    group.failedOutcomeCount ? `${formatNumber(group.failedOutcomeCount)} failed` : undefined,
    group.passedOutcomeCount ? `${formatNumber(group.passedOutcomeCount)} passed` : undefined,
    group.unknownOutcomeCount ? `${formatNumber(group.unknownOutcomeCount)} unknown` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(", ") : `${formatNumber(group.outcomes.length)} replay${group.outcomes.length === 1 ? "" : "s"}`;
}

function attemptChangeStatsLabel(summary: AgentTaskRunDiffComparison["right"]) {
  const stats = [
    summary.insertions ? `+${formatNumber(summary.insertions)}` : undefined,
    summary.deletions ? `-${formatNumber(summary.deletions)}` : undefined,
    summary.patchPreviewBytes ? `patch ${formatBytes(summary.patchPreviewBytes)}` : undefined,
    summary.patchPreviewTruncated ? "truncated" : undefined
  ].filter((part): part is string => Boolean(part));
  return stats.join(" ");
}

function attemptPathDeltaLabel(state: AgentTaskRunDiffComparison["pathDeltas"][number]["state"]) {
  switch (state) {
    case "added":
      return "Current";
    case "removed":
      return "Selected";
    case "shared":
      return "Both";
    default:
      return "Path";
  }
}

function attemptPathDeltaSources(delta: AgentTaskRunDiffComparison["pathDeltas"][number]) {
  const left = delta.leftSources.length ? `selected: ${delta.leftSources.join(", ")}` : undefined;
  const right = delta.rightSources.length ? `current: ${delta.rightSources.join(", ")}` : undefined;
  return [left, right].filter((part): part is string => Boolean(part)).join(" | ") || "No source label";
}

function pullRequestWatchKey(sessionId: string, taskRunId: string) {
  return `${sessionId}:${taskRunId}`;
}

function pullRequestWatchForRun(
  sessionId: string | undefined,
  run: AgentTaskRun,
  watches: Record<string, PullRequestWatch>,
  busy: Record<string, boolean>
): PullRequestWatchView {
  if (!sessionId) {
    return { active: false, refreshing: false };
  }
  const key = pullRequestWatchKey(sessionId, run.id);
  const watch = watches[key];
  return {
    active: Boolean(watch),
    refreshing: Boolean(busy[key]),
    lastRefreshedAt: watch?.lastRefreshedAt,
    lastError: watch?.lastError
  };
}

function pullRequestWatchStatusLabel(watch: PullRequestWatchView) {
  if (!watch.active && !watch.refreshing) {
    return "";
  }
  if (watch.lastError) {
    return `Watch error: ${watch.lastError}`;
  }
  if (watch.refreshing) {
    return "Refreshing PR status...";
  }
  if (watch.lastRefreshedAt) {
    return `Watching in background - last refreshed ${formatDateTime(watch.lastRefreshedAt)}`;
  }
  return "Watching in background";
}

function TaskWorktreePullRequestCard({
  run,
  pullRequest,
  reviewPrompt,
  busy,
  watch,
  onAction,
  onToggleWatch,
  onDraftRemediation
}: {
  run: AgentTaskRun;
  pullRequest: AgentTaskRunWorktreePullRequest;
  reviewPrompt?: string;
  busy: boolean;
  watch: PullRequestWatchView;
  onAction: (run: AgentTaskRun, action: TaskWorktreeAction, options?: TaskWorktreeActionOptions) => void;
  onToggleWatch: (run: AgentTaskRun) => void;
  onDraftRemediation: (draftText: string, options?: DraftPromptOptions) => void;
}) {
  const watchStatus = pullRequestWatchStatusLabel(watch);
  return (
    <div className="task-worktree-pr">
      <div className="task-worktree-pr-heading">
        <GitPullRequest size={13} />
        <strong>{pullRequest.url ? "Pull request created" : "Pull request draft"}</strong>
        <span>{formatDateTime(pullRequest.createdAt ?? pullRequest.preparedAt)}</span>
      </div>
      <p>{pullRequest.title}</p>
      <div className="task-worktree-pr-meta">
        <span>{pullRequest.branch}</span>
        {pullRequest.baseBranch ? <span>base {pullRequest.baseBranch}</span> : null}
        {pullRequest.remoteName ? <span>remote {pullRequest.remoteName}</span> : null}
      </div>
      {pullRequest.pushCommand ? <code>{pullRequest.pushCommand}</code> : null}
      {pullRequest.createCommand ? <code>{pullRequest.createCommand}</code> : null}
      {pullRequest.url ? <code>{pullRequest.url}</code> : null}
      {pullRequest.review ? <TaskWorktreePullRequestReview review={pullRequest.review} /> : null}
      {pullRequest.url || reviewPrompt ? (
        <div className="task-worktree-pr-actions">
          {pullRequest.url ? (
            <button
              type="button"
              disabled={busy}
              title="Refresh this pull request's review and check status with GitHub CLI"
              onClick={() => onAction(run, "refresh_pr")}
            >
              <RefreshCw size={12} />
              Refresh PR
            </button>
          ) : null}
          {pullRequest.url ? (
            <button
              type="button"
              disabled={busy || watch.refreshing}
              title={
                watch.active
                  ? "Stop background refresh for this pull request"
                  : "Refresh this pull request in the background every 90 seconds"
              }
              onClick={() => onToggleWatch(run)}
            >
              {watch.refreshing ? <span className="pulse-dot" /> : <RefreshCw size={12} />}
              {watch.active ? "Watching" : "Watch PR"}
            </button>
          ) : null}
          {reviewPrompt ? (
            <button
              type="button"
              disabled={busy}
              title="Draft a prompt to review this PR and continue the task worktree"
              onClick={() =>
                onDraftRemediation(reviewPrompt, {
                  worktreeContinuation: { taskRunId: run.id, branch: run.worktree?.branch },
                  status: "Drafted PR review prompt for task worktree",
                  confirmLabel: "Replace the current composer draft with a PR review prompt for this task worktree?"
                })
              }
            >
              <Search size={12} />
              Review PR
            </button>
          ) : null}
        </div>
      ) : null}
      {watchStatus ? <small className={watch.lastError ? "task-worktree-pr-watch-status error" : "task-worktree-pr-watch-status"}>{watchStatus}</small> : null}
      {!pullRequest.createCommand ? <small>Add an origin remote and base branch before creating this PR with GitHub CLI.</small> : null}
    </div>
  );
}

function TaskWorktreePullRequestReview({ review }: { review: AgentTaskRunWorktreePullRequestReview }) {
  const readiness = buildTaskRunPullRequestReadiness(review);
  return (
    <div className="task-worktree-pr-review">
      <div className="task-worktree-pr-review-heading">
        <ListChecks size={12} />
        <strong>{review.summary}</strong>
      </div>
      <div className="task-worktree-pr-meta">
        {review.state ? <span>state {formatPrStatusToken(review.state)}</span> : null}
        {review.isDraft !== undefined ? <span>{review.isDraft ? "draft" : "ready for review"}</span> : null}
        {review.reviewDecision ? <span>review {formatPrStatusToken(review.reviewDecision)}</span> : null}
        {review.mergeStateStatus ? <span>merge {formatPrStatusToken(review.mergeStateStatus)}</span> : null}
        <span>{review.checkSummary}</span>
        <span>{formatDateTime(review.updatedAt)}</span>
      </div>
      <TaskWorktreePullRequestReadiness readiness={readiness} />
      {review.feedback ? <TaskWorktreePullRequestFeedback feedback={review.feedback} /> : null}
    </div>
  );
}

function TaskWorktreePullRequestReadiness({ readiness }: { readiness: AgentTaskRunPullRequestReadiness }) {
  return (
    <div className={`task-worktree-pr-readiness ${readiness.status}`}>
      {pullRequestReadinessIcon(readiness.status)}
      <strong>{readiness.label}</strong>
      <span>{readiness.summary}</span>
    </div>
  );
}

function TaskWorktreePullRequestFeedback({ feedback }: { feedback: AgentTaskRunWorktreePullRequestFeedback }) {
  return (
    <div className="task-worktree-pr-feedback">
      <div className="task-worktree-pr-feedback-heading">
        <MessageSquare size={12} />
        <strong>{feedback.summary}</strong>
      </div>
      {feedback.threadFetchError ? <p>Review thread details unavailable: {feedback.threadFetchError}</p> : null}
      {feedback.items.length > 0 ? (
        <ul>
          {feedback.items.map((item, index) => (
            <li key={`${item.kind}-${item.url ?? item.updatedAt ?? item.createdAt ?? index}`}>
              <span>{pullRequestFeedbackLabel(item)}</span>
              {item.body ? <p>{item.body}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function pullRequestFeedbackLabel(item: AgentTaskRunWorktreePullRequestFeedbackItem) {
  const parts = [
    item.kind === "review" ? "Review" : item.kind === "thread" ? "Thread" : "Comment",
    item.state ? formatPrStatusToken(item.state) : undefined,
    item.author ? `by ${item.author}` : undefined,
    item.path ? `at ${item.path}${item.line !== undefined ? `:${item.line}` : ""}` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.join(" ");
}

function pullRequestReadinessIcon(status: AgentTaskRunPullRequestReadiness["status"]) {
  switch (status) {
    case "ready":
      return <Check size={12} />;
    case "blocked":
      return <AlertTriangle size={12} />;
    default:
      return <Info size={12} />;
  }
}

function TaskRunMeta({ run, compact = false }: { run: AgentTaskRun; compact?: boolean }) {
  const capabilityLabels = run.capabilities.map(capabilityLabel);
  return (
    <div className={compact ? "task-run-meta compact" : "task-run-meta"}>
      <span className={`task-run-state ${activityStatusForTaskRun(run)}`}>{taskRunStatusLabel(run.status)}</span>
      {run.providerName || run.model ? (
        <span title={run.modelSelectionReason}>{[run.providerName, run.model].filter(Boolean).join(" - ")}</span>
      ) : null}
      {run.planMode?.enabled ? <span>Plan approval</span> : null}
      {run.loop?.enabled ? <span>Loop {run.loop.maxIterations} max</span> : null}
      {run.worktree?.enabled ? (
        <span title={run.worktree.path ?? run.worktree.error}>
          {run.worktree.replayOfTaskRunId
            ? `Replay ${run.worktree.branch ?? "worktree"} from ${shortRunId(run.worktree.replayOfTaskRunId)}`
            : run.worktree.continuedFromTaskRunId
            ? `Continued ${run.worktree.branch ?? "worktree"}`
            : run.worktree.plannedFromTaskRunId
              ? `Plan worktree ${shortRunId(run.worktree.plannedFromTaskRunId)}`
            : run.worktree.status === "ready"
              ? `Worktree ${run.worktree.branch ?? "ready"}`
              : `Worktree ${worktreeStatusLabel(run.worktree.status)}`}
        </span>
      ) : null}
      {capabilityLabels.length > 0 ? (
        <span>{compact ? capabilityLabels.slice(0, 3).join(", ") : capabilityLabels.join(", ")}</span>
      ) : (
        <span>No tools yet</span>
      )}
      {run.plan?.items.length ? <span>{run.plan.items.length} plan step{run.plan.items.length === 1 ? "" : "s"}</span> : null}
      {run.verification ? <span>{verificationMetaLabel(run.verification)}</span> : null}
      {run.artifacts.length > 0 ? <span>{run.artifacts.length} artifact{run.artifacts.length === 1 ? "" : "s"}</span> : null}
    </div>
  );
}

function TaskRunVerification({ verification }: { verification: AgentTaskRunVerification }) {
  const counters = [
    `${verification.commandCount} command${verification.commandCount === 1 ? "" : "s"}`,
    verification.failedCommandCount > 0 ? `${verification.failedCommandCount} failed exit${verification.failedCommandCount === 1 ? "" : "s"}` : null,
    verification.parsedReportCount > 0
      ? `${verification.parsedReportCount} report${verification.parsedReportCount === 1 ? "" : "s"}`
      : null,
    verification.failedReportCount > 0 ? `${verification.failedReportCount} failed report${verification.failedReportCount === 1 ? "" : "s"}` : null
  ].filter((counter): counter is string => Boolean(counter));

  return (
    <div className={`task-run-verification ${verification.status}`}>
      <div className="task-run-verification-heading">
        <Activity size={13} />
        <span>Verification</span>
        <strong>{verificationStatusLabel(verification.status)}</strong>
        <time>{formatDateTime(verification.updatedAt)}</time>
      </div>
      <p>{verification.summary}</p>
      {counters.length > 0 ? (
        <div className="task-run-verification-counters">
          {counters.map((counter) => (
            <span key={counter}>{counter}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TaskRunPlan({
  plan,
  planReview,
  approvalPrompt,
  worktreePrompt,
  canCreateWorktree,
  actionBusyKey,
  runId,
  onDraftApproval,
  onDraftWorktreeApproval,
  onPlanAction
}: {
  plan: NonNullable<AgentTaskRun["plan"]>;
  planReview?: AgentTaskRun["planReview"];
  approvalPrompt?: string;
  worktreePrompt?: string;
  canCreateWorktree?: boolean;
  actionBusyKey?: string | null;
  runId?: string;
  onDraftApproval?: (draftText: string) => void;
  onDraftWorktreeApproval?: (draftText: string) => void;
  onPlanAction?: (action: TaskRunPlanAction) => void;
}) {
  const reviewStatus = planReview?.status;
  const isPlanActionBusy = Boolean(runId && actionBusyKey?.startsWith(`${runId}:`));
  return (
    <div className="task-run-plan">
      <div className="task-run-plan-heading">
        <ListChecks size={13} />
        <span>Plan</span>
        <time>{formatDateTime(plan.updatedAt)}</time>
      </div>
      {planReview ? (
        <div className={`task-run-plan-review ${planReview.status}`}>
          <strong>{planReviewStatusLabel(planReview.status)}</strong>
          <span>{formatDateTime(planReview.updatedAt)}</span>
        </div>
      ) : null}
      {plan.summary ? <p>{plan.summary}</p> : null}
      <ol>
        {plan.items.map((item, index) => (
          <li key={`${item.text}-${index}`} className={item.status ? `status-${item.status}` : undefined}>
            <span>{planItemStatusLabel(item.status)}</span>
            <strong>{item.text}</strong>
          </li>
        ))}
      </ol>
      {onPlanAction && runId && reviewStatus !== "approved" ? (
        <div className="task-run-plan-actions">
          <button type="button" className="secondary-command" disabled={isPlanActionBusy} onClick={() => onPlanAction("approve")}>
            Approve
          </button>
          <button
            type="button"
            className="secondary-command"
            disabled={isPlanActionBusy}
            onClick={() => onPlanAction("request_revision")}
          >
            Revise
          </button>
          <button type="button" className="secondary-command" disabled={isPlanActionBusy} onClick={() => onPlanAction("cancel")}>
            Cancel
          </button>
        </div>
      ) : null}
      {approvalPrompt && onDraftApproval && reviewStatus === "approved" ? (
        <div className="task-run-plan-actions">
          <button type="button" className="secondary-command" onClick={() => onDraftApproval(approvalPrompt)}>
            Use approved plan
          </button>
          {worktreePrompt && onDraftWorktreeApproval ? (
            <button
              type="button"
              className="secondary-command"
              disabled={!canCreateWorktree}
              title={canCreateWorktree ? "Draft this approved plan and arm a new task worktree" : "Select a git project before using task worktrees"}
              onClick={() => onDraftWorktreeApproval(worktreePrompt)}
            >
              Start worktree
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function buildTaskRunPlanApprovalPrompt(run: AgentTaskRun, options: { worktree?: boolean } = {}) {
  if (!run.planMode?.enabled || !run.plan || (!run.plan.summary && run.plan.items.length === 0)) {
    return undefined;
  }
  const lines = [
    options.worktree
      ? `Proceed with the approved plan from Arivu task run ${run.id} in a new isolated task worktree.`
      : `Proceed with the approved plan from Arivu task run ${run.id}.`,
    options.worktree
      ? "Use the task worktree for edits and verification, while keeping the work scoped to the approved plan."
      : "Use normal tools, edits, and verification as needed now, while keeping the work scoped to the approved plan.",
    run.promptPreview ? `Original request: ${run.promptPreview}` : undefined,
    "",
    "Approved plan:",
    run.plan.summary ? `- Summary: ${run.plan.summary}` : undefined,
    ...run.plan.items.map((item, index) => `${index + 1}. ${item.text}`),
    "",
    "Before editing, re-check any relevant files if needed. After changes, run the first focused verification that fits the plan and summarize the result."
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

function ActivityRow({
  item,
  defaultCollapsed,
  evidenceOpenBusy,
  onOpenEvidence,
  onDraftRemediation
}: {
  item: ActivityItem;
  defaultCollapsed?: boolean;
  evidenceOpenBusy?: string | null;
  onOpenEvidence?: (link: ActivityEvidenceLink) => void;
  onDraftRemediation?: (draftText: string, options?: DraftPromptOptions) => void;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? item.kind === "system");
  const diff = item.diffPreview ?? buildActivityDiffPreview(item);
  const evidenceLinks = item.evidenceLinks ?? [];
  const showEvidenceActions =
    (evidenceLinks.length > 0 && onOpenEvidence) ||
    ((item.remediationPrompt || item.rollbackPrompt) && onDraftRemediation);

  return (
    <article className={activityRowClassName(item, collapsed)}>
      <button
        className="activity-title"
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((current) => !current)}
        title={collapsed ? "Expand details" : "Collapse details"}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span>{item.kind}</span>
        <strong>{item.title}</strong>
        {item.policy ? <ActivityPolicyChip policy={item.policy} /> : null}
        {item.status ? <span className={`activity-status ${item.status}`}>{activityStatusLabel(item.status)}</span> : null}
      </button>
      {!collapsed ? (
        <div className="activity-body">
          {item.summary ? <p className="activity-summary">{item.summary}</p> : null}
          {item.policy ? <ActivityPolicyDetails policy={item.policy} /> : null}
          {showEvidenceActions ? (
            <div className="activity-evidence-actions" aria-label="Task-run evidence actions">
              {onOpenEvidence
                ? evidenceLinks.map((link) => (
                    <button
                      key={link.id}
                      className="activity-evidence-button"
                      type="button"
                      disabled={evidenceOpenBusy === link.id}
                      title={link.title}
                      onClick={() => onOpenEvidence(link)}
                    >
                      <FileText size={13} />
                      <span>{evidenceOpenBusy === link.id ? "Opening..." : link.label}</span>
                    </button>
                  ))
                : null}
              {item.remediationPrompt && onDraftRemediation ? (
                <button
                  className="activity-evidence-button repair"
                  type="button"
                  title="Draft a repair prompt from this report evidence"
                  onClick={() => onDraftRemediation(item.remediationPrompt ?? "")}
                >
                  <Wrench size={13} />
                  <span>Draft fix</span>
                </button>
              ) : null}
              {item.rollbackPrompt && onDraftRemediation ? (
                <button
                  className="activity-evidence-button repair"
                  type="button"
                  title="Draft a revert prompt for this edit artifact"
                  onClick={() =>
                    onDraftRemediation(item.rollbackPrompt ?? "", {
                      status: "Drafted revert prompt from edit evidence",
                      confirmLabel: "Replace the current composer draft with a revert prompt from this edit evidence?"
                    })
                  }
                >
                  <RotateCcw size={13} />
                  <span>Draft revert</span>
                </button>
              ) : null}
            </div>
          ) : null}
          {item.imagePreview ? <ActivityScreenshotPreview preview={item.imagePreview} /> : null}
          {diff ? <DiffBlock preview={diff} /> : item.detail ? <pre>{item.detail}</pre> : null}
        </div>
      ) : null}
    </article>
  );
}

function ActivityPolicyChip({ policy, compact = false }: { policy: ActivityPolicyDetail; compact?: boolean }) {
  const label = compact ? activityPolicyShortLabel(policy) : activityPolicyLabel(policy);
  return (
    <span className={`activity-policy-chip ${policy.effect ?? "inferred"}`} title={activityPolicyTitle(policy)}>
      <Shield size={compact ? 10 : 11} />
      {label}
    </span>
  );
}

function ActivityPolicyDetails({ policy }: { policy: ActivityPolicyDetail }) {
  const metadata = [
    policy.trustMode ? `Trust: ${trustModeLabel(policy.trustMode)}` : undefined,
    policy.status ? `Audit: ${approvalStatusLabel(policy.status)}` : undefined,
    policy.effect ? `Effect: ${policyEffectLabel(policy.effect)}` : undefined,
    policy.override ? `Override: ${policy.override}` : undefined,
    policy.risky !== undefined ? `Risk: ${policy.risky ? "risky action" : "standard action"}` : undefined
  ].filter((item): item is string => Boolean(item));
  return (
    <div className={`activity-policy-detail ${policy.effect ?? "inferred"}`}>
      <div>
        <Shield size={13} />
        <span>{policy.capabilityLabel}</span>
        <strong>{activityPolicyLabel(policy)}</strong>
      </div>
      {policy.reason ? <p>{policy.reason}</p> : <p>{activityPolicyFallbackReason(policy)}</p>}
      {policy.summary ? <small>{policy.summary}</small> : null}
      {metadata.length > 0 ? (
        <div className="activity-policy-meta">
          {metadata.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function activityPolicyShortLabel(policy: ActivityPolicyDetail) {
  if (policy.effect) {
    return `${policy.capabilityLabel} · ${policyEffectLabel(policy.effect)}`;
  }
  return policy.capabilityLabel;
}

function activityPolicyLabel(policy: ActivityPolicyDetail) {
  if (policy.label && policy.effect) {
    return `${policy.label} · ${policyEffectLabel(policy.effect)}`;
  }
  if (policy.label) {
    return policy.label;
  }
  if (policy.effect) {
    return policyEffectLabel(policy.effect);
  }
  return policy.source === "inferred" ? "Inferred capability" : "Recorded capability";
}

function activityPolicyTitle(policy: ActivityPolicyDetail) {
  const lines = [
    `Capability: ${policy.capabilityLabel}`,
    policy.effect ? `Effect: ${policyEffectLabel(policy.effect)}` : undefined,
    policy.status ? `Audit: ${approvalStatusLabel(policy.status)}` : undefined,
    policy.trustMode ? `Trust mode: ${trustModeLabel(policy.trustMode)}` : undefined,
    policy.override ? `Workspace override: ${policy.override}` : undefined,
    policy.reason
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

function activityPolicyFallbackReason(policy: ActivityPolicyDetail) {
  if (policy.source === "inferred") {
    return "Capability was inferred from the tool name because this row was restored from transcript protocol.";
  }
  if (policy.source === "tool") {
    return "Capability was recorded on the task run; no matching approval audit was found for this tool call.";
  }
  return "Policy audit details were recorded on the task run.";
}

function LatestActivityScreenshot({ item }: { item: ActivityItem }) {
  if (!item.imagePreview) {
    return null;
  }

  return (
    <section className="activity-latest-screenshot" aria-label="Latest browser screenshot">
      <div className="activity-latest-heading">
        <ImageIcon size={13} />
        <span>Latest screenshot</span>
      </div>
      {item.summary ? <p>{item.summary}</p> : null}
      <ActivityScreenshotPreview preview={item.imagePreview} compact />
    </section>
  );
}

function ActivityScreenshotPreview({ preview, compact = false }: { preview: NonNullable<ActivityItem["imagePreview"]>; compact?: boolean }) {
  const [imageState, setImageState] = useState<{ src: string | null; failed: boolean }>({ src: null, failed: false });

  useEffect(() => {
    let cancelled = false;
    setImageState({ src: null, failed: false });

    if (/^(?:data|blob|https?|file):/i.test(preview.path)) {
      setImageState({ src: localImageSrc(preview.path), failed: false });
      return () => {
        cancelled = true;
      };
    }

    window.arivu
      .readLocalImage(preview.path)
      .then((image) => {
        if (!cancelled) {
          setImageState({ src: image.dataUrl, failed: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setImageState({ src: localImageSrc(preview.path), failed: false });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [preview.path]);

  return (
    <figure className={compact ? "activity-screenshot compact" : "activity-screenshot"}>
      {!imageState.failed && imageState.src ? (
        <img src={imageState.src} alt={preview.caption} onError={() => setImageState({ src: null, failed: true })} />
      ) : imageState.failed ? (
        <div className="activity-screenshot-missing">Screenshot file unavailable</div>
      ) : (
        <div className="activity-screenshot-loading">Loading screenshot...</div>
      )}
      <figcaption>{preview.caption}</figcaption>
    </figure>
  );
}

function activityRowClassName(item: ActivityItem, collapsed: boolean) {
  return [
    "activity-row",
    item.kind,
    item.status ? `status-${item.status}` : "",
    item.imagePreview ? "has-image-preview" : "",
    collapsed ? "collapsed" : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function activityStatusLabel(status: NonNullable<ActivityItem["status"]>) {
  if (status === "running") {
    return "Running";
  }
  if (status === "done") {
    return "Done";
  }
  if (status === "failed") {
    return "Failed";
  }
  return "Waiting";
}

function localImageSrc(filePath: string) {
  if (/^(?:data|blob|https?|file):/i.test(filePath)) {
    return filePath;
  }

  const normalized = filePath.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${normalized.split("/").map(encodeURIComponent).join("/")}`;
  }
  if (normalized.startsWith("/")) {
    return `file://${normalized.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
  }
  return normalized;
}

function DiffBlock({ preview }: { preview: DiffPreview }) {
  return (
    <div className="diff-block">
      <div className="diff-file">
        <FileText size={13} />
        <span>{preview.title}</span>
      </div>
      <div className="diff-lines">
        {preview.lines.map((line, index) => (
          <div key={`${line.kind}-${index}-${line.oldNumber ?? ""}-${line.newNumber ?? ""}`} className={`diff-line ${line.kind}`}>
            <span className="diff-number">{line.oldNumber ?? ""}</span>
            <span className="diff-number">{line.newNumber ?? ""}</span>
            <span className="diff-prefix">{diffPrefix(line.kind)}</span>
            <code>{line.text || " "}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildActivityDiffPreview(item: ActivityItem): DiffPreview | null {
  if (item.kind !== "call") {
    return null;
  }

  const args = parseToolArguments(item.detail);
  if (item.title === "apply_patch" && isRecord(args) && typeof args.diff === "string") {
    return parseUnifiedDiffPreview(args.diff);
  }

  if (item.title === "write_file" && isRecord(args) && typeof args.content === "string") {
    const path = typeof args.path === "string" ? args.path : "write_file";
    return {
      title: path,
      lines: splitLines(args.content).map((text, index) => ({
        kind: "add",
        newNumber: index + 1,
        text
      }))
    };
  }

  return null;
}

function parseToolArguments(detail: string): unknown {
  const parsed = parseMaybeJson(detail);
  if (typeof parsed === "string") {
    return parseMaybeJson(parsed) ?? parsed;
  }
  return parsed;
}

function parseUnifiedDiffPreview(diff: string): DiffPreview {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const preview: DiffPreview = { title: "patch", lines: [] };
  let oldNumber = 0;
  let newNumber = 0;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      preview.title = cleanDiffPath(line.slice(4).trim());
      continue;
    }
    if (line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNumber = Number(match?.[1] ?? 0);
      newNumber = Number(match?.[2] ?? 0);
      preview.lines.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      preview.lines.push({ kind: "add", newNumber, text: line.slice(1) });
      newNumber += 1;
      continue;
    }
    if (line.startsWith("-")) {
      preview.lines.push({ kind: "delete", oldNumber, text: line.slice(1) });
      oldNumber += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      preview.lines.push({ kind: "context", oldNumber, newNumber, text: line.slice(1) });
      oldNumber += 1;
      newNumber += 1;
    }
  }

  return preview;
}

function diffPrefix(kind: DiffLine["kind"]) {
  if (kind === "add") {
    return "+";
  }
  if (kind === "delete") {
    return "-";
  }
  return " ";
}

function SettingsView({
  state,
  skills,
  skillsRoot,
  focusSection,
  onFocusSettled,
  onSkillsChanged,
  onSaved,
  onStateUpdated
}: {
  state: DesktopState;
  skills: SkillSummary[];
  skillsRoot: string;
  focusSection: SettingsFocus;
  onFocusSettled: () => void;
  onSkillsChanged: (skills: SkillSummary[], skillsRoot: string) => void;
  onSaved: (state: DesktopState) => void;
  onStateUpdated: (state: DesktopState) => void;
}) {
  const initialProviders = providerFormsFromConfig(state.config);
  const [providers, setProviders] = useState<ProviderFormState[]>(initialProviders);
  const [activeProviderId, setActiveProviderId] = useState(
    state.config.activeProviderId && initialProviders.some((provider) => provider.id === state.config.activeProviderId)
      ? state.config.activeProviderId
      : initialProviders[0]?.id ?? "current"
  );
  const [tavilyApiKey, setTavilyApiKey] = useState("");
  const [trustMode, setTrustMode] = useState<TrustMode>(state.config.trustMode);
  const [mcpServersText, setMcpServersText] = useState(() => JSON.stringify(state.config.mcpServers ?? {}, null, 2));
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [doctorError, setDoctorError] = useState<string | null>(null);
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillInstructions, setSkillInstructions] = useState("");
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [skillStatus, setSkillStatus] = useState<string | null>(null);
  const [worktreeInventory, setWorktreeInventory] = useState<TaskWorktreeInventoryItem[]>([]);
  const [worktreeInventoryLoading, setWorktreeInventoryLoading] = useState(false);
  const [worktreeInventoryBusy, setWorktreeInventoryBusy] = useState<string | null>(null);
  const [worktreeInventoryError, setWorktreeInventoryError] = useState<string | null>(null);
  const [worktreeInventoryStatus, setWorktreeInventoryStatus] = useState<string | null>(null);
  const [capabilityPolicies, setCapabilityPolicies] = useState<CapabilityPolicySummary[]>([]);
  const [capabilityPolicyLoading, setCapabilityPolicyLoading] = useState(false);
  const [capabilityPolicyError, setCapabilityPolicyError] = useState<string | null>(null);
  const [capabilityPolicySource, setCapabilityPolicySource] = useState<CapabilityPolicyResult["source"]>("built-in");
  const [workspacePolicyOverrides, setWorkspacePolicyOverrides] = useState<WorkspaceCapabilityPolicyOverrides>(() =>
    workspacePolicyOverridesFromConfig(state.config.workspacePolicies, state.workspace.root)
  );
  const skillsSectionRef = useRef<HTMLElement | null>(null);
  const selectedProvider = providers.find((provider) => provider.id === activeProviderId) ?? providers[0];
  const baseUrl = selectedProvider?.baseUrl ?? state.config.baseUrl;
  const model = selectedProvider?.model ?? state.config.model;
  const apiKey = selectedProvider?.apiKey ?? "";
  const selectedProviderApiKeyPresent = Boolean(selectedProvider?.apiKeyPresent || apiKey.trim());

  useEffect(() => {
    if (focusSection !== "skills") {
      return;
    }
    requestAnimationFrame(() => skillsSectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
    onFocusSettled();
  }, [focusSection, onFocusSettled]);

  useEffect(() => {
    void refreshTaskWorktrees();
    void refreshCapabilityPolicies();
  }, []);

  function updateSelectedProvider(patch: Partial<ProviderFormState>) {
    setProviders((current) =>
      current.map((provider) => (provider.id === activeProviderId ? { ...provider, ...patch } : provider))
    );
  }

  function addProvider() {
    const name = uniqueProviderName(NEW_PROVIDER_NAME, providers);
    const nextProvider: ProviderFormState = {
      id: uniqueProviderId(name, providers),
      name,
      baseUrl: "",
      model: "",
      apiKey: ""
    };
    setProviders((current) => [...current, nextProvider]);
    setActiveProviderId(nextProvider.id);
  }

  function removeSelectedProvider() {
    if (providers.length <= 1 || !selectedProvider) {
      return;
    }
    const nextProviders = providers.filter((provider) => provider.id !== selectedProvider.id);
    setProviders(nextProviders);
    setActiveProviderId(nextProviders[0]?.id ?? "current");
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const mcpServers = parseMcpServersText(mcpServersText);
      const providerPatch = validateProviderForms(providers, activeProviderId);
      const patch: ConfigPatch = {
        activeProviderId: providerPatch.activeProviderId,
        providers: providerPatch.providers,
        baseUrl: providerPatch.activeProvider.baseUrl,
        model: providerPatch.activeProvider.model,
        trustMode,
        mcpServers,
        workspacePolicies: updateWorkspacePoliciesForRoot(state.config.workspacePolicies, state.workspace.root, workspacePolicyOverrides)
      };
      if (providerPatch.activeProvider.apiKey?.trim()) {
        patch.apiKey = providerPatch.activeProvider.apiKey.trim();
      }
      if (tavilyApiKey.trim()) {
        patch.tavilyApiKey = tavilyApiKey.trim();
      }
      const next = await window.arivu.saveConfig(patch);
      onSaved(next);
      const policyResult = await window.arivu.listCapabilityPolicies();
      setCapabilityPolicies(policyResult.policies);
      setCapabilityPolicySource(policyResult.source);
      setWorkspacePolicyOverrides(policyResult.workspaceOverrides);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  async function runSettingsDoctor() {
    if (isAutoModelId(model)) {
      setDoctorReport(null);
      setDoctorError("Doctor checks need a concrete model. Save Auto, then test routing from chat.");
      return;
    }
    setDoctorRunning(true);
    setDoctorError(null);
    try {
      const report = await window.arivu.runDoctor({
        baseUrl,
        model,
        apiKey: apiKey.trim() || undefined,
        tavilyApiKey: tavilyApiKey.trim() || undefined,
        trustMode
      });
      setDoctorReport(report);
    } catch (err) {
      setDoctorError(formatError(err));
    } finally {
      setDoctorRunning(false);
    }
  }

  async function refreshSkills() {
    setSkillError(null);
    setSkillStatus(null);
    try {
      const result = await window.arivu.listSkills();
      onSkillsChanged(result.skills, result.skillsRoot);
      setSkillStatus("Skills refreshed");
    } catch (err) {
      setSkillError(formatError(err));
    }
  }

  async function addSkill() {
    setSkillSaving(true);
    setSkillError(null);
    setSkillStatus(null);
    try {
      const result = await window.arivu.createSkill({
        name: skillName,
        description: skillDescription,
        instructions: skillInstructions
      });
      onSkillsChanged(result.skills, result.skillsRoot);
      setSkillName("");
      setSkillDescription("");
      setSkillInstructions("");
      setSkillStatus(`Added $${result.skill.name}`);
    } catch (err) {
      setSkillError(formatError(err));
    } finally {
      setSkillSaving(false);
    }
  }

  async function refreshTaskWorktrees(showStatus = false) {
    setWorktreeInventoryLoading(true);
    setWorktreeInventoryError(null);
    try {
      const result = await window.arivu.listTaskWorktrees();
      setWorktreeInventory(result.worktrees);
      if (showStatus) {
        setWorktreeInventoryStatus("Task worktrees refreshed");
      }
    } catch (err) {
      setWorktreeInventoryError(formatError(err));
    } finally {
      setWorktreeInventoryLoading(false);
    }
  }

  async function refreshCapabilityPolicies() {
    setCapabilityPolicyLoading(true);
    setCapabilityPolicyError(null);
    try {
      const result = await window.arivu.listCapabilityPolicies();
      setCapabilityPolicies(result.policies);
      setCapabilityPolicySource(result.source);
      setWorkspacePolicyOverrides(result.workspaceOverrides);
    } catch (err) {
      setCapabilityPolicyError(formatError(err));
    } finally {
      setCapabilityPolicyLoading(false);
    }
  }

  async function openInventoryWorktree(item: TaskWorktreeInventoryItem) {
    await runInventoryWorktreeAction(item, "open");
  }

  async function runInventoryWorktreeAction(item: TaskWorktreeInventoryItem, action: TaskWorktreeAction) {
    if (!["open", "discard", "cleanup", "prepare_pr", "create_pr"].includes(action)) {
      return;
    }
    if (action !== "open" && !confirmInventoryWorktreeAction(item, action)) {
      return;
    }
    const busyKey = `${item.sessionId}:${item.taskRunId}:${action}`;
    setWorktreeInventoryBusy(busyKey);
    setWorktreeInventoryError(null);
    setWorktreeInventoryStatus(null);
    try {
      const next = await window.arivu.taskWorktreeAction({
        sessionId: item.sessionId,
        taskRunId: item.taskRunId,
        action
      });
      if (action !== "open") {
        onStateUpdated(next);
        await refreshTaskWorktrees();
      }
      setWorktreeInventoryStatus(taskWorktreeActionStatus(action));
    } catch (err) {
      setWorktreeInventoryError(formatError(err));
    } finally {
      setWorktreeInventoryBusy((current) => (current === busyKey ? null : current));
    }
  }

  return (
    <section className="settings-panel">
      <div className="settings-grid">
        <label className="provider-field">
          <span>LLM provider</span>
          <div className="provider-picker">
            <select value={activeProviderId} onChange={(event) => setActiveProviderId(event.target.value)}>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name.trim() || "Unnamed provider"}
                </option>
              ))}
            </select>
            <button className="secondary-command" type="button" onClick={addProvider}>
              <Plus size={15} />
              Add provider
            </button>
            <button className="icon-button compact-icon-button" type="button" onClick={removeSelectedProvider} disabled={providers.length <= 1} title="Remove provider" aria-label="Remove provider">
              <Trash2 size={14} />
            </button>
          </div>
          <small className="field-note">Save multiple OpenAI-compatible providers and switch the active runtime here.</small>
        </label>
        <label>
          <span>Provider name</span>
          <input value={selectedProvider?.name ?? ""} onChange={(event) => updateSelectedProvider({ name: event.target.value })} />
        </label>
        <label className="base-url-field">
          <span>Base URL</span>
          <input value={baseUrl} onChange={(event) => updateSelectedProvider({ baseUrl: event.target.value })} />
        </label>
        <label className="model-field">
          <span>Model</span>
          <div className="model-picker">
            <button className="model-dialog-trigger settings-model-trigger" type="button" onClick={() => setModelDialogOpen(true)}>
              <Cpu size={15} />
              <span>{modelDisplayName(model)}</span>
              <Search size={13} />
            </button>
          </div>
          <input value={model} onChange={(event) => updateSelectedProvider({ model: event.target.value })} placeholder="Enter model id" />
          <small className="field-note">Choose Auto, use search, or enter a model id manually.</small>
        </label>
        <label className="api-key-field">
          <span>API key</span>
          <input
            value={apiKey}
            onChange={(event) => updateSelectedProvider({ apiKey: event.target.value })}
            type="password"
            placeholder={selectedProviderApiKeyPresent ? "Saved. Enter a new key to replace it." : "No key saved for this provider."}
          />
        </label>
        <label className="tavily-key-field">
          <span>Tavily API key</span>
          <input
            value={tavilyApiKey}
            onChange={(event) => setTavilyApiKey(event.target.value)}
            type="password"
            placeholder={state.config.tavilyApiKeyPresent ? "Saved. Enter a new key to replace it." : "No Tavily key saved."}
          />
        </label>
        <label>
          <span>Trust mode</span>
          <select value={trustMode} onChange={(event) => setTrustMode(event.target.value as TrustMode)}>
            <option value="ask">ask</option>
            <option value="readonly">readonly</option>
            <option value="trusted">trusted</option>
          </select>
        </label>
      </div>

      <CapabilityPolicyPanel
        activeTrustMode={trustMode}
        policies={capabilityPolicies}
        source={capabilityPolicySource}
        workspaceRoot={state.workspace.root}
        workspaceOverrides={workspacePolicyOverrides}
        onWorkspaceOverrideChange={(capability, override) =>
          setWorkspacePolicyOverrides((current) => updateWorkspacePolicyOverride(current, capability, override))
        }
        loading={capabilityPolicyLoading}
        error={capabilityPolicyError}
        onRefresh={() => void refreshCapabilityPolicies()}
      />

      <label className="mcp-config-field">
        <span>MCP servers</span>
        <textarea
          value={mcpServersText}
          onChange={(event) => setMcpServersText(event.target.value)}
          spellCheck={false}
          rows={8}
        />
        <small className="field-note">
          JSON object keyed by server name. Each server supports command, args, env, and disabled.
        </small>
      </label>

      <section className="skills-settings-section" ref={skillsSectionRef} aria-label="Skills">
        <div className="settings-section-heading">
          <div>
            <strong>Skills</strong>
            <span title={skillsRoot}>{skills.length} installed · {skillsRoot || "Global skills directory"}</span>
          </div>
          <button className="secondary-command" type="button" onClick={() => void refreshSkills()}>
            <RefreshCw size={15} />
            Refresh
          </button>
        </div>

        <div className="settings-skill-list">
          {skills.length === 0 ? (
            <div className="settings-skill-empty">No skills installed yet.</div>
          ) : (
            skills.map((skill) => (
              <article key={skill.name} className="settings-skill-row">
                <div>
                  <code>${skill.name}</code>
                  <strong>{skill.title}</strong>
                </div>
                {skill.description ? <p>{skill.description}</p> : null}
                <small>{skill.path}</small>
              </article>
            ))
          )}
        </div>

        <div className="skill-add-form">
          <label>
            <span>Name</span>
            <input value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder="code-review" />
          </label>
          <label>
            <span>Description</span>
            <input value={skillDescription} onChange={(event) => setSkillDescription(event.target.value)} placeholder="When this skill should be used" />
          </label>
          <label className="skill-instructions-field">
            <span>Instructions</span>
            <textarea
              value={skillInstructions}
              onChange={(event) => setSkillInstructions(event.target.value)}
              placeholder="Write the instructions Codex should follow for this skill."
              rows={6}
            />
          </label>
          <button
            className="secondary-command skill-add-button"
            type="button"
            onClick={() => void addSkill()}
            disabled={skillSaving || !skillName.trim() || !skillInstructions.trim()}
          >
            <Plus size={16} />
            {skillSaving ? "Adding" : "Add skill"}
          </button>
        </div>
        {skillError ? <div className="error-strip">{skillError}</div> : null}
        {skillStatus ? <div className="success-strip">{skillStatus}</div> : null}
      </section>

      <section className="skills-settings-section" aria-label="Task worktrees">
        <div className="settings-section-heading">
          <div>
            <strong>Task worktrees</strong>
            <span>{taskWorktreeInventorySummary(worktreeInventory)}</span>
          </div>
          <button className="secondary-command" type="button" onClick={() => void refreshTaskWorktrees(true)} disabled={worktreeInventoryLoading}>
            <RefreshCw size={15} />
            {worktreeInventoryLoading ? "Refreshing" : "Refresh"}
          </button>
        </div>

        <div className="settings-worktree-list">
          {worktreeInventory.length === 0 ? (
            <div className="settings-skill-empty">No task worktrees recorded yet.</div>
          ) : (
            worktreeInventory.map((item) => {
              const busyKey = `${item.sessionId}:${item.taskRunId}:open`;
              return (
                <article key={`${item.sessionId}:${item.taskRunId}`} className="settings-worktree-row">
                  <div className="settings-worktree-main">
                    <div>
                      <strong>{item.branch ?? "Task worktree"}</strong>
                      <span>{worktreeInventoryStatusLabel(item)}</span>
                    </div>
                    <p>{item.promptPreview || item.sessionTitle}</p>
                    {item.path ? <small title={item.path}>{item.path}</small> : null}
                  </div>
                  <div className="settings-worktree-meta">
                    <span>{item.changedFiles === undefined ? "diff unknown" : `${item.changedFiles} changed`}</span>
                    {item.verificationStatus ? (
                      <span title={item.verificationSummary}>{`verification ${verificationStatusLabel(item.verificationStatus).toLowerCase()}`}</span>
                    ) : null}
                    <span>{formatDateTime(item.updatedAt)}</span>
                  </div>
                  <div className="settings-worktree-actions">
                    <button
                      className="secondary-command"
                      type="button"
                      onClick={() => void openInventoryWorktree(item)}
                      disabled={!item.canOpen || worktreeInventoryBusy === busyKey}
                      title={item.canOpen ? "Open this task worktree folder" : "Task worktree folder is unavailable"}
                    >
                      <FolderOpen size={15} />
                      {worktreeInventoryBusy === busyKey ? "Opening" : "Open"}
                    </button>
                    {item.canPreparePullRequest ? (
                      <button
                        className="secondary-command"
                        type="button"
                        onClick={() => void runInventoryWorktreeAction(item, "prepare_pr")}
                        disabled={worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:prepare_pr`}
                        title="Prepare a pull request draft for this task worktree"
                      >
                        <GitPullRequest size={15} />
                        {worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:prepare_pr` ? "Preparing" : "PR draft"}
                      </button>
                    ) : null}
                    {item.canCreatePullRequest ? (
                      <button
                        className="secondary-command"
                        type="button"
                        onClick={() => void runInventoryWorktreeAction(item, "create_pr")}
                        disabled={worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:create_pr`}
                        title="Push this task branch and create a draft pull request"
                      >
                        <GitPullRequest size={15} />
                        {worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:create_pr` ? "Creating" : "Create PR"}
                      </button>
                    ) : null}
                    {item.canDiscard ? (
                      <button
                        className="secondary-command danger-command"
                        type="button"
                        onClick={() => void runInventoryWorktreeAction(item, "discard")}
                        disabled={worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:discard`}
                        title="Discard this task worktree and task branch"
                      >
                        <Trash2 size={15} />
                        {worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:discard` ? "Discarding" : "Discard"}
                      </button>
                    ) : null}
                    {item.canCleanup ? (
                      <button
                        className="secondary-command"
                        type="button"
                        onClick={() => void runInventoryWorktreeAction(item, "cleanup")}
                        disabled={worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:cleanup`}
                        title="Clean up this merged task worktree and task branch"
                      >
                        <Scissors size={15} />
                        {worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:cleanup` ? "Cleaning" : "Clean up"}
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })
          )}
        </div>
        {worktreeInventoryError ? <div className="error-strip">{worktreeInventoryError}</div> : null}
        {worktreeInventoryStatus ? <div className="success-strip">{worktreeInventoryStatus}</div> : null}
      </section>

      {error ? <div className="error-strip">{error}</div> : null}
      {doctorError ? <div className="error-strip">{doctorError}</div> : null}

      <div className="settings-actions">
        <button className="save-button" type="button" onClick={() => void save()} disabled={saving}>
          <Save size={17} />
          {saving ? "Saving" : "Save settings"}
        </button>
        <button className="secondary-command doctor-button" type="button" onClick={() => void runSettingsDoctor()} disabled={doctorRunning}>
          <RefreshCw size={17} />
          {doctorRunning ? "Checking" : "Run doctor"}
        </button>
      </div>

      {doctorReport ? <DoctorReportView report={doctorReport} /> : null}
      {modelDialogOpen ? (
        <ModelPickerDialog
          currentModel={model}
          baseUrl={baseUrl}
          apiKey={apiKey}
          onSelect={(nextModel) => {
            updateSelectedProvider({ model: nextModel });
            setModelDialogOpen(false);
          }}
          onClose={() => setModelDialogOpen(false)}
        />
      ) : null}
    </section>
  );
}

function CapabilityPolicyPanel({
  activeTrustMode,
  policies,
  source,
  workspaceRoot,
  workspaceOverrides,
  onWorkspaceOverrideChange,
  loading,
  error,
  onRefresh
}: {
  activeTrustMode: TrustMode;
  policies: CapabilityPolicySummary[];
  source: CapabilityPolicyResult["source"];
  workspaceRoot: string;
  workspaceOverrides: WorkspaceCapabilityPolicyOverrides;
  onWorkspaceOverrideChange: (capability: WorkspacePolicyCapability, override: CapabilityPolicyOverrideEffect | "inherit") => void;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <section className="skills-settings-section policy-settings-section" aria-label="Capability policy">
      <div className="settings-section-heading">
        <div>
          <strong>Capability policy</strong>
          <span>{capabilityPolicySummary(policies, activeTrustMode, source, loading)}</span>
        </div>
        <button className="secondary-command" type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} />
          {loading ? "Refreshing" : "Refresh"}
        </button>
      </div>

      {error ? <div className="error-strip">{error}</div> : null}

      <div className="workspace-policy-box">
        <div className="workspace-policy-heading">
          <div>
            <strong>Workspace overrides</strong>
            <span title={workspaceRoot}>{workspaceRoot}</span>
          </div>
          <p>
            Tighten this workspace without changing the built-in {trustModeLabel(activeTrustMode)} posture.
          </p>
        </div>
        <div className="workspace-policy-grid">
          {WORKSPACE_POLICY_CAPABILITIES.map((capability) => {
            const override = workspaceOverrides[capability] ?? "inherit";
            const policy = policies.find((entry) => entry.capability === capability);
            return (
              <label key={capability} className="workspace-policy-row">
                <span>{capabilityLabel(capability)}</span>
                <select
                  value={override}
                  onChange={(event) =>
                    onWorkspaceOverrideChange(capability, event.target.value as CapabilityPolicyOverrideEffect | "inherit")
                  }
                >
                  <option value="inherit">Inherit</option>
                  <option value="prompt">Require approval</option>
                  <option value="deny">Block</option>
                </select>
                <small>{workspaceOverrideNote(policy, activeTrustMode, override)}</small>
              </label>
            );
          })}
        </div>
        <small>Overrides only make this workspace stricter: they cannot turn a built-in approval or block into allow.</small>
      </div>

      <div className="policy-table-wrap">
        <table className="policy-table">
          <thead>
            <tr>
              <th scope="col">Capability</th>
              {TRUST_MODE_ORDER.map((mode) => (
                <th key={mode} scope="col" className={mode === activeTrustMode ? "active-policy-column" : undefined}>
                  {trustModeLabel(mode)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {policies.length === 0 ? (
              <tr>
                <td colSpan={TRUST_MODE_ORDER.length + 1} className="policy-empty">
                  {loading ? "Loading policy" : "No policy loaded"}
                </td>
              </tr>
            ) : (
              policies.map((policy) => (
                <tr key={policy.capability}>
                  <th scope="row">
                    <strong>{policy.label}</strong>
                    <span>{policy.description}</span>
                    <p className="policy-capability-risk">{policy.risk}</p>
                    <ul className="policy-example-list" aria-label={`${policy.label} examples`}>
                      {policy.examples.map((example) => (
                        <li key={example}>{example}</li>
                      ))}
                    </ul>
                    <small className="policy-default-posture">{policy.defaultPosture}</small>
                  </th>
                  {TRUST_MODE_ORDER.map((mode) => (
                    <PolicyModeCell key={`${policy.capability}:${mode}`} policy={policy} mode={mode} active={mode === activeTrustMode} />
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PolicyModeCell({ policy, mode, active }: { policy: CapabilityPolicySummary; mode: TrustMode; active: boolean }) {
  const summary = policy.modes.find((entry) => entry.trustMode === mode);
  if (!summary) {
    return <td className={active ? "active-policy-column" : undefined}>-</td>;
  }
  return (
    <td className={active ? "active-policy-column" : undefined}>
      <div className="policy-cell">
        <PolicyEffectBadge effect={summary.effect} />
        <span>{summary.label}</span>
        <small title={summary.reason}>Why: {summary.reason}</small>
        {summary.override ? (
          <small className="policy-override-note">
            Workspace override: {summary.override === "deny" ? "blocked" : "approval required"}
          </small>
        ) : null}
        {summary.riskyEffect ? (
          <small className="policy-risk-note" title={summary.riskyReason}>
            Risky action: {policyEffectLabel(summary.riskyEffect)}
          </small>
        ) : null}
      </div>
    </td>
  );
}

function PolicyEffectBadge({ effect }: { effect: CapabilityPolicyEffect }) {
  return <span className={`policy-effect-badge ${effect}`}>{policyEffectLabel(effect)}</span>;
}

function workspacePolicyOverridesFromConfig(policies: WorkspaceCapabilityPolicies, workspaceRoot: string): WorkspaceCapabilityPolicyOverrides {
  return policies[workspaceRoot]?.overrides ?? {};
}

function updateWorkspacePolicyOverride(
  overrides: WorkspaceCapabilityPolicyOverrides,
  capability: WorkspacePolicyCapability,
  override: CapabilityPolicyOverrideEffect | "inherit"
): WorkspaceCapabilityPolicyOverrides {
  const next = { ...overrides };
  if (override === "inherit") {
    delete next[capability];
  } else {
    next[capability] = override;
  }
  return next;
}

function updateWorkspacePoliciesForRoot(
  policies: WorkspaceCapabilityPolicies,
  workspaceRoot: string,
  overrides: WorkspaceCapabilityPolicyOverrides
): WorkspaceCapabilityPolicies {
  const next = { ...policies };
  const normalized = Object.fromEntries(
    Object.entries(overrides).filter((entry): entry is [WorkspacePolicyCapability, CapabilityPolicyOverrideEffect] =>
      WORKSPACE_POLICY_CAPABILITIES.includes(entry[0] as WorkspacePolicyCapability) && (entry[1] === "prompt" || entry[1] === "deny")
    )
  );
  if (Object.keys(normalized).length === 0) {
    delete next[workspaceRoot];
  } else {
    next[workspaceRoot] = { overrides: normalized };
  }
  return next;
}

function capabilityPolicySummary(
  policies: CapabilityPolicySummary[],
  activeTrustMode: TrustMode,
  source: CapabilityPolicyResult["source"],
  loading: boolean
) {
  if (loading && policies.length === 0) {
    return "Loading policy";
  }
  const counts = { allow: 0, prompt: 0, deny: 0 };
  for (const policy of policies) {
    const mode = policy.modes.find((entry) => entry.trustMode === activeTrustMode);
    if (mode) {
      counts[mode.effect] += 1;
    }
  }
  const sourceLabel = source === "built-in" ? "built-in" : "workspace overrides";
  return `${trustModeLabel(activeTrustMode)} · ${counts.allow} allowed · ${counts.prompt} approval · ${counts.deny} blocked · ${sourceLabel}`;
}

function workspaceOverrideNote(
  policy: CapabilityPolicySummary | undefined,
  activeTrustMode: TrustMode,
  override: CapabilityPolicyOverrideEffect | "inherit"
) {
  if (override === "deny") {
    return "Blocked for this workspace.";
  }
  if (override === "prompt") {
    return "Requires approval for this workspace.";
  }
  const mode = policy?.modes.find((entry) => entry.trustMode === activeTrustMode);
  if (!mode) {
    return "Follows the selected trust mode.";
  }
  return `Inherits ${policyEffectLabel(mode.effect).toLowerCase()} from ${trustModeLabel(activeTrustMode)}.`;
}

function trustModeLabel(mode: TrustMode) {
  switch (mode) {
    case "readonly":
      return "Readonly";
    case "ask":
      return "Ask";
    case "trusted":
      return "Trusted";
  }
}

function policyEffectLabel(effect: CapabilityPolicyEffect) {
  switch (effect) {
    case "allow":
      return "Allow";
    case "prompt":
      return "Approval";
    case "deny":
      return "Blocked";
  }
}

function DoctorReportView({ report }: { report: DoctorReport }) {
  return (
    <section className="doctor-report">
      <div className="doctor-report-heading">
        <strong>Doctor</strong>
        <span>
          {report.summary.pass} pass, {report.summary.warn} warn, {report.summary.fail} fail, {report.summary.skip} skip
        </span>
      </div>
      <div className="doctor-checks">
        {report.checks.map((entry) => (
          <article key={entry.id} className={`doctor-check ${entry.status}`}>
            <span className="doctor-status">{entry.status}</span>
            <div>
              <strong>{entry.label}</strong>
              <p>{entry.message}</p>
              {entry.detail ? <pre>{entry.detail}</pre> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ApprovalDialog({ approval, onRespond }: { approval: ApprovalRequest; onRespond: (approved: boolean) => void }) {
  const view = parseApprovalMessage(approval.message);

  return (
    <div className="modal-backdrop">
      <section className="approval-dialog rich-approval-dialog" role="dialog" aria-modal="true" aria-label="Approval required">
        <div className="approval-header">
          <div className="approval-icon">
            <Shield size={24} />
          </div>
          <div>
            <h2>Approval required</h2>
            <p>{approvalSubtitle(view)}</p>
          </div>
        </div>
        <ApprovalContent view={view} fallback={approval.message} />
        <div className="approval-actions">
          <button type="button" className="deny-button" onClick={() => onRespond(false)}>
            <X size={17} />
            Deny
          </button>
          <button type="button" className="approve-button" onClick={() => onRespond(true)}>
            <Check size={17} />
            Approve
          </button>
        </div>
      </section>
    </div>
  );
}

function ApprovalContent({ view, fallback }: { view: ApprovalView; fallback: string }) {
  if (view.type === "shell") {
    return (
      <div className="approval-detail shell-approval">
        <div className="shell-command-card">
          <code className="shell-command-text">{view.command}</code>
        </div>
        {view.cwd ? (
          <div className="shell-meta">
            <TerminalSquare size={14} />
            <span>{view.cwd}</span>
          </div>
        ) : null}
        {view.warnings.length > 0 ? (
          <div className="danger-badges">
            {view.warnings.map((warning) => (
              <span key={warning} className="danger-badge">
                <AlertTriangle size={13} />
                {warning}
              </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

  if (view.type === "write" && view.diff) {
    return (
      <div className="approval-detail">
        <div className="write-summary">{view.summary}</div>
        <SideBySideDiffView diff={view.diff} />
      </div>
    );
  }

  if (view.type === "browser") {
    return (
      <div className="approval-detail browser-approval">
        <div className="browser-approval-card">
          <Globe size={16} />
          <div>
            <strong>{view.action}</strong>
            <span>{view.target}</span>
          </div>
        </div>
        {view.mode ? <span className="browser-approval-mode">{view.mode}</span> : null}
      </div>
    );
  }

  if (view.type === "network") {
    return (
      <div className="approval-detail browser-approval">
        <div className="browser-approval-card">
          <Globe size={16} />
          <div>
            <strong>{view.summary}</strong>
            <span>{view.destination ?? "Network"}</span>
          </div>
        </div>
        {view.query ? <pre>{view.query}</pre> : null}
      </div>
    );
  }

  return <pre>{fallback}</pre>;
}

function SideBySideDiffView({ diff }: { diff: SideBySideDiff }) {
  return (
    <div className="side-diff">
      <div className="side-diff-title">
        <FileText size={14} />
        <span>{diff.title}</span>
      </div>
      <div className="side-diff-grid">
        <div className="side-diff-heading">Original</div>
        <div className="side-diff-heading">Modified</div>
        {diff.rows.map((row, index) =>
          row.kind === "meta" ? (
            <div key={`meta-${index}`} className="side-diff-meta">
              {row.label}
            </div>
          ) : (
            <div key={`row-${index}-${row.oldNumber ?? ""}-${row.newNumber ?? ""}`} className="side-diff-row">
              <div className={`side-diff-cell old ${row.kind}`}>
                <span className="side-diff-number">{row.oldNumber ?? ""}</span>
                <code>{row.left ?? ""}</code>
              </div>
              <div className={`side-diff-cell new ${row.kind}`}>
                <span className="side-diff-number">{row.newNumber ?? ""}</span>
                <code>{row.right ?? ""}</code>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function approvalSubtitle(view: ApprovalView) {
  if (view.type === "shell") {
    return view.destructive ? "Review this command before it runs." : "Review this command before it runs.";
  }
  if (view.type === "write") {
    return view.destructive ? "Review the proposed file change." : "Review the proposed file change.";
  }
  if (view.type === "browser") {
    return view.destructive ? "Review this browser action." : "Review this browser read.";
  }
  if (view.type === "network") {
    return "Review this network request before it leaves the machine.";
  }
  return "The agent wants to perform an action that changes state or runs a command.";
}

function PasteReviewDialog({
  review,
  onCancel,
  onInsertFull,
  onInsertTruncated
}: {
  review: PasteReview;
  onCancel: () => void;
  onInsertFull: () => void;
  onInsertTruncated: () => void;
}) {
  const canInsertTruncated = review.truncatedText.length > 0;

  return (
    <div className="modal-backdrop">
      <section className="approval-dialog paste-dialog" role="dialog" aria-modal="true" aria-label="Large paste detected">
        <div className="approval-icon paste-icon">
          <Scissors size={24} />
        </div>
        <h2>Large paste detected</h2>
        <p>
          The full prompt is estimated at {formatNumber(review.fullPromptTokens)} tokens. The composer budget is{" "}
          {formatNumber(review.budget)} tokens.
        </p>
        <div className="paste-stats">
          <div>
            <span>Pasted text</span>
            <strong>{formatNumber(review.pastedTokens)} tokens</strong>
          </div>
          <div>
            <span>Truncated prompt</span>
            <strong>{canInsertTruncated ? `${formatNumber(review.truncatedPromptTokens)} tokens` : "No room left"}</strong>
          </div>
        </div>
        <div className="approval-actions">
          <button type="button" className="deny-button" onClick={onCancel}>
            <X size={17} />
            Cancel
          </button>
          <button type="button" className="deny-button" onClick={onInsertFull}>
            <Check size={17} />
            Insert full
          </button>
          <button type="button" className="approve-button" onClick={onInsertTruncated} disabled={!canInsertTruncated}>
            <Scissors size={17} />
            Insert truncated
          </button>
        </div>
      </section>
    </div>
  );
}

function WorkspaceScaffoldDialog({
  onCancel,
  onCreate
}: {
  onCancel: () => void;
  onCreate: (options: WorkspaceScaffoldOptions) => void;
}) {
  const [options, setOptions] = useState<Required<WorkspaceScaffoldOptions>>({
    initGit: false,
    npmPackage: false,
    typescript: false
  });

  function toggle(key: keyof WorkspaceScaffoldOptions) {
    setOptions((current) => ({
      ...current,
      [key]: !current[key]
    }));
  }

  return (
    <div className="modal-backdrop">
      <section className="approval-dialog workspace-scaffold-dialog" role="dialog" aria-modal="true" aria-label="Create workspace">
        <div className="approval-header">
          <div className="approval-icon paste-icon">
            <FolderPlus size={24} />
          </div>
          <div>
            <h2>Create workspace</h2>
            <p>Choose the starter files to create after selecting a folder.</p>
          </div>
        </div>
        <div className="scaffold-options">
          <label className="check-option">
            <input type="checkbox" checked={options.initGit} onChange={() => toggle("initGit")} />
            <span>
              <strong>Git repository</strong>
              <small>Run git init in the new workspace.</small>
            </span>
          </label>
          <label className="check-option">
            <input type="checkbox" checked={options.npmPackage} onChange={() => toggle("npmPackage")} />
            <span>
              <strong>npm package</strong>
              <small>Create package.json with starter scripts.</small>
            </span>
          </label>
          <label className="check-option">
            <input type="checkbox" checked={options.typescript} onChange={() => toggle("typescript")} />
            <span>
              <strong>TypeScript</strong>
              <small>Create tsconfig.json and src/index.ts.</small>
            </span>
          </label>
        </div>
        <div className="approval-actions">
          <button type="button" className="deny-button" onClick={onCancel}>
            <X size={17} />
            Cancel
          </button>
          <button type="button" className="approve-button" onClick={() => onCreate(options)}>
            <FolderPlus size={17} />
            Create workspace
          </button>
        </div>
      </section>
    </div>
  );
}

function providerFormsFromConfig(config: DesktopState["config"]): ProviderFormState[] {
  if (config.providers.length > 0) {
    return config.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: "",
      apiKeyPresent: provider.apiKeyPresent
    }));
  }

  const preset = PROVIDER_PRESETS.find((provider) => provider.baseUrl === config.baseUrl);
  return [
    {
      id: preset?.id ?? "current",
      name: preset?.name ?? "Current provider",
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: "",
      apiKeyPresent: config.apiKeyPresent
    }
  ];
}

function activeProviderName(config: DesktopState["config"]) {
  const activeProvider = config.providers.find((provider) => provider.id === config.activeProviderId);
  if (activeProvider) {
    return activeProvider.name;
  }
  return PROVIDER_PRESETS.find((provider) => provider.baseUrl === config.baseUrl)?.name ?? "OpenAI-compatible";
}

function isAutoModelId(model: string | undefined) {
  return model?.trim().toLowerCase() === AUTO_MODEL_VALUE;
}

function modelDisplayName(model: string | undefined) {
  return isAutoModelId(model) ? "Auto" : model || "default model";
}

function modelSelectionStatus(selection: PublicModelSelection | undefined) {
  if (!selection || selection.mode !== "auto" || isAutoModelId(selection.model)) {
    return null;
  }
  return `Auto picked ${selection.model}`;
}

function agentLoopStatusFromEvent(event: SessionLifecycleEvent) {
  return event.agentLoop ? agentLoopStatusLabel(event.agentLoop) : null;
}

function agentLoopStatusLabel(loop: AgentLoopState) {
  const progress = `${loop.iteration}/${loop.maxIterations}`;
  if (loop.status === "running") {
    return `Agent loop ${progress}`;
  }
  if (loop.status === "stopping") {
    return `Stopping loop ${progress}`;
  }
  if (loop.status === "completed") {
    return `Loop completed in ${loop.iteration} ${loop.iteration === 1 ? "iteration" : "iterations"}`;
  }
  if (loop.status === "stopped") {
    return `Loop stopped at ${progress}`;
  }
  if (loop.status === "blocked") {
    return `Loop blocked at ${progress}`;
  }
  if (loop.status === "failed") {
    return `Loop failed at ${progress}`;
  }
  return `Loop reached ${loop.maxIterations} iterations`;
}

function sessionModelLabel(session: SessionSummary) {
  if (session.modelMode === "auto" || isAutoModelId(session.model)) {
    return session.selectedModel ? `Auto -> ${session.selectedModel}` : "Auto";
  }
  return modelDisplayName(session.model);
}

function sessionModelTitle(session: SessionSummary) {
  if (session.modelMode === "auto" || isAutoModelId(session.model)) {
    return [session.selectedProviderName, session.modelSelectionReason].filter(Boolean).join(" - ") || "Auto model selection";
  }
  return session.model ?? "default model";
}

function sessionLoopLabel(loop: AgentLoopState) {
  if (loop.status === "running" || loop.status === "stopping") {
    return `Loop ${loop.iteration}/${loop.maxIterations}`;
  }
  if (loop.status === "completed") {
    return "Loop done";
  }
  if (loop.status === "max_iterations") {
    return "Loop max";
  }
  return `Loop ${loop.status}`;
}

function uniqueProviderId(baseId: string, providers: ProviderFormState[]) {
  const normalizedBase = baseId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
  const used = new Set(providers.map((provider) => provider.id));
  if (!used.has(normalizedBase)) {
    return normalizedBase;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${normalizedBase}-${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

function uniqueProviderName(baseName: string, providers: ProviderFormState[]) {
  const normalizedNames = new Set(providers.map((provider) => provider.name.trim().toLowerCase()).filter(Boolean));
  if (!normalizedNames.has(baseName.toLowerCase())) {
    return baseName;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!normalizedNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

function validateProviderForms(
  providers: ProviderFormState[],
  activeProviderId: string
): { providers: LlmProviderPatch[]; activeProviderId: string; activeProvider: LlmProviderPatch } {
  const nextProviders: LlmProviderPatch[] = [];
  const names = new Set<string>();

  for (const provider of providers) {
    const baseUrl = provider.baseUrl.trim();
    if (!baseUrl) {
      continue;
    }

    const name = provider.name.trim();
    const model = provider.model.trim();
    if (!name) {
      throw new Error("Enter a name for each provider with a URL.");
    }
    if (!model) {
      throw new Error(`Enter a model ID for ${name}, or use the model picker.`);
    }

    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) {
      throw new Error(`Provider name "${name}" is already in use. Provider names must be unique.`);
    }
    names.add(normalizedName);

    nextProviders.push({
      id: provider.id,
      name,
      baseUrl: normalizeProviderUrl(baseUrl, name),
      model,
      ...(provider.apiKey?.trim() ? { apiKey: provider.apiKey.trim() } : {})
    });
  }

  if (nextProviders.length === 0) {
    throw new Error("Keep at least one provider with a URL and model ID.");
  }

  const activeProvider = nextProviders.find((provider) => provider.id === activeProviderId) ?? nextProviders[0];
  return {
    providers: nextProviders,
    activeProviderId: activeProvider.id,
    activeProvider
  };
}

function normalizeProviderUrl(baseUrl: string, providerName: string) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported provider URL protocol.");
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${providerName} needs a valid http(s) base URL.`);
  }
}

function parseSlashCommandQuery(value: string) {
  if (!value.startsWith("/") || value.includes("\n")) {
    return null;
  }
  return value.slice(1).trim().toLowerCase();
}

function filterSlashCommands(commands: SlashCommandEntry[], query: string) {
  if (!query) {
    return commands;
  }

  return commands.filter((command) => {
    const searchable = [command.command, command.title, command.description, ...command.keywords].join(" ").toLowerCase();
    return searchable.includes(query);
  });
}

function firstEnabledSlashCommandIndex(commands: SlashCommandEntry[]) {
  const index = commands.findIndex((command) => !command.disabledReason);
  return index >= 0 ? index : 0;
}

function nextEnabledSlashCommandIndex(commands: SlashCommandEntry[], currentIndex: number, direction: 1 | -1) {
  if (commands.length === 0) {
    return 0;
  }

  for (let offset = 1; offset <= commands.length; offset += 1) {
    const nextIndex = (currentIndex + direction * offset + commands.length) % commands.length;
    if (!commands[nextIndex]?.disabledReason) {
      return nextIndex;
    }
  }
  return Math.min(currentIndex, commands.length - 1);
}

function buildSlashCommandEntries({
  state,
  busy,
  compactingContext,
  nonSystemMessageCount,
  availableToolCount,
  availableSkillCount,
  pendingSkillCount,
  agentPlanModeEnabled,
  agentLoopEnabled,
  agentWorktreeEnabled,
  fileAttachmentCount
}: {
  state: DesktopState | null;
  busy: boolean;
  compactingContext: boolean;
  nonSystemMessageCount: number;
  availableToolCount: number;
  availableSkillCount: number;
  pendingSkillCount: number;
  agentPlanModeEnabled: boolean;
  agentLoopEnabled: boolean;
  agentWorktreeEnabled: boolean;
  fileAttachmentCount: number;
}): SlashCommandEntry[] {
  return SLASH_COMMANDS.map((command) => {
    if (command.id === "compact") {
      let disabledReason: string | undefined;
      if (busy) {
        disabledReason = "Agent is running.";
      } else if (compactingContext) {
        disabledReason = "Compaction is already running.";
      } else if (!state?.sessionId) {
        disabledReason = "Start or open a chat before compacting.";
      } else if (nonSystemMessageCount <= CONTEXT_COMPACT_RECENT_MESSAGE_COUNT) {
        disabledReason = `Needs more than ${CONTEXT_COMPACT_RECENT_MESSAGE_COUNT} chat messages.`;
      }
      return {
        ...command,
        detail: disabledReason ? undefined : `${formatNumber(nonSystemMessageCount)} chat messages`,
        disabledReason
      };
    }

    if (command.id === "session") {
      return {
        ...command,
        detail: state?.sessionId ?? "Draft chat"
      };
    }

    if (command.id === "tools") {
      return {
        ...command,
        detail: `${formatNumber(availableToolCount)} tools loaded`
      };
    }

    if (command.id === "browser") {
      return {
        ...command,
        detail: state?.browser.paneOpen ? "Browser window open" : "Browser window hidden"
      };
    }

    if (command.id === "files") {
      let disabledReason: string | undefined;
      if (busy) {
        disabledReason = "Agent is running.";
      } else if (state?.projectRoot === null) {
        disabledReason = "Open a workspace before attaching file context.";
      } else if (fileAttachmentCount >= MAX_CONTEXT_FILE_ATTACHMENTS) {
        disabledReason = "File context limit reached.";
      }
      return {
        ...command,
        detail: disabledReason ? undefined : `${formatNumber(fileAttachmentCount)} / ${formatNumber(MAX_CONTEXT_FILE_ATTACHMENTS)} attached`,
        disabledReason
      };
    }

    if (command.id === "loop") {
      return {
        ...command,
        detail: agentLoopEnabled ? "Currently armed" : `${DEFAULT_AGENT_LOOP_MAX_ITERATIONS} iteration budget`
      };
    }

    if (command.id === "plan") {
      return {
        ...command,
        detail: agentPlanModeEnabled ? "Currently armed" : "Read-only plan before execution"
      };
    }

    if (command.id === "worktree") {
      let disabledReason: string | undefined;
      if (busy) {
        disabledReason = "Agent is running.";
      } else if (state?.projectRoot === null) {
        disabledReason = "Select a git project before using task worktrees.";
      }
      return {
        ...command,
        detail: disabledReason ? undefined : agentWorktreeEnabled ? "Currently armed" : "Next prompt gets an isolated branch",
        disabledReason
      };
    }

    return {
      ...command,
      detail:
        pendingSkillCount > 0
          ? `${formatNumber(pendingSkillCount)} queued, ${formatNumber(availableSkillCount)} available`
          : `${formatNumber(availableSkillCount)} skills available`
    };
  });
}

function buildSessionCommandOutput({
  state,
  messages,
  estimatedContextTokens,
  availableToolCount,
  imageAttachmentCount,
  fileAttachmentCount
}: {
  state: DesktopState;
  messages: ChatMessage[];
  estimatedContextTokens: number;
  availableToolCount: number;
  imageAttachmentCount: number;
  fileAttachmentCount: number;
}): CommandOutput {
  const nonSystemCount = messages.filter((message) => message.role !== "system").length;
  const remainingTokens = Math.max(0, COMPOSER_TOKEN_BUDGET - estimatedContextTokens);
  const provider = activeProviderForState(state);
  const latestRun = state.taskRuns?.at(-1);

  return {
    title: "Session details",
    subtitle: "Local context estimate; provider context windows are not reported.",
    rows: [
      { label: "Chat ID", value: state.sessionId ?? "Draft chat (not saved yet)" },
      { label: "Project", value: state.projectRoot === null ? "No project selected" : state.workspace.packageName ?? basename(state.projectRoot) },
      { label: "Workspace", value: state.workspace.root },
      { label: "Provider", value: provider ? `${provider.name} (${provider.baseUrl})` : state.config.baseUrl },
      { label: "Model", value: modelDisplayName(state.config.model) },
      ...(state.modelSelection?.mode === "auto" && !isAutoModelId(state.modelSelection.model)
        ? [{ label: "Auto picked", value: `${state.modelSelection.model} (${state.modelSelection.providerName})` }]
        : []),
      ...(state.agentLoop ? [{ label: "Agent loop", value: agentLoopStatusLabel(state.agentLoop) }] : []),
      ...(latestRun
        ? [
            {
              label: "Latest run",
              value: [
                taskRunStatusLabel(latestRun.status),
                latestRun.capabilities.length > 0 ? latestRun.capabilities.map(capabilityLabel).join(", ") : "no tools yet",
                `${formatNumber(latestRun.approvals?.length ?? 0)} approvals`,
                `${formatNumber(latestRun.artifacts.length)} artifacts`
              ].join(" - ")
            }
          ]
        : []),
      ...(latestRun?.worktree?.enabled
        ? [
            {
              label: "Task worktree",
              value: [
                worktreeStatusLabel(latestRun.worktree.status),
                latestRun.worktree.branch ?? "branch",
                worktreeDiffLabel(latestRun.worktree.diff),
                latestRun.worktree.path ?? latestRun.worktree.error
              ]
                .filter(Boolean)
                .join(" - ")
            }
          ]
        : []),
      { label: "Trust mode", value: state.config.trustMode },
      {
        label: "Context used",
        value: `~${formatNumber(estimatedContextTokens)} / ${formatNumber(COMPOSER_TOKEN_BUDGET)} tokens`
      },
      { label: "Context remaining", value: `~${formatNumber(remainingTokens)} tokens` },
      { label: "Messages", value: `${formatNumber(nonSystemCount)} chat, ${formatNumber(messages.length)} total` },
      { label: "Attached images", value: `${formatNumber(imageAttachmentCount)} / ${formatNumber(MAX_IMAGE_ATTACHMENTS)}` },
      { label: "Attached files", value: `${formatNumber(fileAttachmentCount)} / ${formatNumber(MAX_CONTEXT_FILE_ATTACHMENTS)}` },
      { label: "Tools", value: `${formatNumber(availableToolCount)} available` }
    ]
  };
}

function activeProviderForState(state: DesktopState) {
  return (
    state.config.providers.find((provider) => provider.id === state.config.activeProviderId) ??
    state.config.providers.find((provider) => provider.baseUrl === state.config.baseUrl)
  );
}

function loadedSkillNamesFromMessages(messages: ChatMessage[]) {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") {
      continue;
    }
    const match = /^Skill loaded into chat:\s+([^\n]+)/.exec(chatContentToText(message.content));
    if (match?.[1]) {
      names.add(match[1].trim());
    }
  }
  return Array.from(names);
}

function skillSummaryFromName(name: string): SkillSummary {
  return {
    name,
    title: name,
    description: "",
    path: ""
  };
}

function estimateContextTokens(messages: ChatMessage[]) {
  const transcript = messages
    .map((message) => `${message.role}: ${chatContentToText(message.content)}`)
    .join("\n\n");
  return estimateTokenCount(transcript);
}

function deriveProjects(sessions: SessionSummary[], state: DesktopState | null): ProjectSummary[] {
  const projectsByRoot = new Map<string, ProjectSummary>();

  for (const session of sessions) {
    if (session.projectRoot === null) {
      continue;
    }

    const existing = projectsByRoot.get(session.projectRoot);
    if (!existing) {
      projectsByRoot.set(session.projectRoot, {
        projectRoot: session.projectRoot,
        name: basename(session.projectRoot),
        latestSessionId: session.id,
        updatedAt: session.updatedAt,
        pinnedAt: session.pinnedAt,
        chatCount: 1,
        sessions: [session]
      });
      continue;
    }

    existing.chatCount += 1;
    existing.sessions.push(session);
    if (session.pinnedAt && (!existing.pinnedAt || session.pinnedAt > existing.pinnedAt)) {
      existing.pinnedAt = session.pinnedAt;
    }
    if (!existing.updatedAt || session.updatedAt > existing.updatedAt) {
      existing.latestSessionId = session.id;
      existing.updatedAt = session.updatedAt;
    }
  }

  const projects = Array.from(projectsByRoot.values()).sort(compareProjectsForDisplay);
  for (const project of projects) {
    project.sessions.sort(compareSessionsForDisplay);
  }

  if (!state || state.projectRoot === null) {
    return projects;
  }

  const activeProject = projectsByRoot.get(state.projectRoot) ?? {
    projectRoot: state.projectRoot,
    name: state.workspace.packageName ?? basename(state.workspace.root),
    chatCount: 0,
    sessions: []
  };
  activeProject.name = state.workspace.packageName ?? basename(state.workspace.root);

  return [
    activeProject,
    ...projects.filter((project) => project.projectRoot !== activeProject.projectRoot)
  ];
}

function compareProjectsForDisplay(left: ProjectSummary, right: ProjectSummary) {
  if (left.pinnedAt || right.pinnedAt) {
    if (!left.pinnedAt) {
      return 1;
    }
    if (!right.pinnedAt) {
      return -1;
    }
    return right.pinnedAt.localeCompare(left.pinnedAt);
  }
  return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
}

function compareSessionsForDisplay(left: SessionSummary, right: SessionSummary) {
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

function createPromptContent(text: string, images: ImageAttachment[], files: ContextFileAttachment[] = []): ChatContent {
  const trimmed = promptTextWithFileContext(text, files);
  const parts: ChatContentPart[] = [];
  if (trimmed) {
    parts.push({ type: "text", text: trimmed });
  }
  parts.push(
    ...images.map((image) => ({
      type: "image_url" as const,
      image_url: {
        url: image.dataUrl,
        detail: image.detail ?? "auto"
      },
      name: image.name,
      mimeType: image.mimeType,
      size: image.size
    }))
  );

  if (parts.length === 1 && parts[0]?.type === "text") {
    return parts[0].text;
  }
  return parts;
}

function imageFilesFromClipboard(clipboard: DataTransfer) {
  return imageFilesFromDataTransfer(clipboard);
}

function imageFilesFromDataTransfer(dataTransfer: DataTransfer) {
  const files = Array.from(dataTransfer.files).filter(isSupportedImageFile);
  if (files.length > 0) {
    return files;
  }

  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file" && SUPPORTED_IMAGE_TYPES.has(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file && isSupportedImageFile(file)));
}

function hasPotentialImageTransfer(dataTransfer: DataTransfer) {
  return (
    Array.from(dataTransfer.files).some(isSupportedImageFile) ||
    Array.from(dataTransfer.items).some((item) => item.kind === "file" && (item.type === "" || SUPPORTED_IMAGE_TYPES.has(item.type)))
  );
}

function hasFileTransfer(dataTransfer: DataTransfer) {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.items).some((item) => item.kind === "file");
}

function isSupportedImageFile(file: File) {
  return Boolean(imageMimeTypeForFile(file));
}

function imageMimeTypeForFile(file: File) {
  const type = file.type.toLowerCase();
  if (SUPPORTED_IMAGE_TYPES.has(type)) {
    return type;
  }
  const extension = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase();
  return extension ? SUPPORTED_IMAGE_EXTENSIONS[extension] : undefined;
}

async function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  const mimeType = imageMimeTypeForFile(file);
  if (!mimeType) {
    throw new Error(`${file.name || "Image"} must be a PNG, JPEG, WebP, or GIF file.`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`${file.name || "Image"} is larger than ${formatBytes(MAX_IMAGE_BYTES)}.`);
  }

  return {
    id: randomId(),
    name: file.name || `pasted-image-${Date.now()}`,
    mimeType,
    size: file.size,
    dataUrl: normalizeImageDataUrlMime(await readFileAsDataUrl(file), mimeType),
    detail: "auto"
  };
}

function normalizeImageDataUrlMime(dataUrl: string, mimeType: string) {
  return dataUrl.startsWith("data:;base64,") ? dataUrl.replace("data:;base64,", `data:${mimeType};base64,`) : dataUrl;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image data."));
    reader.readAsDataURL(file);
  });
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function chatContentToText(content: ChatContent): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      const name = part.name ? ` ${part.name}` : "";
      const mimeType = part.mimeType ? `, ${part.mimeType}` : "";
      return `[Image${name}${mimeType}]`;
    })
    .filter(Boolean)
    .join("\n");
}

function chatContentTextOnly(content: ChatContent): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part): part is ChatTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function chatContentHasText(content: ChatContent): boolean {
  return chatContentToText(content).trim().length > 0;
}

function chatContentHasRenderableContent(content: ChatContent): boolean {
  return chatContentHasText(content) || imagePartsFromContent(content).length > 0;
}

function chatContentEquals(left: ChatContent, right: ChatContent) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deriveVisibleMessages(messages: ChatMessage[]): VisibleMessageEntry[] {
  const visible: VisibleMessageEntry[] = [];

  messages.forEach((message, messageIndex) => {
    if (message.role === "user") {
      const last = visible.at(-1);
      if (last?.message.role === "user" && chatContentEquals(last.message.content, message.content)) {
        last.sourceIndexes.push(messageIndex);
        last.key = `${last.message.role}-${last.sourceIndexes.join("-")}`;
        return;
      }
      visible.push({
        message,
        messageIndex,
        sourceIndexes: [messageIndex],
        key: `user-${messageIndex}`
      });
      return;
    }

    if (message.role !== "assistant" || !chatContentHasText(message.content)) {
      return;
    }

    const last = visible.at(-1);
    if (last?.message.role === "assistant") {
      last.message = {
        ...last.message,
        content: [chatContentToText(last.message.content), chatContentToText(message.content)].filter(Boolean).join("\n\n")
      };
      last.sourceIndexes.push(messageIndex);
      last.key = `${last.message.role}-${last.sourceIndexes.join("-")}`;
      return;
    }

    visible.push({
      message,
      messageIndex,
      sourceIndexes: [messageIndex],
      key: `assistant-${messageIndex}`
    });
  });

  return visible;
}

function imagePartsFromContent(content: ChatContent): ChatImagePart[] {
  return Array.isArray(content) ? content.filter((part): part is ChatImagePart => part.type === "image_url") : [];
}

function imageAttachmentsFromContent(content: ChatContent): ImageAttachment[] {
  return imagePartsFromContent(content).map((part, index) => ({
    id: `restored-${index}-${part.image_url.url.slice(0, 32)}`,
    name: part.name ?? `image-${index + 1}`,
    mimeType: part.mimeType ?? mimeTypeFromDataUrl(part.image_url.url),
    size: part.size ?? 0,
    dataUrl: part.image_url.url,
    detail: part.image_url.detail
  }));
}

function mergeImageAttachments(current: ImageAttachment[], next: ImageAttachment[]) {
  const byId = new Map(current.map((image) => [image.id, image]));
  for (const image of next) {
    byId.set(image.id, image);
  }
  return Array.from(byId.values()).slice(0, MAX_IMAGE_ATTACHMENTS);
}

function mergeFileAttachments(current: ContextFileAttachment[], next: ContextFileAttachment[]) {
  const byPath = new Map(current.map((file) => [file.path, file]));
  for (const file of next) {
    byPath.set(file.path, file);
  }
  return Array.from(byPath.values()).slice(0, MAX_CONTEXT_FILE_ATTACHMENTS);
}

function mimeTypeFromDataUrl(dataUrl: string) {
  return /^data:([^;,]+);base64,/i.exec(dataUrl)?.[1] ?? "image";
}

function findLatestActivityScreenshot(activity: ActivityItem[]) {
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    const item = activity[index];
    if (item?.imagePreview) {
      return item;
    }
  }
  return null;
}

function deriveActivityModel(messages: ChatMessage[], state: DesktopState | null): ActivityModel {
  const systemItems: ActivityItem[] = [];
  const groups: ActivityGroup[] = [];
  const groupsByUserMessageIndex = new Map<number, ActivityGroup>();
  const taskRuns = state?.taskRuns ?? [];
  const taskRunsById = new Map(taskRuns.map((run) => [run.id, run]));
  const taskRunsByUserMessageIndex = new Map<number, AgentTaskRun[]>();
  for (const run of taskRuns) {
    const runs = taskRunsByUserMessageIndex.get(run.userMessageIndex) ?? [];
    runs.push(run);
    taskRunsByUserMessageIndex.set(run.userMessageIndex, runs);
  }
  const latestRunForUserMessage = (index: number) => taskRunsByUserMessageIndex.get(index)?.at(-1);
  const sourceRunFor = (run: AgentTaskRun | undefined) => {
    const sourceRunId = run?.worktree?.continuedFromTaskRunId;
    return sourceRunId ? taskRunsById.get(sourceRunId) : undefined;
  };
  const planSourceRunFor = (run: AgentTaskRun | undefined) => {
    const sourceRunId = run?.worktree?.plannedFromTaskRunId;
    return sourceRunId ? taskRunsById.get(sourceRunId) : undefined;
  };
  const worktreeAttemptRunsFor = (run: AgentTaskRun | undefined) => buildWorktreeAttemptRuns(run, taskRunsById);
  const completedToolCallIds = new Set(
    messages.flatMap((message) => (message.role === "tool" && message.toolCallId ? [message.toolCallId] : []))
  );
  const currentSessionRunning = state ? isSessionRunning(state, state.sessionId) : false;
  if (state) {
    systemItems.push({
      id: "workspace",
      kind: "system",
      title: "workspace",
      detail: `${state.workspace.root}\n${state.workspace.dirty ? "git: dirty" : "git: clean"}`
    });
    if (state.agentLoop) {
      systemItems.push({
        id: "agent-loop",
        kind: "system",
        title: "agent loop",
        detail: [
          agentLoopStatusLabel(state.agentLoop),
          `Goal: ${state.agentLoop.goal}`,
          `Started: ${formatDateTime(state.agentLoop.startedAt)}`,
          `Updated: ${formatDateTime(state.agentLoop.updatedAt)}`
        ].join("\n"),
        summary: state.agentLoop.lastDecision
          ? `${agentLoopStatusLabel(state.agentLoop)}; last decision: ${state.agentLoop.lastDecision}`
          : agentLoopStatusLabel(state.agentLoop),
        status: state.agentLoop.status === "running" || state.agentLoop.status === "stopping" ? "running" : "done"
      });
    }
  }

  let currentGroup: ActivityGroup | null = null;
  let detachedGroup: ActivityGroup | null = null;
  const getDetachedGroup = () => {
    if (!detachedGroup) {
      detachedGroup = {
        id: "activity-group-session",
        userMessageIndex: null,
        title: "Session activity",
        detail: "Tool activity that was restored without a visible user query.",
        items: [],
        status: "done"
      };
      groups.push(detachedGroup);
    }
    return detachedGroup;
  };
  const activeGroup = () => currentGroup ?? getDetachedGroup();

  messages.forEach((message, index) => {
    if (message.role === "user") {
      const group: ActivityGroup = {
        id: `activity-group-${index}`,
        userMessageIndex: index,
        title: queryActivityTitle(message.content),
        detail: chatContentToText(message.content),
        items: [],
        status: "done",
        run: latestRunForUserMessage(index)
      };
      group.sourceRun = sourceRunFor(group.run);
      group.planSourceRun = planSourceRunFor(group.run);
      group.worktreeAttemptRuns = worktreeAttemptRunsFor(group.run);
      currentGroup = group;
      groups.push(group);
      groupsByUserMessageIndex.set(index, group);
      return;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      const group = activeGroup();
      for (const call of message.toolCalls) {
        const complete = completedToolCallIds.has(call.id);
        const policy = activityPolicyForToolActivity(group.run, call.id, call.name);
        group.items.push({
          id: `call-${index}-${call.id}`,
          kind: "call",
          title: call.name,
          detail: safeJson(call.arguments),
          summary: summarizeToolCall(call),
          status: complete ? "done" : currentSessionRunning ? "running" : "waiting",
          policy
        });
      }
    }
    if (message.role === "tool") {
      const group = activeGroup();
      const toolResult = buildToolResultActivity(message);
      const policy = message.name ? activityPolicyForToolActivity(group.run, message.toolCallId, message.name) : undefined;
      group.items.push({
        id: `tool-${index}-${message.toolCallId ?? message.name}`,
        kind: "result",
        title: message.name ?? "tool",
        detail: toolResult.detail,
        summary: toolResult.summary,
        imagePreview: toolResult.imagePreview,
        policy
      });
    }
  });

  const groupedRunIds = new Set(groups.flatMap((group) => (group.run ? [group.run.id] : [])));
  for (const group of groups) {
    if (!group.run) {
      continue;
    }
    if (group.items.length === 0) {
      group.items.push(...activityItemsFromTaskRun(group.run));
    } else {
      group.items.unshift(...approvalActivityItemsFromTaskRun(group.run));
    }
  }
  for (const run of taskRuns) {
    if (groupedRunIds.has(run.id)) {
      continue;
    }
    groups.push({
      id: `activity-group-run-${run.id}`,
      userMessageIndex: run.userMessageIndex,
      title: run.promptPreview || "Restored run",
      detail: run.promptPreview,
      items: activityItemsFromTaskRun(run),
      status: activityStatusForTaskRun(run),
      run,
      sourceRun: sourceRunFor(run),
      planSourceRun: planSourceRunFor(run),
      worktreeAttemptRuns: worktreeAttemptRunsFor(run)
    });
  }

  for (const group of groups) {
    group.status = group.run ? mergeActivityGroupStatus(group.run, deriveActivityGroupStatus(group.items)) : deriveActivityGroupStatus(group.items);
  }

  if (currentSessionRunning) {
    const runningCallCount = groups.flatMap((group) => group.items).filter((item) => item.status === "running").length;
    systemItems.push({
      id: "agent-progress",
      kind: "system",
      title: runningCallCount > 0 ? "agent progress" : "agent working",
      detail: "This panel shows visible progress from streamed messages and tool calls. Private model reasoning is not displayed.",
      summary:
        runningCallCount > 0
          ? `${runningCallCount} tool ${runningCallCount === 1 ? "call is" : "calls are"} running.`
          : "Waiting for the next streamed response or tool call."
    });
  }

  const items = [...systemItems, ...groups.flatMap((group) => group.items)];
  return {
    items,
    systemItems,
    groups,
    groupsByUserMessageIndex
  };
}

function buildWorktreeAttemptRuns(run: AgentTaskRun | undefined, runsById: Map<string, AgentTaskRun>) {
  if (!run?.worktree?.enabled) {
    return [];
  }

  const reversed: AgentTaskRun[] = [];
  const seen = new Set<string>();
  let current: AgentTaskRun | undefined = run;
  while (current?.worktree?.enabled && !seen.has(current.id)) {
    seen.add(current.id);
    reversed.push(current);
    const previousId: string | undefined = current.worktree.continuedFromTaskRunId;
    current = previousId ? runsById.get(previousId) : undefined;
  }
  return reversed.reverse();
}

function activityItemsFromTaskRun(run: AgentTaskRun): ActivityItem[] {
  const items: ActivityItem[] = [...approvalActivityItemsFromTaskRun(run)];
  for (const tool of run.tools) {
    const artifacts =
      tool.artifactIds
        ?.map((artifactId) => run.artifacts.find((candidate) => candidate.id === artifactId))
        .filter((candidate): candidate is AgentTaskRunArtifact => Boolean(candidate)) ?? [];
    const screenshotArtifact = artifacts.find((candidate) => candidate.kind === "browser_screenshot" && Boolean(candidate.path));
    const commandArtifact = artifacts.find((candidate) => candidate.kind === "command_output");
    const patchArtifact = artifacts.find((candidate) => candidate.kind === "patch");
    const fileChangeArtifact = artifacts.find((candidate) => candidate.kind === "file_change");
    const artifact = commandArtifact ?? patchArtifact ?? fileChangeArtifact ?? screenshotArtifact ?? artifacts[0];
    const resultDetail = commandArtifact
      ? commandArtifactDetail(commandArtifact)
      : patchArtifact
        ? patchArtifactDetail(patchArtifact)
        : fileChangeArtifact
          ? fileChangeArtifactDetail(fileChangeArtifact)
      : tool.resultPreview ?? artifact?.summary ?? "";
    const resultSummary =
      commandArtifactSummary(commandArtifact) ?? patchArtifactSummary(patchArtifact) ?? fileChangeArtifactSummary(fileChangeArtifact) ?? artifact?.summary;
    const resultStatus =
      tool.status === "failed" ||
      commandArtifact?.exitCode !== undefined && commandArtifact.exitCode !== 0 ||
      commandArtifact?.testReports?.some((report) => report.status === "failed")
        ? "failed"
        : "done";
    const imagePreview = screenshotArtifact?.path
      ? {
          path: screenshotArtifact.path,
          width: screenshotArtifact.width,
          height: screenshotArtifact.height,
          caption: screenshotArtifact.summary ?? "Browser screenshot"
        }
      : undefined;
    const diffPreview = patchArtifact?.diff
      ? patchArtifactDiffPreview(patchArtifact)
      : fileChangeArtifact?.content !== undefined
        ? fileChangeArtifactDiffPreview(fileChangeArtifact)
        : undefined;
    const policy = activityPolicyForRunTool(run, tool);

    items.push({
      id: `run-call-${run.id}-${tool.toolCallId}`,
      kind: "call",
      title: tool.name,
      detail: safeJson(tool.arguments ?? {}),
      summary: capabilityLabel(tool.capability),
      status: tool.status === "done" ? "done" : tool.status === "failed" ? "failed" : "running",
      policy
    });
    if (tool.resultPreview || artifact) {
      items.push({
        id: `run-result-${run.id}-${tool.toolCallId}`,
        kind: "result",
        title: tool.name,
        detail: resultDetail,
        summary: resultSummary,
        status: resultStatus,
        imagePreview,
        diffPreview,
        evidenceLinks: commandArtifact ? commandArtifactEvidenceLinks(run.id, commandArtifact) : undefined,
        remediationPrompt: commandArtifact ? buildReportRemediationPrompt(commandArtifact) : undefined,
        rollbackPrompt: buildEditRollbackPrompt(run, patchArtifact, fileChangeArtifact),
        policy
      });
    }
  }
  return items;
}

function approvalActivityItemsFromTaskRun(run: AgentTaskRun): ActivityItem[] {
  return (run.approvals ?? []).map((approval) => ({
    id: `run-approval-${run.id}-${approval.id}`,
    kind: "approval" as const,
    title: approvalTitle(approval),
    detail: approvalDetail(approval),
    summary: approvalSummary(approval),
    status: approvalActivityStatus(approval.status),
    policy: activityPolicyFromApproval(approval)
  }));
}

function activityPolicyForToolActivity(run: AgentTaskRun | undefined, toolCallId: string | undefined, name: string): ActivityPolicyDetail {
  const tool = taskRunToolForActivity(run, toolCallId, name);
  if (run && tool) {
    return activityPolicyForRunTool(run, tool);
  }
  return inferredActivityPolicyForTool(name);
}

function taskRunToolForActivity(run: AgentTaskRun | undefined, toolCallId: string | undefined, name: string) {
  if (!run) {
    return undefined;
  }
  if (toolCallId) {
    const byId = run.tools.find((tool) => tool.toolCallId === toolCallId);
    if (byId) {
      return byId;
    }
  }
  return run.tools.find((tool) => tool.name === name);
}

function activityPolicyForRunTool(run: AgentTaskRun, tool: AgentTaskRunToolCall): ActivityPolicyDetail {
  const approval = matchingApprovalForTool(run, tool);
  if (approval) {
    return activityPolicyFromApproval(approval);
  }
  return {
    capability: tool.capability,
    capabilityLabel: capabilityLabel(tool.capability),
    source: "tool",
    label: "Recorded capability",
    reason: "This tool call has a saved capability record, but no matching approval audit was recorded on the task run.",
    summary: `Tool ${tool.name} was classified as ${capabilityLabel(tool.capability)}.`
  };
}

function matchingApprovalForTool(run: AgentTaskRun, tool: AgentTaskRunToolCall) {
  const approvals = (run.approvals ?? []).filter((approval) => approval.capability === tool.capability);
  if (approvals.length === 0) {
    return undefined;
  }
  return approvals
    .slice()
    .sort((left, right) => {
      const leftRank = approvalMatchRank(left.status);
      const rightRank = approvalMatchRank(right.status);
      if (leftRank !== rightRank) {
        return rightRank - leftRank;
      }
      return approvalTimestamp(right).localeCompare(approvalTimestamp(left));
    })[0];
}

function approvalMatchRank(status: AgentTaskRunApprovalStatus) {
  if (status === "allowed" || status === "approved" || status === "blocked" || status === "denied") {
    return 2;
  }
  return 1;
}

function approvalTimestamp(approval: AgentTaskRunApproval) {
  return approval.updatedAt ?? approval.decidedAt ?? approval.requestedAt ?? approval.createdAt;
}

function activityPolicyFromApproval(approval: AgentTaskRunApproval): ActivityPolicyDetail {
  return {
    capability: approval.capability,
    capabilityLabel: capabilityLabel(approval.capability),
    source: "approval",
    label: approval.label,
    reason: approval.reason,
    effect: approval.effect,
    status: approval.status,
    trustMode: approval.trustMode,
    risky: approval.risky,
    override: approval.override,
    summary: approval.summary
  };
}

function inferredActivityPolicyForTool(name: string): ActivityPolicyDetail {
  const capability = capabilityForToolName(name);
  return {
    capability,
    capabilityLabel: capabilityLabel(capability),
    source: "inferred",
    label: "Inferred capability",
    reason: "This row was restored from transcript tool protocol, so Arivu inferred the capability from the tool name.",
    summary: `Tool ${name} maps to ${capabilityLabel(capability)}.`
  };
}

function approvalTitle(approval: AgentTaskRunApproval) {
  return `${approvalActionLabel(approval.actionType)} ${approvalStatusLabel(approval.status).toLowerCase()}`;
}

function approvalSummary(approval: AgentTaskRunApproval) {
  return `${approvalStatusLabel(approval.status)}: ${capabilityLabel(approval.capability)} - ${approval.summary}`;
}

function approvalDetail(approval: AgentTaskRunApproval) {
  const lines = [
    `status: ${approvalStatusLabel(approval.status)}`,
    `action: ${approval.actionType}`,
    `capability: ${capabilityLabel(approval.capability)}`,
    `trust mode: ${trustModeLabel(approval.trustMode)}`,
    `policy: ${approval.effect}${approval.override ? ` (workspace override: ${approval.override})` : ""}`,
    `risk: ${approval.risky ? "risky" : "standard"}`,
    `reason: ${approval.reason}`,
    approval.requestedAt ? `requested: ${formatDateTime(approval.requestedAt)}` : undefined,
    approval.decidedAt ? `decided: ${formatDateTime(approval.decidedAt)}` : undefined,
    `summary: ${approval.summary}`,
    approval.message ? `prompt:\n${approval.message}` : undefined
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

function approvalActivityStatus(status: AgentTaskRunApprovalStatus): ActivityItem["status"] {
  if (status === "requested") {
    return "waiting";
  }
  if (status === "denied" || status === "blocked") {
    return "failed";
  }
  return "done";
}

function approvalStatusLabel(status: AgentTaskRunApprovalStatus) {
  switch (status) {
    case "allowed":
      return "Allowed";
    case "requested":
      return "Requested";
    case "approved":
      return "Approved";
    case "denied":
      return "Denied";
    case "blocked":
      return "Blocked";
  }
}

function approvalActionLabel(actionType: AgentTaskRunApproval["actionType"]) {
  switch (actionType) {
    case "read":
      return "Read approval";
    case "write":
      return "Write approval";
    case "shell":
      return "Command approval";
    case "mcp":
      return "MCP approval";
    case "network":
      return "Network approval";
    case "browser":
      return "Browser approval";
  }
}

function commandArtifactSummary(artifact?: AgentTaskRunArtifact) {
  if (!artifact || artifact.kind !== "command_output") {
    return undefined;
  }
  const parts = [
    artifact.exitCode === undefined ? undefined : `Exit code ${artifact.exitCode}`,
    artifact.durationMs === undefined ? undefined : formatDurationMs(artifact.durationMs),
    testReportSummary(artifact.testReports) ??
      (artifact.reportPaths?.length ? `${artifact.reportPaths.length} report path${artifact.reportPaths.length === 1 ? "" : "s"}` : undefined)
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" - ") : artifact.summary;
}

function commandArtifactDetail(artifact: AgentTaskRunArtifact) {
  const metadata = [
    artifact.command === undefined ? undefined : `command: ${artifact.command}`,
    artifact.executionProfile === undefined ? undefined : `executionProfile: ${artifact.executionProfile}`,
    artifact.executionIsolation === undefined ? undefined : `executionIsolation: ${artifact.executionIsolation}`,
    artifact.workingDirectory === undefined ? undefined : `workingDirectory: ${artifact.workingDirectory}`,
    artifact.exitCode === undefined ? undefined : `exitCode: ${artifact.exitCode}`,
    artifact.durationMs === undefined ? undefined : `duration: ${formatDurationMs(artifact.durationMs)}`
  ].filter((part): part is string => Boolean(part));
  const sections = metadata.length > 0 ? [metadata.join("\n")] : [];

  if (artifact.testReports?.length) {
    sections.push(`test reports:\n${artifact.testReports.map(formatTestReportDetail).join("\n")}`);
  }
  const parsedReportPaths = new Set(artifact.testReports?.map((report) => report.path) ?? []);
  const unparsedReportPaths = artifact.reportPaths?.filter((path) => !parsedReportPaths.has(path)) ?? [];
  if (unparsedReportPaths.length) {
    sections.push(`report paths:\n${unparsedReportPaths.map((path) => `- ${path}`).join("\n")}`);
  }
  if (artifact.stdout !== undefined) {
    sections.push(`stdout${artifact.stdoutTruncated ? " (truncated)" : ""}:\n${artifact.stdout || "(empty)"}`);
  }
  if (artifact.stderr !== undefined) {
    sections.push(`stderr${artifact.stderrTruncated ? " (truncated)" : ""}:\n${artifact.stderr || "(empty)"}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : artifact.summary ?? "";
}

function patchArtifactSummary(artifact?: AgentTaskRunArtifact) {
  if (!artifact || artifact.kind !== "patch") {
    return undefined;
  }
  const stats = [
    artifact.changedPaths?.length ? `${artifact.changedPaths.length} file${artifact.changedPaths.length === 1 ? "" : "s"}` : undefined,
    artifact.additions ? `+${artifact.additions}` : undefined,
    artifact.deletions ? `-${artifact.deletions}` : undefined,
    artifact.diffTruncated ? "truncated" : undefined
  ].filter((part): part is string => Boolean(part));
  return stats.length > 0 ? `${artifact.summary ?? "Patch applied"} - ${stats.join(" ")}` : artifact.summary;
}

function patchArtifactDetail(artifact: AgentTaskRunArtifact) {
  const metadata = [
    artifact.changedPaths?.length ? `changedPaths:\n${artifact.changedPaths.map((path) => `- ${path}`).join("\n")}` : undefined,
    artifact.additions !== undefined || artifact.deletions !== undefined
      ? `stats: +${artifact.additions ?? 0} -${artifact.deletions ?? 0}`
      : undefined,
    artifact.diffTruncated ? "diff: truncated" : undefined
  ].filter((part): part is string => Boolean(part));
  return metadata.length > 0 ? metadata.join("\n\n") : artifact.summary ?? "";
}

function patchArtifactDiffPreview(artifact: AgentTaskRunArtifact): DiffPreview | undefined {
  if (!artifact.diff) {
    return undefined;
  }
  return {
    ...parseUnifiedDiffPreview(artifact.diff),
    title: artifact.diffTruncated ? "Applied patch (truncated)" : "Applied patch"
  };
}

function buildEditRollbackPrompt(
  run: AgentTaskRun,
  patchArtifact?: AgentTaskRunArtifact,
  fileChangeArtifact?: AgentTaskRunArtifact
) {
  const artifact = patchArtifact ?? fileChangeArtifact;
  if (!artifact || (artifact.kind !== "patch" && artifact.kind !== "file_change")) {
    return undefined;
  }

  const paths = editArtifactPaths(artifact);
  const intro =
    artifact.kind === "patch"
      ? `Review and revert the direct patch artifact from Arivu task run ${run.id}.`
      : `Review and revert the direct file-change artifact from Arivu task run ${run.id}.`;
  const lines = [
    intro,
    "Before editing, inspect the current files and preserve any later user or agent changes that are unrelated to this artifact.",
    "Prefer the smallest safe reverse patch. If the change cannot be reverted cleanly, explain what blocks it and ask before doing anything destructive.",
    run.promptPreview ? `Original request: ${run.promptPreview}` : undefined,
    artifact.summary ? `Artifact summary: ${artifact.summary}` : undefined,
    paths.length ? `Changed path${paths.length === 1 ? "" : "s"}:\n${paths.map((filePath) => `- ${filePath}`).join("\n")}` : undefined,
    artifact.kind === "patch" && (artifact.additions !== undefined || artifact.deletions !== undefined)
      ? `Patch stats: +${artifact.additions ?? 0} -${artifact.deletions ?? 0}`
      : undefined,
    artifact.kind === "file_change" && artifact.writeMode
      ? `File-change mode: ${artifact.writeMode}${artifact.lineCount !== undefined ? `, ${artifact.lineCount} lines` : ""}`
      : undefined,
    "",
    editArtifactEvidenceSection(artifact),
    "",
    "After reverting, run the first focused verification that fits the affected files and summarize the result."
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

function editArtifactPaths(artifact: AgentTaskRunArtifact) {
  if (artifact.kind === "patch") {
    return artifact.changedPaths ?? [];
  }
  return artifact.path ? [artifact.path] : [];
}

function editArtifactEvidenceSection(artifact: AgentTaskRunArtifact) {
  if (artifact.kind === "patch" && artifact.diff) {
    const suffix = artifact.diffTruncated ? " (truncated)" : "";
    return `Applied diff evidence${suffix}:\n\`\`\`diff\n${artifact.diff}\n\`\`\``;
  }
  if (artifact.kind === "file_change" && artifact.content !== undefined) {
    const suffix = artifact.contentTruncated ? " (truncated)" : "";
    return `Written content evidence${suffix}:\n\`\`\`\n${artifact.content}\n\`\`\``;
  }
  return "No bounded diff/content evidence was saved on this artifact. Use the changed paths and current git state to identify the smallest safe revert.";
}

function fileChangeArtifactSummary(artifact?: AgentTaskRunArtifact) {
  if (!artifact || artifact.kind !== "file_change") {
    return undefined;
  }
  const stats = [
    artifact.lineCount !== undefined ? `${artifact.lineCount} line${artifact.lineCount === 1 ? "" : "s"}` : undefined,
    artifact.contentTruncated ? "truncated" : undefined
  ].filter((part): part is string => Boolean(part));
  return stats.length > 0 ? `${artifact.summary ?? "File changed"} - ${stats.join(" ")}` : artifact.summary;
}

function fileChangeArtifactDetail(artifact: AgentTaskRunArtifact) {
  const metadata = [
    artifact.path ? `path: ${artifact.path}` : undefined,
    artifact.writeMode ? `mode: ${artifact.writeMode}` : undefined,
    artifact.lineCount !== undefined ? `lines: ${artifact.lineCount}` : undefined,
    artifact.contentTruncated ? "content: truncated" : undefined
  ].filter((part): part is string => Boolean(part));
  return metadata.length > 0 ? metadata.join("\n") : artifact.summary ?? "";
}

function fileChangeArtifactDiffPreview(artifact: AgentTaskRunArtifact): DiffPreview | undefined {
  if (artifact.content === undefined) {
    return undefined;
  }
  const title = artifact.path ? `${artifact.writeMode === "replace" ? "Replaced" : "Created"} ${artifact.path}` : "File change";
  return {
    title: artifact.contentTruncated ? `${title} (truncated)` : title,
    lines: splitLines(artifact.content).map((text, index) => ({
      kind: "add",
      newNumber: index + 1,
      text
    }))
  };
}

function commandArtifactEvidenceLinks(taskRunId: string, artifact: AgentTaskRunArtifact) {
  if (artifact.kind !== "command_output") {
    return undefined;
  }

  const links: ActivityEvidenceLink[] = [];
  const seen = new Set<string>();
  const addLink = (kind: ActivityEvidenceLink["kind"], path: string | undefined, line?: number) => {
    if (!path || links.length >= MAX_ACTIVITY_EVIDENCE_LINKS) {
      return;
    }
    const key = `${kind}:${path}:${line ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const suffix = line ? `:${line}` : "";
    const name = basename(path);
    links.push({
      id: `${taskRunId}:${artifact.id}:${key}`,
      kind,
      taskRunId,
      artifactId: artifact.id,
      path,
      line,
      label: kind === "report" ? `Open ${name}` : `Open ${name}${suffix}`,
      title: kind === "report" ? `Open report ${path}` : `Open evidence ${path}${suffix}`
    });
  };

  for (const reportPath of artifact.reportPaths ?? []) {
    addLink("report", reportPath);
  }
  for (const report of artifact.testReports ?? []) {
    addLink("report", report.path);
    for (const failure of report.failedTests ?? []) {
      addLink("source", failure.file, failure.line);
    }
    for (const finding of report.findingDetails ?? []) {
      addLink("source", finding.path, finding.line);
    }
  }

  return links.length > 0 ? links : undefined;
}

function testReportSummary(reports?: AgentTaskRunTestReport[]) {
  if (!reports?.length) {
    return undefined;
  }
  const failedReports = reports.filter((report) => report.status === "failed").length;
  const first = reports[0];
  const suffix = reports.length > 1 ? ` + ${reports.length - 1} more` : "";
  const status = failedReports > 0 ? `${failedReports} failed report${failedReports === 1 ? "" : "s"}` : undefined;
  return `${first.summary}${suffix}${status ? ` (${status})` : ""}`;
}

function formatTestReportLine(report: AgentTaskRunTestReport) {
  const kind = report.kind.toUpperCase();
  return `- ${report.path}: ${kind} ${report.summary} (${report.status})`;
}

function formatTestReportDetail(report: AgentTaskRunTestReport) {
  const lines = [formatTestReportLine(report)];
  if (report.failedTests?.length) {
    lines.push(...report.failedTests.map((failure) => `  failed: ${formatFailedTestLine(failure)}`));
  }
  if (report.findingDetails?.length) {
    lines.push(...report.findingDetails.map((finding) => `  finding: ${formatFindingLine(finding)}`));
  }
  return lines.join("\n");
}

function formatFailedTestLine(failure: NonNullable<AgentTaskRunTestReport["failedTests"]>[number]) {
  const label = [failure.classname, failure.name].filter(Boolean).join(".");
  const location = failure.file ? ` ${failure.file}${failure.line ? `:${failure.line}` : ""}` : "";
  const message = failure.message ? ` - ${failure.message}` : "";
  return `${label || failure.name}${location}${message}`;
}

function formatFindingLine(finding: NonNullable<AgentTaskRunTestReport["findingDetails"]>[number]) {
  const rule = finding.ruleId ? `${finding.ruleId}` : "finding";
  const level = finding.level ? ` ${finding.level}` : "";
  const location = finding.path ? ` ${finding.path}${finding.line ? `:${finding.line}${finding.column ? `:${finding.column}` : ""}` : ""}` : "";
  const message = finding.message ? ` - ${finding.message}` : "";
  return `${rule}${level}${location}${message}`;
}

function mergeActivityGroupStatus(run: AgentTaskRun, itemStatus: ActivityGroupStatus): ActivityGroupStatus {
  const runStatus = activityStatusForTaskRun(run);
  if (runStatus === "running" || runStatus === "failed") {
    return runStatus;
  }
  if (itemStatus === "running" || itemStatus === "failed" || itemStatus === "waiting") {
    return itemStatus;
  }
  return runStatus;
}

function activityStatusForTaskRun(run: AgentTaskRun): ActivityGroupStatus {
  if (run.status === "queued" || run.status === "running") {
    return "running";
  }
  if (run.status === "failed" || run.status === "blocked") {
    return "failed";
  }
  return "done";
}

function deriveActivityGroupStatus(items: ActivityItem[]): ActivityGroupStatus {
  if (items.some((item) => item.status === "running")) {
    return "running";
  }
  if (items.some((item) => item.status === "failed")) {
    return "failed";
  }
  if (items.some((item) => item.status === "waiting")) {
    return "waiting";
  }
  return "done";
}

function queryActivityTitle(content: ChatContent) {
  const text = chatContentTextOnly(content).replace(/\s+/g, " ").trim();
  return text ? truncateMiddle(text, 74) : "Image or attachment query";
}

function toolRunSummaryLabel(group: ActivityGroup) {
  const count = group.items.filter((item) => item.kind !== "system").length;
  if (group.status === "running") {
    return `Running ${toolEventCountLabel(count)}`;
  }
  if (group.status === "failed") {
    return `Failed ${toolEventCountLabel(count)}`;
  }
  if (group.status === "waiting") {
    return `Waiting on ${toolEventCountLabel(count)}`;
  }
  return `Ran ${toolEventCountLabel(count)}`;
}

function toolEventCountLabel(count: number) {
  return `${count} activity ${count === 1 ? "event" : "events"}`;
}

function toolRunKindLabel(item: ActivityItem) {
  if (item.kind === "call") {
    return "Call";
  }
  if (item.kind === "result") {
    return "Result";
  }
  if (item.kind === "approval") {
    return "Approval";
  }
  return "Info";
}

function capabilityLabel(capability: AgentTaskRunCapability) {
  switch (capability) {
    case "read_repo":
      return "Read";
    case "write_workspace":
      return "Write";
    case "run_command":
      return "Command";
    case "network_fetch":
      return "Network";
    case "browser_control":
      return "Browser";
    case "mcp_call":
      return "MCP";
    case "skill_context":
      return "Skill";
    case "local_context":
      return "Local context";
    default:
      return "Unknown";
  }
}

function taskRunStatusLabel(status: AgentTaskRunStatus) {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "blocked":
      return "Blocked";
    case "max_iterations":
      return "Max iterations";
    default:
      return status;
  }
}

function verificationStatusLabel(status: AgentTaskRunVerification["status"]) {
  switch (status) {
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "unknown":
      return "Unknown";
  }
}

function verificationMetaLabel(verification: AgentTaskRunVerification) {
  if (verification.status === "unknown") {
    return "Verification unknown";
  }
  return `Verification ${verificationStatusLabel(verification.status).toLowerCase()}`;
}

function planItemStatusLabel(status: NonNullable<AgentTaskRun["plan"]>["items"][number]["status"]) {
  switch (status) {
    case "completed":
      return "Done";
    case "in_progress":
      return "Doing";
    case "pending":
      return "Next";
    default:
      return "Step";
  }
}

function planReviewStatusLabel(status: NonNullable<AgentTaskRun["planReview"]>["status"]) {
  switch (status) {
    case "approved":
      return "Approved";
    case "revision_requested":
      return "Revision requested";
    case "cancelled":
      return "Cancelled";
    default:
      return "Plan review";
  }
}

function taskWorktreeActionsForRun(run: AgentTaskRun) {
  const worktree = run.worktree;
  if (!worktree?.enabled) {
    return [];
  }

  const verificationBlocked = run.verification?.status === "failed";
  const verificationBlockedReason = verificationBlocked ? "Resolve failed verification before promoting this task worktree" : undefined;
  const conflictBlockedReason = worktree.conflict ? "Resolve or abort the task worktree conflict before promoting this branch" : undefined;
  const promotionBlocked = verificationBlocked || Boolean(worktree.conflict);
  const promotionBlockedReason = conflictBlockedReason ?? verificationBlockedReason;
  const actions: Array<{
    id: TaskWorktreeAction;
    label: string;
    title: string;
    icon: ReactNode;
    disabled?: boolean;
    disabledReason?: string;
  }> = [];
  if (worktree.path && !["discarded", "cleaned"].includes(worktree.status)) {
    actions.push({
      id: "open",
      label: "Open",
      title: "Open this task worktree folder",
      icon: <FolderOpen size={12} />
    });
  }
  if (worktree.status === "ready") {
    actions.push({
      id: "refresh",
      label: "Refresh",
      title: "Refresh task worktree diff",
      icon: <RefreshCw size={12} />
    });
    if (!["queued", "running"].includes(run.status)) {
      actions.push({
        id: "preview",
        label: "Preview",
        title: worktree.conflict ? "Resolve or abort conflicts before generating a patch preview" : "Generate a patch preview before merging",
        icon: <FileText size={12} />,
        disabled: Boolean(worktree.conflict),
        disabledReason: conflictBlockedReason
      });
      actions.push({
        id: "sync",
        label: "Sync",
        title: worktree.conflict ? "Conflict resolution is already in progress" : "Sync this task branch with the current original checkout",
        icon: <GitBranch size={12} />,
        disabled: Boolean(worktree.conflict),
        disabledReason: conflictBlockedReason
      });
      const canMerge = Boolean(worktree.patchPreview) || worktree.diff?.hasChanges === false;
      if (worktree.patchPreview && !worktree.pullRequest?.url) {
        actions.push({
          id: "prepare_pr",
          label: "PR draft",
          title: "Prepare a pull request draft for this task worktree",
          icon: <GitPullRequest size={12} />,
          disabled: promotionBlocked,
          disabledReason: promotionBlockedReason
        });
      }
      if (worktree.pullRequest?.remoteName && worktree.pullRequest.baseBranch && !worktree.pullRequest.url) {
        actions.push({
          id: "create_pr",
          label: "Create PR",
          title: "Push this task branch and create a draft pull request",
          icon: <GitPullRequest size={12} />,
          disabled: promotionBlocked,
          disabledReason: promotionBlockedReason
        });
      }
      actions.push(
        {
          id: "discard",
          label: "Discard",
          title: "Delete this task worktree and its task branch",
          icon: <Trash2 size={12} />
        }
      );
      if (canMerge) {
        actions.splice(2, 0, {
          id: "merge",
          label: "Merge",
          title: "Fast-forward merge this previewed task worktree into the original checkout",
          icon: <Check size={12} />,
          disabled: promotionBlocked,
          disabledReason: promotionBlockedReason
        });
      }
    }
  } else if (worktree.status === "merged") {
    actions.push({
      id: "cleanup",
      label: "Clean up",
      title: "Remove the merged task worktree and task branch",
      icon: <Scissors size={12} />
    });
  } else if (worktree.status === "failed" && worktree.path && worktree.branch) {
    actions.push({
      id: "discard",
      label: "Discard",
      title: "Delete this failed task worktree and its task branch",
      icon: <Trash2 size={12} />
    });
  }
  return actions;
}

function taskWorktreeVerificationGate(run: AgentTaskRun, sourceRun?: AgentTaskRun) {
  const verification = run.verification;
  const worktree = run.worktree;
  if (!verification) {
    return {
      status: "unknown",
      message: "No verification summary yet. Preview remains available; run checks before PR or merge."
    };
  }
  if (verification.status === "failed") {
    return {
      status: "failed",
      message: `Promotion blocked: ${verification.summary}`
    };
  }
  if (verification.status === "unknown") {
    return {
      status: "unknown",
      message: verification.summary
    };
  }
  if (verification.status === "passed" && worktree?.enabled && worktree.status === "ready") {
    const intro =
      worktree.continuedFromTaskRunId || sourceRun?.verification?.status === "failed" ? "Repair verified" : "Verification passed";
    if (worktree.pullRequest?.url) {
      return {
        status: "passed",
        message: `${intro}: draft PR created. Continue review in GitHub or clean up after merge.`
      };
    }
    if (worktree.pullRequest?.remoteName && worktree.pullRequest.baseBranch) {
      return {
        status: "passed",
        message: `${intro}: PR draft is prepared. Create PR is available.`
      };
    }
    if (worktree.patchPreview) {
      return {
        status: "passed",
        message: `${intro}: patch preview is ready. PR draft or merge can proceed.`
      };
    }
    if (worktree.diff?.hasChanges === false) {
      return {
        status: "passed",
        message: `${intro}: no worktree changes are currently recorded. Refresh if the branch changed.`
      };
    }
    return {
      status: "passed",
      message: `${intro}: generate a patch preview before PR draft or merge.`
    };
  }
  return undefined;
}

function worktreeStatusLabel(status: AgentTaskRunWorktreeStatus) {
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

function taskWorktreeInventorySummary(items: TaskWorktreeInventoryItem[]) {
  const present = items.filter((item) => item.folderExists).length;
  if (items.length === 0) {
    return "No recorded task worktrees";
  }
  return `${items.length} recorded, ${present} present`;
}

function worktreeInventoryStatusLabel(item: TaskWorktreeInventoryItem) {
  const folder = item.folderExists ? "present" : "missing";
  const pr = item.pullRequestUrl ? " - PR created" : item.pullRequestPreparedAt ? " - PR draft" : "";
  return `${worktreeStatusLabel(item.worktreeStatus)} - ${folder}${pr} - ${item.sessionTitle}`;
}

function confirmInventoryWorktreeAction(item: TaskWorktreeInventoryItem, action: TaskWorktreeAction) {
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

function confirmCreatePullRequest(pullRequest: Pick<AgentTaskRunWorktreePullRequest, "title" | "branch"> | undefined) {
  const label = pullRequest?.title ?? pullRequest?.branch ?? "this task worktree";
  return window.confirm(`Create a draft pull request for ${label}? Arivu will push the task branch and run GitHub CLI.`);
}

function worktreeDiffLabel(diff: AgentTaskRunWorktreeDiff | undefined) {
  if (!diff) {
    return undefined;
  }
  if (!diff.hasChanges) {
    return "No changes";
  }
  const stats = [diff.insertions ? `+${diff.insertions}` : "", diff.deletions ? `-${diff.deletions}` : ""].filter(Boolean);
  return `${diff.files} file${diff.files === 1 ? "" : "s"}${stats.length ? ` ${stats.join(" ")}` : ""}`;
}

function worktreePatchDiffPreview(preview: AgentTaskRunWorktreePatchPreview | undefined): DiffPreview | null {
  if (!preview?.text.trim()) {
    return null;
  }
  return {
    ...parseUnifiedDiffPreview(preview.text),
    title: preview.truncated ? "Task patch preview (truncated)" : "Task patch preview"
  };
}

function taskWorktreeActionStatus(action: TaskWorktreeAction) {
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

function taskRunPlanActionStatus(action: TaskRunPlanAction) {
  switch (action) {
    case "approve":
      return "Plan approved";
    case "request_revision":
      return "Plan revision requested";
    case "cancel":
      return "Plan cancelled";
    default:
      return "Plan review updated";
  }
}

function formatPrStatusToken(value: string) {
  return value
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .join(" ");
}

function toolRunDetailPreview(item: ActivityItem) {
  const detail = item.detail.trim();
  if (!detail || item.imagePreview) {
    return undefined;
  }
  if (item.summary && detail === item.summary) {
    return undefined;
  }
  const maxLength = item.kind === "call" ? 360 : 260;
  return detail.length > maxLength ? `${detail.slice(0, maxLength)}...` : detail;
}

function summarizeToolCall(call: ToolCall) {
  const args = call.arguments;
  if (call.name.startsWith("browser_") && isRecord(args)) {
    return summarizeBrowserToolCall(call.name, args);
  }

  return undefined;
}

function summarizeBrowserToolCall(name: string, args: Record<string, unknown>) {
  const mode = stringValue(args.mode) ?? "active";
  const tabLabel = browserTabLabel(args);
  if (name === "browser_open") {
    if (args.newTab === true) {
      return `Open ${stringValue(args.url) ?? "URL"} in a new ${mode} browser tab.`;
    }
    return `Open ${stringValue(args.url) ?? "URL"} in ${mode} browser${tabLabel}.`;
  }
  if (name === "browser_screenshot") {
    return `Capture a screenshot from the ${mode} browser${tabLabel}.`;
  }
  if (name === "browser_snapshot") {
    return `Read a page snapshot from the ${mode} browser${tabLabel}.`;
  }
  if (name === "browser_console") {
    return `Read console output from the ${mode} browser${tabLabel}.`;
  }
  if (name === "browser_click") {
    return `Click ${quoteActivityTarget(stringValue(args.target))} in the ${mode} browser${tabLabel}.`;
  }
  if (name === "browser_click_at") {
    const x = numberValue(args.x);
    const y = numberValue(args.y);
    const coordinateSpace = stringValue(args.coordinateSpace) ?? "css";
    const target = x !== undefined && y !== undefined ? `${Math.round(x)}, ${Math.round(y)} ${coordinateSpace}` : "coordinates";
    return `Click ${target} in the ${mode} browser${tabLabel}.`;
  }
  if (name === "browser_type") {
    const submit = args.submit === true ? " and submit" : "";
    return `Type into ${quoteActivityTarget(stringValue(args.target))}${submit} in the ${mode} browser${tabLabel}.`;
  }
  return undefined;
}

function browserTabLabel(args: Record<string, unknown>) {
  const tabId = stringValue(args.tabId);
  return tabId ? ` tab ${tabId}` : "";
}

function buildToolResultActivity(message: ChatMessage): Pick<ActivityItem, "detail" | "summary" | "imagePreview"> {
  const detail = chatContentToText(message.content);
  const parsed = parseMaybeJson(detail);
  if (!isRecord(parsed)) {
    return { detail };
  }

  const action = stringValue(parsed.action);
  const mode = stringValue(parsed.mode);
  const tabId = stringValue(parsed.tabId);
  const title = stringValue(parsed.title);
  const url = stringValue(parsed.url);
  const screenshotPath = stringValue(parsed.screenshotPath);
  const size = isRecord(parsed.size) ? parsed.size : undefined;
  const width = numberValue(size?.width);
  const height = numberValue(size?.height);

  const summaryParts: string[] = [];
  if (action) {
    summaryParts.push(browserActionLabel(action));
  }
  if (mode) {
    summaryParts.push(`${mode} browser`);
  }
  if (tabId && tabId !== mode) {
    summaryParts.push(`tab ${tabId}`);
  }
  if (title) {
    summaryParts.push(title);
  } else if (url) {
    summaryParts.push(url);
  }
  const summary = summaryParts.length > 0 ? summaryParts.join(" - ") : undefined;

  if (screenshotPath) {
    const dimensions = width && height ? `${width} x ${height}` : "preview";
    return {
      detail,
      summary: summary ?? "Browser screenshot captured.",
      imagePreview: {
        path: screenshotPath,
        width,
        height,
        caption: `Browser screenshot - ${dimensions}`
      }
    };
  }

  return { detail, summary };
}

function browserActionLabel(action: string) {
  switch (action) {
    case "open":
      return "Opened page";
    case "screenshot":
      return "Captured screenshot";
    case "snapshot":
      return "Read page snapshot";
    case "console":
      return "Read console";
    case "click":
      return "Clicked page";
    case "click_at":
      return "Clicked coordinates";
    case "type":
      return "Typed into page";
    default:
      return action;
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function quoteActivityTarget(value?: string) {
  return value ? `"${truncateMiddle(value, 52)}"` : "target";
}

function truncateMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }
  const keep = Math.max(4, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function isSessionRunning(state: DesktopState, sessionId?: string) {
  return Boolean(sessionId && state.runningSessionIds.includes(sessionId));
}

function findLastUserMessage(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return { index, content: message.content };
    }
  }
  return null;
}

function applyStreamEventToMessages(messages: ChatMessage[], event: AgentStreamEvent): ChatMessage[] {
  if (event.type === "assistant_delta") {
    const { next, index } = ensureAssistantDraft(messages);
    next[index] = {
      ...next[index],
      content: `${chatContentToText(next[index].content)}${event.delta}`
    };
    return next;
  }

  if (event.type === "tool_call_delta") {
    const { next, index } = ensureAssistantDraft(messages);
    next[index] = upsertToolCall(next[index], {
      id: event.toolCallId,
      name: event.name,
      arguments: parseMaybeJson(event.argumentsText) ?? event.argumentsText
    });
    return next;
  }

  if (event.type === "tool_call") {
    const { next, index } = ensureAssistantDraft(messages);
    next[index] = upsertToolCall(next[index], event.call);
    return next;
  }

  const existingIndex = messages.findIndex((message) => message.role === "tool" && message.toolCallId === event.toolCallId);
  if (existingIndex >= 0) {
    const next = [...messages];
    next[existingIndex] = {
      ...next[existingIndex],
      name: event.name,
      content: event.result
    };
    return next;
  }

  return [
    ...messages,
    {
      role: "tool",
      toolCallId: event.toolCallId,
      name: event.name,
      content: event.result
    }
  ];
}

function ensureAssistantDraft(messages: ChatMessage[]) {
  const next = [...messages];
  const last = next.at(-1);
  if (last?.role === "assistant") {
    return { next, index: next.length - 1 };
  }

  next.push({ role: "assistant", content: "" });
  return { next, index: next.length - 1 };
}

function upsertToolCall(message: ChatMessage, call: ToolCall): ChatMessage {
  const toolCalls = [...(message.toolCalls ?? [])];
  const index = toolCalls.findIndex((existing) => existing.id === call.id);
  if (index >= 0) {
    toolCalls[index] = call;
  } else {
    toolCalls.push(call);
  }
  return {
    ...message,
    toolCalls
  };
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseMaybeJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseMcpServersText(value: string): McpServersConfig {
  const parsed = JSON.parse(value.trim() || "{}") as unknown;
  if (!isRecord(parsed)) {
    throw new Error("MCP servers must be a JSON object.");
  }

  const servers: McpServersConfig = {};
  for (const [name, server] of Object.entries(parsed)) {
    if (!isRecord(server)) {
      throw new Error(`MCP server "${name}" must be an object.`);
    }
    if (typeof server.command !== "string" || !server.command.trim()) {
      throw new Error(`MCP server "${name}" requires a command.`);
    }
    const args = server.args === undefined ? [] : server.args;
    if (!Array.isArray(args) || !args.every((entry) => typeof entry === "string")) {
      throw new Error(`MCP server "${name}" args must be an array of strings.`);
    }
    const env = server.env === undefined ? {} : server.env;
    if (!isStringRecord(env)) {
      throw new Error(`MCP server "${name}" env must be an object of string values.`);
    }
    servers[name] = {
      command: server.command.trim(),
      args,
      env,
      disabled: typeof server.disabled === "boolean" ? server.disabled : false
    };
  }
  return servers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function splitLines(value: string) {
  if (!value) {
    return [];
  }
  return value.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

function cleanDiffPath(value: string) {
  return value.replace(/^(a|b)\//, "");
}

function loadPersistedUiState(): PersistedUiState {
  try {
    const raw = window.localStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as PersistedUiState;
    return {
      theme: parsed.theme === "light" || parsed.theme === "dark" ? parsed.theme : undefined,
      uiConcept: isUiConceptId(parsed.uiConcept) ? parsed.uiConcept : undefined,
      sidebarCollapsed: typeof parsed.sidebarCollapsed === "boolean" ? parsed.sidebarCollapsed : undefined,
      sidebarWidth: typeof parsed.sidebarWidth === "number" ? parsed.sidebarWidth : undefined,
      activityCollapsed: typeof parsed.activityCollapsed === "boolean" ? parsed.activityCollapsed : undefined,
      activityWidth: typeof parsed.activityWidth === "number" ? parsed.activityWidth : undefined,
      collapsedSections: isRecord(parsed.collapsedSections)
        ? {
            projects: typeof parsed.collapsedSections.projects === "boolean" ? parsed.collapsedSections.projects : undefined,
            chats: typeof parsed.collapsedSections.chats === "boolean" ? parsed.collapsedSections.chats : undefined
          }
        : undefined
    };
  } catch {
    return {};
  }
}

function isUiConceptId(value: unknown): value is UiConceptId {
  return value === "signal" || value === "lumen" || value === "graphite";
}

function savePersistedUiState(state: PersistedUiState) {
  try {
    window.localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Local storage can be unavailable in hardened browser contexts.
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto 0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copy failed.");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

function basename(value: string) {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatDurationMs(durationMs: number) {
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function formatBytes(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

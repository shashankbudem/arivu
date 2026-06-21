import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent as ReactKeyboardEvent,
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
  Globe,
  Image as ImageIcon,
  Info,
  LayoutDashboard,
  MessageSquare,
  MoreHorizontal,
  Moon,
  Palette,
  Pencil,
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
import { estimateTokenCount, truncateTextToTokenBudget } from "./tokenBudget";
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

const AUTO_MODEL_VALUE = "auto";
const STANDALONE_PROJECT_VALUE = "__standalone__";
const COMPOSER_TOKEN_BUDGET = 8_000;
const DEFAULT_AGENT_LOOP_MAX_ITERATIONS = 5;
const MAX_IMAGE_ATTACHMENTS = 6;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const NEW_PROVIDER_NAME = "New provider";
const SIDEBAR_COLLAPSED_WIDTH = 68;
const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_MIN_WIDTH = 260;
const SIDEBAR_MAX_WIDTH = 460;
const ACTIVITY_COLLAPSED_WIDTH = 46;
const ACTIVITY_DEFAULT_WIDTH = 300;
const ACTIVITY_MIN_WIDTH = 232;
const ACTIVITY_MAX_WIDTH = 340;
const CHAT_OPTIONS_MENU_WIDTH = 132;
const CHAT_OPTIONS_MENU_HEIGHT = 40;
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
  kind: "call" | "result" | "system";
  title: string;
  detail: string;
  summary?: string;
  status?: "running" | "done" | "waiting";
  imagePreview?: {
    path: string;
    width?: number;
    height?: number;
    caption: string;
  };
};

type ActivityGroupStatus = "running" | "done" | "waiting";

type ActivityGroup = {
  id: string;
  userMessageIndex: number | null;
  title: string;
  detail: string;
  items: ActivityItem[];
  status: ActivityGroupStatus;
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

type SideBySideRow = {
  kind: "add" | "delete" | "context" | "change" | "meta";
  oldNumber?: number;
  newNumber?: number;
  left?: string;
  right?: string;
  label?: string;
};

type SideBySideDiff = {
  title: string;
  rows: SideBySideRow[];
};

type ApprovalView =
  | {
      type: "shell";
      destructive: boolean;
      command: string;
      cwd?: string;
      executable: string;
      rest: string;
      warnings: string[];
    }
  | {
      type: "write";
      destructive: boolean;
      summary: string;
      diff?: SideBySideDiff;
    }
  | {
      type: "browser";
      destructive: boolean;
      action: string;
      target: string;
      mode?: BrowserMode;
    }
  | {
      type: "unknown";
      message: string;
    };

type ProjectSummary = {
  projectRoot: string;
  name: string;
  latestSessionId?: string;
  updatedAt?: string;
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
  loopEnabled: boolean;
};

type SubmitPromptOptions = {
  reuseFailedPrompt?: boolean;
  skillNames?: string[];
  loopEnabled?: boolean;
};

type SlashCommandId = "compact" | "session" | "tools" | "skills" | "browser" | "loop";

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
    id: "browser",
    command: "browser",
    title: "Browser window",
    description: "Open the separate browser window.",
    keywords: ["open", "page", "window", "visible", "dev"]
  },
  {
    id: "loop",
    command: "loop",
    title: "Agent loop",
    description: "Toggle bounded loop mode for the next prompt.",
    keywords: ["continue", "iterate", "autonomous", "until", "done"]
  }
];

export function App() {
  const [state, setState] = useState<DesktopState | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => loadPersistedUiState().theme ?? "dark");
  const [uiConcept, setUiConcept] = useState<UiConceptId>(() => loadPersistedUiState().uiConcept ?? "signal");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
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
  const [agentLoopEnabled, setAgentLoopEnabled] = useState(false);
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
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const activeSubmissionTokenRef = useRef<string | null>(null);

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
    return () => {
      if (copyResetTimeoutRef.current) {
        clearTimeout(copyResetTimeoutRef.current);
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
  const activityGroups = activityModel.groups.filter((group) => group.items.length > 0);
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
  const promptTokens = useMemo(() => estimateTokenCount(prompt), [prompt]);
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
        agentLoopEnabled
      }),
    [agentLoopEnabled, availableSkills.length, availableTools.length, busy, compactingContext, nonSystemMessageCount, pendingSkillNames.length, state]
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

  async function attachImageFiles(files: File[], source: "pasted" | "selected") {
    if (busy) {
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

  function removeImageAttachment(id: string) {
    setImageAttachments((current) => current.filter((image) => image.id !== id));
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

  function applyDesktopState(next: DesktopState) {
    activeSubmissionTokenRef.current = null;
    setState(next);
    setMessages(next.messages);
    setBusy(isSessionRunning(next, next.sessionId));
    applyBrowserState(next.browser);
    setRetryPrompt(null);
    setFailedPrompt(null);
    setImageAttachments([]);
    setPendingSkillNames([]);
    setCommandOutput(null);
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
          ? { messages: event.messages, modelSelection: event.modelSelection, agentLoop: event.agentLoop }
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
                loopEnabled: Boolean(event.agentLoop)
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
      setAgentLoopEnabled((current) => {
        const next = !current;
        setStatus(next ? `Agent loop armed for ${DEFAULT_AGENT_LOOP_MAX_ITERATIONS} iterations` : "Agent loop off");
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
          imageAttachmentCount: imageAttachments.length
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
    const nextContent = content ?? createPromptContent(prompt, imageAttachments);
    const nextSkillNames = usingComposer ? pendingSkillNames : options.skillNames ?? [];
    const nextLoopEnabled = options.loopEnabled ?? (usingComposer ? agentLoopEnabled : false);
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
      setAgentLoopEnabled(false);
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
        setBusy(false);
        setError(formatError(err));
        setRetryPrompt(nextContent);
        setFailedPrompt({ messageIndex: failedMessageIndex, content: nextContent, skillNames: nextSkillNames, loopEnabled: nextLoopEnabled });
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
      loopEnabled: failedPrompt?.loopEnabled ?? false
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
  const standaloneSessions = sessions.filter((session) => session.projectRoot === null).slice(0, 5);
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
              title={collapsedSections.projects ? "Expand projects" : "Collapse projects"}
            >
              {collapsedSections.projects ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <span className="section-label">Projects</span>
            </button>
          </div>
          {!collapsedSections.projects ? <div className="recent-project-list">
            {recentProjects.length === 0 ? <div className="empty-sidebar-list">No recent projects yet.</div> : null}
            {recentProjects.map((project) => {
              const expanded = expandedProjectRoots[project.projectRoot] ?? project.projectRoot === state.projectRoot;
              return (
                <div
                  key={project.projectRoot}
                  className={project.projectRoot === state.projectRoot ? "project-group active" : "project-group"}
                >
                  <button
                    className="project-row"
                    type="button"
                    onClick={() => toggleProject(project.projectRoot)}
                    title={project.projectRoot}
                    aria-expanded={expanded}
                  >
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <FolderOpen className="project-folder-icon" size={14} />
                    <span className="recent-project-main">
                      <strong>{project.name}</strong>
                      <span>{project.chatCount === 0 ? "Current workspace" : `${project.chatCount} chats`}</span>
                    </span>
                  </button>
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
                                loopEnabled: failedPrompt?.loopEnabled ?? false
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
                <div className="composer-surface">
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
                            toolsOpen={toolsPopoverOpen}
                            skillsOpen={skillsPopoverOpen}
                            skillCount={availableSkills.length}
                            browserOpen={browserOpen}
                            projects={projectOptions}
                            onSelectProject={(projectRoot) => void selectChatProject(projectRoot)}
                            onOpenWorkspace={() => void chooseWorkspace()}
                            onChooseImages={() => void chooseImages()}
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
                        className={agentLoopEnabled ? "composer-loop-button active" : "composer-loop-button"}
                        type="button"
                        onClick={() => {
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
                      disabled={busy || slashQuery !== null || !chatContentHasRenderableContent(createPromptContent(prompt, imageAttachments))}
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
                          <ActivityGroupCard key={group.id} group={group} />
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
  toolsOpen,
  skillsOpen,
  skillCount,
  browserOpen,
  projects,
  onSelectProject,
  onOpenWorkspace,
  onChooseImages,
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
  toolsOpen: boolean;
  skillsOpen: boolean;
  skillCount: number;
  browserOpen: boolean;
  projects: ProjectOption[];
  onSelectProject: (projectRoot: string | null) => void;
  onOpenWorkspace: () => void;
  onChooseImages: () => void;
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
                {session.running ? <span className="chat-loading-dot" title="Response loading" aria-label="Response loading" /> : null}
              </div>
              <div className="history-details">
                <span>{formatDateTime(session.updatedAt)}</span>
                <span title={session.cwd}>{basename(session.cwd)}</span>
                <span title={sessionModelTitle(session)}>{sessionModelLabel(session)}</span>
                {session.agentLoop ? <span title={agentLoopStatusLabel(session.agentLoop)}>{sessionLoopLabel(session.agentLoop)}</span> : null}
                <span>{session.messageCount} messages</span>
              </div>
            </button>
            <ChatOptionsMenu
              open={openMenuId === session.id}
              title={session.title}
              disabled={deletingId === session.id}
              onToggle={() => onToggleMenu(session.id)}
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
  onDelete
}: {
  session: SessionSummary;
  active: boolean;
  menuOpen: boolean;
  className?: string;
  onOpen: () => void;
  onToggleMenu: () => void;
  onDelete: () => void;
}) {
  const classes = ["recent-chat-item", active ? "active" : "", className ?? ""].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      <button className="recent-chat-row" type="button" onClick={onOpen}>
        <div className="recent-chat-main">
          <strong>{session.title}</strong>
          {session.running ? <span className="chat-loading-dot" title="Response loading" aria-label="Response loading" /> : null}
        </div>
        <div className="recent-chat-details">
          <span>{formatDateTime(session.updatedAt)}</span>
          <span title={sessionModelTitle(session)}>{sessionModelLabel(session)}</span>
          {session.agentLoop ? <span title={agentLoopStatusLabel(session.agentLoop)}>{sessionLoopLabel(session.agentLoop)}</span> : null}
          <span>{session.messageCount} messages</span>
        </div>
      </button>
      <ChatOptionsMenu
        open={menuOpen}
        title={session.title}
        onToggle={onToggleMenu}
        onDelete={onDelete}
      />
    </div>
  );
}

function ChatOptionsMenu({
  open,
  title,
  disabled,
  onToggle,
  onDelete
}: {
  open: boolean;
  title: string;
  disabled?: boolean;
  onToggle: () => void;
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
    <section className={`tool-run-summary ${group.status}`} aria-label={`Tool activity for ${group.title}`}>
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

function ActivityGroupCard({ group }: { group: ActivityGroup }) {
  const [collapsed, setCollapsed] = useState(group.status !== "running");
  const toolItemCount = group.items.filter((item) => item.kind !== "system").length;

  return (
    <section className={`activity-group ${group.status}`}>
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
      {!collapsed ? (
        <div className="activity-group-body">
          {group.items.map((item) => (
            <ActivityRow key={item.id} item={item} defaultCollapsed />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ActivityRow({ item, defaultCollapsed }: { item: ActivityItem; defaultCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? item.kind === "system");
  const diff = buildActivityDiffPreview(item);

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
        {item.status ? <span className={`activity-status ${item.status}`}>{activityStatusLabel(item.status)}</span> : null}
      </button>
      {!collapsed ? (
        <div className="activity-body">
          {item.summary ? <p className="activity-summary">{item.summary}</p> : null}
          {item.imagePreview ? <ActivityScreenshotPreview preview={item.imagePreview} /> : null}
          {diff ? <DiffBlock preview={diff} /> : item.detail ? <pre>{item.detail}</pre> : null}
        </div>
      ) : null}
    </article>
  );
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
  onSaved
}: {
  state: DesktopState;
  skills: SkillSummary[];
  skillsRoot: string;
  focusSection: SettingsFocus;
  onFocusSettled: () => void;
  onSkillsChanged: (skills: SkillSummary[], skillsRoot: string) => void;
  onSaved: (state: DesktopState) => void;
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
        mcpServers
      };
      if (providerPatch.activeProvider.apiKey?.trim()) {
        patch.apiKey = providerPatch.activeProvider.apiKey.trim();
      }
      if (tavilyApiKey.trim()) {
        patch.tavilyApiKey = tavilyApiKey.trim();
      }
      const next = await window.arivu.saveConfig(patch);
      onSaved(next);
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
          <span className="shell-executable">{view.executable}</span>
          {view.rest ? <span className="shell-rest">{view.rest}</span> : null}
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

function parseApprovalMessage(message: string): ApprovalView {
  const shellMatch = /^(Destructive shell command|Shell command):\s*(.*)$/m.exec(message);
  if (shellMatch) {
    const command = shellMatch[2].trim();
    const cwd = /^Working directory:\s*(.*)$/m.exec(message)?.[1]?.trim();
    const [executable, ...rest] = tokenizeCommand(command);
    return {
      type: "shell",
      destructive: shellMatch[1].startsWith("Destructive"),
      command,
      cwd,
      executable: executable ?? command,
      rest: rest.join(" "),
      warnings: detectCommandWarnings(command)
    };
  }

  const writeMatch = /^(Destructive write|Write):\s*(.*)$/m.exec(message);
  if (writeMatch) {
    return {
      type: "write",
      destructive: writeMatch[1].startsWith("Destructive"),
      summary: writeMatch[2].trim(),
      diff: parseApprovalDiff(message)
    };
  }

  const browserMatch = /^(Browser action|Browser read):\s*(.*)$/m.exec(message);
  if (browserMatch) {
    const mode = /^Mode:\s*(visible|background)$/m.exec(message)?.[1] as BrowserMode | undefined;
    return {
      type: "browser",
      destructive: browserMatch[1] === "Browser action",
      action: browserMatch[2].trim(),
      target: /^Target:\s*(.*)$/m.exec(message)?.[1]?.trim() ?? "",
      mode
    };
  }

  return { type: "unknown", message };
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
  return "The agent wants to perform an action that changes state or runs a command.";
}

function parseApprovalDiff(message: string): SideBySideDiff | undefined {
  const diffIndex = message.indexOf("\nDiff:\n");
  if (diffIndex >= 0) {
    return parseUnifiedSideBySide(message.slice(diffIndex + "\nDiff:\n".length));
  }

  const originalIndex = message.indexOf("\nOriginal:\n");
  const proposedIndex = message.lastIndexOf("\nProposed:\n");
  if (originalIndex < 0 || proposedIndex < 0 || proposedIndex < originalIndex) {
    return undefined;
  }

  const path = /^Path:\s*(.*)$/m.exec(message)?.[1]?.trim() ?? "write_file";
  const original = message.slice(originalIndex + "\nOriginal:\n".length, proposedIndex);
  const proposed = message.slice(proposedIndex + "\nProposed:\n".length);
  return buildTextSideBySide(path, original, proposed);
}

function parseUnifiedSideBySide(diff: string): SideBySideDiff {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const result: SideBySideDiff = { title: "patch", rows: [] };
  let oldNumber = 0;
  let newNumber = 0;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      result.title = cleanDiffPath(line.slice(4).trim());
      continue;
    }
    if (line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNumber = Number(match?.[1] ?? 0);
      newNumber = Number(match?.[2] ?? 0);
      result.rows.push({ kind: "meta", label: line });
      continue;
    }
    if (line.startsWith("+")) {
      result.rows.push({ kind: "add", newNumber, right: line.slice(1) });
      newNumber += 1;
      continue;
    }
    if (line.startsWith("-")) {
      result.rows.push({ kind: "delete", oldNumber, left: line.slice(1) });
      oldNumber += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      const text = line.slice(1);
      result.rows.push({ kind: "context", oldNumber, newNumber, left: text, right: text });
      oldNumber += 1;
      newNumber += 1;
    }
  }

  return result;
}

function buildTextSideBySide(title: string, original: string, proposed: string): SideBySideDiff {
  const originalLines = splitLines(original);
  const proposedLines = splitLines(proposed);
  const count = Math.max(originalLines.length, proposedLines.length);
  const rows: SideBySideRow[] = [];

  for (let index = 0; index < count; index += 1) {
    const left = originalLines[index];
    const right = proposedLines[index];
    if (left === right) {
      rows.push({ kind: "context", oldNumber: index + 1, newNumber: index + 1, left, right });
    } else if (left === undefined) {
      rows.push({ kind: "add", newNumber: index + 1, right });
    } else if (right === undefined) {
      rows.push({ kind: "delete", oldNumber: index + 1, left });
    } else {
      rows.push({ kind: "change", oldNumber: index + 1, newNumber: index + 1, left, right });
    }
  }

  return { title, rows };
}

function tokenizeCommand(command: string) {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
}

function detectCommandWarnings(command: string) {
  const checks: Array<[RegExp, string]> = [
    [/\brm\s+(-[^\s]*r[^\s]*|-rf|-fr)\b/, "rm -rf"],
    [/\bsudo\b/, "sudo"],
    [/\b--force\b|\s-f(\s|$)/, "--force"],
    [/(^|[^>])>\s*[^&]|\b2>\s*/, "redirect"]
  ];
  return checks.filter(([pattern]) => pattern.test(command)).map(([, label]) => label);
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
  agentLoopEnabled
}: {
  state: DesktopState | null;
  busy: boolean;
  compactingContext: boolean;
  nonSystemMessageCount: number;
  availableToolCount: number;
  availableSkillCount: number;
  pendingSkillCount: number;
  agentLoopEnabled: boolean;
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

    if (command.id === "loop") {
      return {
        ...command,
        detail: agentLoopEnabled ? "Currently armed" : `${DEFAULT_AGENT_LOOP_MAX_ITERATIONS} iteration budget`
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
  imageAttachmentCount
}: {
  state: DesktopState;
  messages: ChatMessage[];
  estimatedContextTokens: number;
  availableToolCount: number;
  imageAttachmentCount: number;
}): CommandOutput {
  const nonSystemCount = messages.filter((message) => message.role !== "system").length;
  const remainingTokens = Math.max(0, COMPOSER_TOKEN_BUDGET - estimatedContextTokens);
  const provider = activeProviderForState(state);

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
      { label: "Trust mode", value: state.config.trustMode },
      {
        label: "Context used",
        value: `~${formatNumber(estimatedContextTokens)} / ${formatNumber(COMPOSER_TOKEN_BUDGET)} tokens`
      },
      { label: "Context remaining", value: `~${formatNumber(remainingTokens)} tokens` },
      { label: "Messages", value: `${formatNumber(nonSystemCount)} chat, ${formatNumber(messages.length)} total` },
      { label: "Attached images", value: `${formatNumber(imageAttachmentCount)} / ${formatNumber(MAX_IMAGE_ATTACHMENTS)}` },
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
        chatCount: 1,
        sessions: [session]
      });
      continue;
    }

    existing.chatCount += 1;
    existing.sessions.push(session);
    if (!existing.updatedAt || session.updatedAt > existing.updatedAt) {
      existing.latestSessionId = session.id;
      existing.updatedAt = session.updatedAt;
    }
  }

  const projects = Array.from(projectsByRoot.values()).sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  for (const project of projects) {
    project.sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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

function createPromptContent(text: string, images: ImageAttachment[]): ChatContent {
  const trimmed = text.trim();
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
  const files = Array.from(clipboard.files).filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
  if (files.length > 0) {
    return files;
  }

  return Array.from(clipboard.items)
    .filter((item) => item.kind === "file" && SUPPORTED_IMAGE_TYPES.has(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

async function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    throw new Error(`${file.name || "Image"} must be a PNG, JPEG, WebP, or GIF file.`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`${file.name || "Image"} is larger than ${formatBytes(MAX_IMAGE_BYTES)}.`);
  }

  return {
    id: randomId(),
    name: file.name || `pasted-image-${Date.now()}`,
    mimeType: file.type,
    size: file.size,
    dataUrl: await readFileAsDataUrl(file),
    detail: "auto"
  };
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
        status: "done"
      };
      currentGroup = group;
      groups.push(group);
      groupsByUserMessageIndex.set(index, group);
      return;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      const group = activeGroup();
      for (const call of message.toolCalls) {
        const complete = completedToolCallIds.has(call.id);
        group.items.push({
          id: `call-${index}-${call.id}`,
          kind: "call",
          title: call.name,
          detail: safeJson(call.arguments),
          summary: summarizeToolCall(call),
          status: complete ? "done" : currentSessionRunning ? "running" : "waiting"
        });
      }
    }
    if (message.role === "tool") {
      const group = activeGroup();
      const toolResult = buildToolResultActivity(message);
      group.items.push({
        id: `tool-${index}-${message.toolCallId ?? message.name}`,
        kind: "result",
        title: message.name ?? "tool",
        detail: toolResult.detail,
        summary: toolResult.summary,
        imagePreview: toolResult.imagePreview
      });
    }
  });

  for (const group of groups) {
    group.status = deriveActivityGroupStatus(group.items);
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

function deriveActivityGroupStatus(items: ActivityItem[]): ActivityGroupStatus {
  if (items.some((item) => item.status === "running")) {
    return "running";
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
  if (group.status === "waiting") {
    return `Waiting on ${toolEventCountLabel(count)}`;
  }
  return `Ran ${toolEventCountLabel(count)}`;
}

function toolEventCountLabel(count: number) {
  return `${count} tool ${count === 1 ? "event" : "events"}`;
}

function toolRunKindLabel(item: ActivityItem) {
  if (item.kind === "call") {
    return "Call";
  }
  if (item.kind === "result") {
    return "Result";
  }
  return "Info";
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

function formatBytes(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

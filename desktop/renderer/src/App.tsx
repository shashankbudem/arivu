import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import { ElicitationDialog } from "./ElicitationDialog";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Globe,
  Image as ImageIcon,
  Info,
  ListChecks,
  LoaderCircle,
  Moon,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Rows3,
  Search,
  Scissors,
  Settings,
  Square,
  Sun,
  X
} from "lucide-react";
import { basename, capitalize, clamp, formatDateTime, formatError, formatNumber, writeClipboardText } from "./format";
import { estimateTokenCount, truncateTextToTokenBudget } from "./tokenBudget";
import { deriveVisibleMessages } from "./messagePresentation";
import { promptTextWithFileContext } from "../../../src/agent/fileContext";
import { webSearchProviderRequiresApiKey } from "../../../src/tools/webSearchProvider";
import arivuLogoUrl from "../../../assets/arivu-logo.svg";
import { resolveAppKeyboardShortcut } from "./keyboardShortcuts";
import { SettingsView, type SettingsFocus } from "./features/settings/SettingsView";
import { ModelPickerDialog } from "./features/models/ModelPickerDialog";
import { activeProviderName, isAutoModelId, modelDisplayName } from "./features/models/providerCatalog";
import {
  confirmCreatePullRequest,
  taskWorktreeActionStatus,
  worktreeStatusLabel,
  type TaskWorktreeAction,
  type TaskWorktreeActionOptions
} from "./features/worktrees/worktreePresentation";
import { capabilityLabel, trustModeLabel } from "./features/activity/capabilityPresentation";
import { randomId } from "./shared/id";
import { isRecord } from "./shared/typeGuards";
import {
  MAX_CONTEXT_FILE_ATTACHMENTS,
  MAX_IMAGE_ATTACHMENTS,
  applyStreamEventToMessages,
  chatContentEquals,
  chatContentHasRenderableContent,
  chatContentTextOnly,
  chatContentToText,
  createPromptContent,
  fileToImageAttachment,
  findLastUserMessage,
  hasFileTransfer,
  hasPotentialImageTransfer,
  imageAttachmentsFromContent,
  imageFilesFromClipboard,
  imageFilesFromDataTransfer,
  mergeFileAttachments,
  mergeImageAttachments
} from "./features/chat/chatContent";
import { deriveActivityModel, findLatestActivityScreenshot, taskRunStatusLabel } from "./features/activity/activityModel";
import type { ActivityEvidenceLink, ActivityGroup } from "./features/activity/activityTypes";
import { shortRunId } from "./shared/id";
import { pullRequestWatchKey, taskRunPlanActionStatus, worktreeDiffLabel } from "./features/worktrees/WorktreeActivity";
import type {
  DraftPromptOptions,
  PullRequestWatch,
  TaskRunPlanAction,
  WorktreeContinuation,
  WorktreePlanSource
} from "./features/worktrees/worktreeTypes";
import { ActivityGroupCard, ActivityRow, LatestActivityScreenshot, ToolRunSummary } from "./features/activity/ActivityPanel";
import { isSessionRunning } from "./features/sessions/sessionState";
import { ApprovalDialog } from "./features/approvals/ApprovalDialog";
import { FirstRunOnboarding } from "./features/onboarding/FirstRunOnboarding";
import { PasteReviewDialog, type PasteReview } from "./features/chat/PasteReviewDialog";
import { WorkspaceScaffoldDialog } from "./features/workspaces/WorkspaceScaffoldDialog";
import { EmptyConversation, MessageBubble, QueuedPromptList } from "./features/chat/ChatMessages";
import { HistoryView, SidebarChatItem } from "./features/history/HistoryView";
import {
  ChatSearchBar,
  CommandOutputPanel,
  ComposerOptionsMenu,
  FileAttachmentStrip,
  ImageAttachmentStrip,
  ModelSwitcher,
  SendArrowIcon,
  SkillContextStrip,
  SkillPanel,
  SlashCommandMenu,
  ToolPanel
} from "./features/composer/ComposerControls";
import { compareSessionsForDisplay, deriveProjects, type ProjectOption, type ProjectSummary } from "./features/history/projectModel";
import type { CommandOutput, SlashCommandDefinition, SlashCommandEntry } from "./features/commands/commandTypes";
import { agentLoopStatusFromEvent, agentLoopStatusLabel } from "./features/sessions/agentLoopPresentation";

type ViewMode = "chat" | "history" | "settings";
type ThemeMode = "dark" | "light";
type SidebarSectionId = "projects" | "chats";
type ResizeTarget = "sidebar" | "activity";
const COMPOSER_TOKEN_BUDGET = 8_000;
const DEFAULT_AGENT_LOOP_MAX_ITERATIONS = 5;
const SIDEBAR_COLLAPSED_WIDTH = 68;
const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_MIN_WIDTH = 260;
const SIDEBAR_MAX_WIDTH = 460;
const SIDEBAR_STANDALONE_CHAT_LIMIT = 10;
const ACTIVITY_COLLAPSED_WIDTH = 46;
const ACTIVITY_DEFAULT_WIDTH = 300;
const ACTIVITY_MIN_WIDTH = 232;
const ACTIVITY_MAX_WIDTH = 340;
const PR_BACKGROUND_REFRESH_INTERVAL_MS = 90_000;
const CONTEXT_COMPACT_RECENT_MESSAGE_COUNT = 8;
const UI_STATE_STORAGE_KEY = "arivu.uiState.v1";
const DEFAULT_COLLAPSED_SECTIONS: Record<SidebarSectionId, boolean> = {
  projects: false,
  chats: false
};

type PersistedUiState = {
  theme?: ThemeMode;
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
  retryFromUserMessageIndex?: number;
  skillNames?: string[];
  planModeEnabled?: boolean;
  loopEnabled?: boolean;
  worktreeEnabled?: boolean;
  worktreeTaskRunId?: string;
  worktreeReplayOfTaskRunId?: string;
  worktreePlannedFromTaskRunId?: string;
};

type RetryPromptTarget = {
  content: ChatContent;
  userMessageIndex: number;
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
    id: "summarize",
    command: "summarize",
    title: "Summarize context",
    description: "Ask the model to summarize older messages, keeping recent turns verbatim.",
    keywords: ["context", "compact", "model", "trim"]
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
    description: "Open the tools list to review statuses and switch tools on or off.",
    keywords: ["list", "available", "registry", "enable", "disable", "toggle"]
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
    id: "browsermodel",
    command: "browsermodel",
    title: "Browser task model",
    description: "Set the model the in-page browser_task agent uses. Add a model id to set it instantly, or run bare to pick.",
    keywords: ["llm", "model", "browser", "task", "agent", "provider", "pin"]
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  const [fileAttachments, setFileAttachments] = useState<ContextFileAttachment[]>([]);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queueSubmissionBusy, setQueueSubmissionBusy] = useState(false);
  const [steeringPromptId, setSteeringPromptId] = useState<string | null>(null);
  const [status, setStatus] = useState("Starting");
  const [view, setView] = useState<ViewMode>("chat");
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [elicitation, setElicitation] = useState<ElicitationPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryPrompt, setRetryPrompt] = useState<ChatContent | null>(null);
  const [failedPrompt, setFailedPrompt] = useState<FailedPrompt | null>(null);
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [compactingContext, setCompactingContext] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
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
  const [undoBusyRunId, setUndoBusyRunId] = useState<string | null>(null);
  const [planReviewBusy, setPlanReviewBusy] = useState<string | null>(null);
  const [evidenceOpenBusy, setEvidenceOpenBusy] = useState<string | null>(null);
  const [watchedPullRequests, setWatchedPullRequests] = useState<Record<string, PullRequestWatch>>({});
  const [pullRequestWatchBusy, setPullRequestWatchBusy] = useState<Record<string, boolean>>({});
  const [focusedActivityRunId, setFocusedActivityRunId] = useState<string | null>(null);
  // Live, ephemeral browser_task step data -- never persisted into `messages` (that reducer
  // treats browser_task_progress as a no-op on purpose, same as the streaming deltas), just the
  // chrome-side half of the same live view the in-page presence chip shows on the page itself.
  // Cleared once the in-flight browser_task's own tool_result lands.
  const [liveBrowserTaskStep, setLiveBrowserTaskStep] = useState<{
    stepIndex: number;
    summary: string;
    evaluation?: string;
    memory?: string;
  } | null>(null);
  const [browserState, setBrowserState] = useState<BrowserState | null>(null);
  const [toolsPopoverOpen, setToolsPopoverOpen] = useState(false);
  const [skillsPopoverOpen, setSkillsPopoverOpen] = useState(false);
  const [composerOptionsOpen, setComposerOptionsOpen] = useState(false);
  const [browserTaskModelPickerOpen, setBrowserTaskModelPickerOpen] = useState(false);
  const [apiRequestLog, setApiRequestLog] = useState<ApiRequestLogEntry[]>([]);
  const [apiLogOpen, setApiLogOpen] = useState(false);
  const [settingsFocus, setSettingsFocus] = useState<SettingsFocus>(null);
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);
  const [commandOutput, setCommandOutput] = useState<CommandOutput | null>(null);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [chatSearchIndex, setChatSearchIndex] = useState(0);
  const [pasteReview, setPasteReview] = useState<PasteReview | null>(null);
  const [workspaceScaffoldOpen, setWorkspaceScaffoldOpen] = useState(false);
  const [openingWorkspaceRoot, setOpeningWorkspaceRoot] = useState<string | null>(null);
  const [forgettingProjectRoot, setForgettingProjectRoot] = useState<string | null>(null);
  const [openChatMenuId, setOpenChatMenuId] = useState<string | null>(null);
  const [openHistoryMenuId, setOpenHistoryMenuId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => loadPersistedUiState().theme ?? "dark");
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
  const recentChatListRef = useRef<HTMLDivElement | null>(null);
  const [visibleChatCount, setVisibleChatCount] = useState(SIDEBAR_STANDALONE_CHAT_LIMIT);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const chatSearchInputRef = useRef<HTMLInputElement | null>(null);
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityFocusResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const activeSubmissionTokenRef = useRef<string | null>(null);
  const composerDragDepthRef = useRef(0);
  const browserHandoffIdRef = useRef(0);

  const standaloneSessionCount = sessions.filter((session) => session.projectRoot === null).length;
  useLayoutEffect(() => {
    const container = recentChatListRef.current;
    if (!container || sidebarCollapsed || collapsedSections.chats || standaloneSessionCount === 0) {
      return;
    }
    const recompute = () => {
      const firstItem = container.querySelector<HTMLElement>(".recent-chat-item");
      if (!firstItem) {
        return;
      }
      const itemHeight = firstItem.getBoundingClientRect().height;
      if (itemHeight <= 0) {
        return;
      }
      const gap = parseFloat(getComputedStyle(container).rowGap || "0") || 0;
      const available = container.clientHeight;
      const count = Math.max(1, Math.floor((available + gap) / (itemHeight + gap)));
      setVisibleChatCount((current) => (current === count ? current : count));
    };
    const observer = new ResizeObserver(recompute);
    observer.observe(container);
    recompute();
    return () => observer.disconnect();
  }, [sidebarCollapsed, collapsedSections.chats, standaloneSessionCount]);
  const pullRequestWatchInFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    void refresh();
    void loadSessions();
    void loadTools();
    void loadSkills();
    void loadBrowserState();
    void loadApiRequestLog();
    const stopApiLog = window.arivu.onApiRequestLog((entry) => {
      setApiRequestLog((current) => [entry, ...current].slice(0, 50));
    });
    const stopApprovals = window.arivu.onApprovalRequest((payload) => {
      setApproval(payload);
      setStatus("Approval required");
    });
    const stopElicitations = window.arivu.onElicitationRequest((payload) => {
      setElicitation(payload);
      setStatus("The agent has a question");
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
      stopApiLog();
      stopApprovals();
      stopElicitations();
      stopAgentEvents();
      stopSessionEvents();
      stopBrowserState();
    };
  }, []);

  useEffect(() => {
    activeSessionIdRef.current = state?.sessionId;
    // A stale step from whatever session was active before must not linger under the newly
    // selected one; a fresh browser_task_progress event (if this session has one running) will
    // repopulate it immediately.
    setLiveBrowserTaskStep(null);
  }, [state?.sessionId]);

  useEffect(() => {
    if (view === "settings") {
      void refresh();
    }
  }, [view]);

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
    document.documentElement.removeAttribute("data-ui-concept");
  }, [theme]);

  useEffect(() => {
    savePersistedUiState({
      theme,
      sidebarCollapsed,
      sidebarWidth,
      activityCollapsed,
      activityWidth,
      collapsedSections
    });
  }, [theme, sidebarCollapsed, sidebarWidth, activityCollapsed, activityWidth, collapsedSections]);

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
      if (
        event.target instanceof Element &&
        event.target.closest(".composer-tools-region, .composer-skills-region, .composer-menu-region")
      ) {
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
  const fallbackNonSystemMessageCount = useMemo(() => messages.filter((message) => message.role !== "system").length, [messages]);
  const fallbackEstimatedContextTokens = useMemo(() => estimateContextTokens(messages), [messages]);
  const nonSystemMessageCount = state?.context.messageCount ?? fallbackNonSystemMessageCount;
  const estimatedContextTokens = state?.context.estimatedTokens ?? fallbackEstimatedContextTokens;
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
  const visibleMessages = useMemo(() => deriveVisibleMessages(messages), [messages]);
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
      if (!project.projectRootExists) {
        byRoot.delete(project.projectRoot);
        continue;
      }
      byRoot.set(project.projectRoot, {
        projectRoot: project.projectRoot,
        name: project.name,
        projectRootExists: project.projectRootExists,
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
      if (!project.projectRootExists) {
        continue;
      }
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
    const command = filteredSlashCommands[selectedSlashCommandIndex];
    if (!command) {
      return;
    }
    document.getElementById(`slash-command-${command.id}`)?.scrollIntoView({ block: "nearest" });
  }, [filteredSlashCommands, selectedSlashCommandIndex]);

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

  async function forgetMissingProject(project: ProjectSummary) {
    if (forgettingProjectRoot || project.projectRootExists) {
      return;
    }
    const confirmed = window.confirm(
      `Forget missing workspace "${project.name}"?\n\nArivu will remove the unavailable folder from Workspaces and keep its ${formatNumber(
        project.chatCount
      )} chat${project.chatCount === 1 ? "" : "s"} in standalone history.`
    );
    if (!confirmed) {
      return;
    }

    setForgettingProjectRoot(project.projectRoot);
    setError(null);
    try {
      const next = await window.arivu.forgetMissingProject(project.projectRoot);
      applyDesktopState(next);
      await loadSessions();
      setRememberedProjectOptions((current) => {
        if (!(project.projectRoot in current)) {
          return current;
        }
        const updated = { ...current };
        delete updated[project.projectRoot];
        return updated;
      });
      setExpandedProjectRoots((current) => {
        if (!(project.projectRoot in current)) {
          return current;
        }
        const updated = { ...current };
        delete updated[project.projectRoot];
        return updated;
      });
      setStatus(`Forgot missing workspace: ${project.name}`);
    } catch (err) {
      setError(formatError(err));
      setStatus("Forget workspace failed");
    } finally {
      setForgettingProjectRoot((current) => (current === project.projectRoot ? null : current));
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

  async function toggleToolDisabled(name: string, disabled: boolean) {
    // Optimistic flip so the switch responds instantly; a failed save reloads the real state.
    setAvailableTools((current) => current.map((tool) => (tool.name === name ? { ...tool, disabled } : tool)));
    // The saved list is the source of truth: it can hold names of tools that are not currently
    // registered (for example MCP tools with no server configured), and those must survive toggles.
    const nextDisabled = new Set(state?.config.disabledTools ?? []);
    if (disabled) {
      nextDisabled.add(name);
    } else {
      nextDisabled.delete(name);
    }
    try {
      const next = await window.arivu.saveConfig({ disabledTools: [...nextDisabled] });
      // Only adopt the config slice: a toggle mid-run must not replace the streaming messages
      // with the main process's snapshot of them.
      setState((current) => (current ? { ...current, config: next.config } : next));
      setError(null);
      setStatus(disabled ? `Tool ${name} turned off — applies from the agent's next step` : `Tool ${name} turned back on`);
    } catch (err) {
      setError(formatError(err));
      await loadTools();
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
    const handoff = next.collaboration?.handoff;
    if (handoff && handoff.id > browserHandoffIdRef.current) {
      browserHandoffIdRef.current = handoff.id;
      setPrompt((current) => [current.trim(), handoff.prompt].filter(Boolean).join("\n\n"));
      void attachBrowserHandoffScreenshots(handoff.screenshotPaths);
      setStatus(
        handoff.screenshotPaths.length > 0 ? "Browser notes and captures added to the composer" : "Browser notes added to the composer"
      );
      requestAnimationFrame(() => promptInputRef.current?.focus());
    }
  }

  async function attachBrowserHandoffScreenshots(paths: string[]) {
    const available = paths.slice(0, MAX_IMAGE_ATTACHMENTS);
    const images = await Promise.all(
      available.map(async (filePath): Promise<ImageAttachment | null> => {
        try {
          const image = await window.arivu.readLocalImage(filePath);
          return {
            id: randomId(),
            name: filePath.split(/[\\/]/).pop() || "browser-capture.png",
            mimeType: image.mimeType,
            size: image.size,
            dataUrl: image.dataUrl,
            detail: "auto"
          };
        } catch {
          return null;
        }
      })
    );
    setImageAttachments((current) =>
      mergeImageAttachments(
        current,
        images.filter((image): image is ImageAttachment => Boolean(image))
      )
    );
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

  async function toggleBrowserPaneOpen() {
    try {
      const next = await window.arivu.toggleBrowserPaneOpen();
      applyBrowserState(next);
      setStatus(next.paneOpen ? "Browser window opened" : "Browser window hidden");
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

  async function showToolsPopover() {
    const tools = await loadTools();
    setToolsPopoverOpen(true);
    setSkillsPopoverOpen(false);
    setComposerOptionsOpen(false);
    setStatus(`Showing ${formatNumber((tools ?? availableTools).length)} tools`);
  }

  async function showSkillsPopover() {
    const skills = await loadSkills();
    setSkillsPopoverOpen(true);
    setToolsPopoverOpen(false);
    setComposerOptionsOpen(false);
    setStatus(`Showing ${formatNumber((skills ?? availableSkills).length)} skills`);
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
      `Compact what the agent reads? Arivu will keep the complete chat history visible and saved, while the agent continues from a local summary plus the most recent ${CONTEXT_COMPACT_RECENT_MESSAGE_COUNT} messages.`
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
      setStatus(result.compacted ? `Compacted ${formatNumber(result.compactedMessageCount)} older messages` : "Context already compact");
      return true;
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
      return false;
    } finally {
      setCompactingContext(false);
    }
  }

  async function summarizeContext(): Promise<boolean> {
    if (busy || compactingContext || !state?.sessionId) {
      return false;
    }

    const confirmed = window.confirm(
      `Summarize what the agent reads with the model? Arivu will keep the complete chat history visible and saved, while the agent continues from the generated summary plus the most recent ${CONTEXT_COMPACT_RECENT_MESSAGE_COUNT} messages.`
    );
    if (!confirmed) {
      return false;
    }

    setCompactingContext(true);
    setError(null);
    setStatus("Summarizing context");
    try {
      const result = await window.arivu.summarizeContext();
      applyDesktopState(result.state);
      await loadSessions();
      setStatus(result.compacted ? `Summarized ${formatNumber(result.compactedMessageCount)} older messages` : "Context already compact");
      return true;
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
      return false;
    } finally {
      setCompactingContext(false);
    }
  }

  async function handleUndoRun(run: AgentTaskRun) {
    if (!state?.sessionId || undoBusyRunId) {
      return;
    }
    const count = run.checkpoint?.changedPaths.length ?? 0;
    const confirmed = window.confirm(
      `Undo this run's changes to ${count} file${count === 1 ? "" : "s"}? Files will be restored to their pre-run state. This cannot be undone.`
    );
    if (!confirmed) {
      return;
    }
    setUndoBusyRunId(run.id);
    setError(null);
    try {
      const result = await window.arivu.undoTaskRun({ sessionId: state.sessionId, taskRunId: run.id });
      applyDesktopState(result.state);
      await loadSessions();
      setStatus(`Reverted ${formatNumber(result.revertedCount)} file${result.revertedCount === 1 ? "" : "s"}`);
    } catch (err) {
      setError(formatError(err));
      setStatus("Error");
    } finally {
      setUndoBusyRunId(null);
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

  async function refreshWatchedPullRequest(key: string, watch: PullRequestWatch, options: { silent?: boolean } = {}) {
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
      const confirmed = window.confirm(
        options.confirmLabel ?? "Replace the current composer draft with a repair prompt from this report evidence?"
      );
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

  // Resolves the endpoint/model the browser-task picker should show, mirroring the Settings panel:
  // a pinned provider/model wins, otherwise it falls back to the active chat provider's values.
  function browserTaskPickerContext() {
    const config = state?.config;
    const providers = config?.providers ?? [];
    const activeProvider = providers.find((provider) => provider.id === config?.activeProviderId) ?? providers[0];
    const profile = config?.browserTaskModel;
    const pinnedProvider = profile?.providerId ? providers.find((provider) => provider.id === profile.providerId) : undefined;
    const provider = pinnedProvider ?? activeProvider;
    const baseUrl = profile?.baseUrl ?? provider?.baseUrl ?? config?.baseUrl ?? "";
    const providerModel = provider?.model ?? config?.model ?? "";
    const currentModel = profile?.model ?? providerModel;
    return { baseUrl, currentModel, providerId: profile?.providerId ?? provider?.id };
  }

  function openBrowserTaskModelPicker() {
    setComposerOptionsOpen(false);
    setToolsPopoverOpen(false);
    setSkillsPopoverOpen(false);
    setBrowserTaskModelPickerOpen(true);
  }

  async function loadApiRequestLog() {
    try {
      setApiRequestLog(await window.arivu.getApiRequestLog());
    } catch {
      // A missing log is non-fatal; the panel just shows empty.
    }
  }

  async function clearApiRequestLogEntries() {
    try {
      await window.arivu.clearApiRequestLog();
      setApiRequestLog([]);
    } catch (err) {
      setError(formatError(err));
    }
  }

  function openApiLog() {
    setComposerOptionsOpen(false);
    setToolsPopoverOpen(false);
    setSkillsPopoverOpen(false);
    setApiLogOpen(true);
  }

  async function applyBrowserTaskModel(model: string) {
    const trimmed = model.trim();
    if (!trimmed) {
      return;
    }
    try {
      // Only change the model; preserve any pinned provider (and the merge layer preserves
      // hand-configured baseUrl/apiKey/budget fields on the saved profile). This is an explicit
      // set, so it stays put across later chat-model changes until the user changes it again.
      const next = await window.arivu.saveConfig({
        browserTaskModel: { providerId: state?.config.browserTaskModel?.providerId, model: trimmed }
      });
      applyDesktopStateSnapshot(next);
      setError(null);
      setStatus(`Browser task LLM set to ${modelDisplayName(trimmed)}`);
    } catch (err) {
      handleModelError(formatError(err));
    }
  }

  // Inline "instant" form typed straight into the prompt box: `/browsermodel <id>` sets the browser
  // task model from the RAW prompt text (not the lowercased slash query) so case-sensitive model ids
  // survive. A bare `/browsermodel` (no argument) is left to the slash menu, which opens the picker.
  // Returns true when it consumed the submit.
  function tryInlineBrowserTaskModelCommand(): boolean {
    const match = prompt.trim().match(/^\/browser-?model\s+(\S.*)$/i);
    if (!match) {
      return false;
    }
    setPrompt("");
    void applyBrowserTaskModel(match[1].trim());
    return true;
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
    if (event.type === "browser_task_progress") {
      setLiveBrowserTaskStep({
        stepIndex: event.stepIndex,
        summary: event.summary,
        evaluation: event.evaluation,
        memory: event.memory
      });
      return;
    }
    if (event.type === "tool_result" && event.name === "browser_task") {
      setLiveBrowserTaskStep(null);
    }
    if (event.type === "empty_response_retry") {
      const minutes = Math.round(event.delayMs / 60_000);
      setStatus(`Empty response — retrying in ${minutes} min (${event.attempt}/${event.maxAttempts})`);
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
          ? {
              messages: event.messages,
              modelSelection: event.modelSelection,
              agentLoop: event.agentLoop,
              taskRuns: event.taskRuns,
              context: event.context,
              queuedPrompts: event.queuedPrompts
            }
          : {})
      };
    });

    if (activeSessionId === event.sessionId) {
      setMessages(event.messages);
      // The run settled (success, failure, or otherwise) -- covers exit paths with no matching
      // browser_task tool_result to clear it, e.g. the model erroring out mid-task.
      setLiveBrowserTaskStep(null);
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
    if (tryInlineBrowserTaskModelCommand()) {
      return;
    }
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
    // The inline `/browsermodel <id>` form must be caught before the slash menu's Enter handler,
    // which would otherwise report "no slash command matches" (an argument breaks the menu filter).
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && tryInlineBrowserTaskModelCommand()) {
      event.preventDefault();
      return;
    }
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

    if (command.id === "summarize") {
      const summarized = await summarizeContext();
      if (summarized) {
        setPrompt("");
      }
      requestAnimationFrame(() => promptInputRef.current?.focus());
      return;
    }

    if (command.id === "browsermodel") {
      setPrompt("");
      openBrowserTaskModelPicker();
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
      await showSkillsPopover();
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

    await showToolsPopover();
    requestAnimationFrame(() => promptInputRef.current?.focus());
  }

  async function submitPrompt(content?: ChatContent, options: SubmitPromptOptions = {}) {
    const usingComposer = content === undefined;
    const nextContent = content ?? createPromptContent(prompt, imageAttachments, fileAttachments);
    const nextSkillNames = usingComposer ? pendingSkillNames : (options.skillNames ?? []);
    const nextPlanModeEnabled = options.planModeEnabled ?? (usingComposer ? agentPlanModeEnabled : false);
    const nextLoopEnabled = nextPlanModeEnabled ? false : (options.loopEnabled ?? (usingComposer ? agentLoopEnabled : false));
    const nextWorktreeTaskRunId = options.worktreeTaskRunId ?? (usingComposer ? worktreeContinuation?.taskRunId : undefined);
    const nextWorktreeReplayOfTaskRunId =
      options.worktreeReplayOfTaskRunId ?? (usingComposer ? worktreeContinuation?.replayOfTaskRunId : undefined);
    const nextWorktreePlannedFromTaskRunId =
      options.worktreePlannedFromTaskRunId ?? (usingComposer ? worktreePlanSource?.taskRunId : undefined);
    const retryFromUserMessageIndex = options.retryFromUserMessageIndex;
    const nextWorktreeEnabled = nextPlanModeEnabled
      ? false
      : (options.worktreeEnabled ??
        (usingComposer ? agentWorktreeEnabled || Boolean(nextWorktreeTaskRunId) || Boolean(nextWorktreePlannedFromTaskRunId) : false));
    if (!chatContentHasRenderableContent(nextContent)) {
      return;
    }
    if (busy) {
      if (usingComposer) {
        await queueComposerPrompt(nextContent, nextSkillNames);
      }
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
    const submissionCreatedAt = new Date().toISOString();
    activeSubmissionTokenRef.current = submissionToken;
    const messagesBeforeRun = messages;
    const failedMessageIndex = canReuseFailedPrompt ? failedPrompt.messageIndex : messagesBeforeRun.length;
    if (retryFromUserMessageIndex !== undefined) {
      setMessages(messagesBeforeRun.slice(0, retryFromUserMessageIndex + 1));
    } else if (!canReuseFailedPrompt) {
      setMessages((current) => [...current, { role: "user", content: nextContent, createdAt: submissionCreatedAt }]);
    }

    try {
      const result = await window.arivu.sendPrompt({
        content: nextContent,
        skills: nextSkillNames,
        reuseLastUserMessage: canReuseFailedPrompt,
        retryFromUserMessageIndex,
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
        setMessages(
          canReuseFailedPrompt || retryFromUserMessageIndex !== undefined
            ? messagesBeforeRun
            : [...messagesBeforeRun, { role: "user", content: nextContent, createdAt: submissionCreatedAt }]
        );
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
          messageIndex: retryFromUserMessageIndex ?? failedMessageIndex,
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

  async function queueComposerPrompt(content: ChatContent, skillNames: string[]) {
    if (queueSubmissionBusy) {
      return;
    }
    setQueueSubmissionBusy(true);
    setError(null);
    try {
      const next = await window.arivu.queuePrompt({ content, skills: skillNames });
      applyDesktopStateSnapshot(next);
      setPrompt("");
      setImageAttachments([]);
      setFileAttachments([]);
      setPendingSkillNames((current) => current.filter((name) => !skillNames.includes(name)));
      setAgentPlanModeEnabled(false);
      setAgentLoopEnabled(false);
      setAgentWorktreeEnabled(false);
      setWorktreeContinuation(null);
      setWorktreePlanSource(null);
      setToolsPopoverOpen(false);
      setSkillsPopoverOpen(false);
      setComposerOptionsOpen(false);
      setCommandOutput(null);
      setStatus("Message queued");
      requestAnimationFrame(() => promptInputRef.current?.focus());
    } catch (err) {
      setError(formatError(err));
      setStatus("Could not queue message");
    } finally {
      setQueueSubmissionBusy(false);
    }
  }

  async function steerQueuedPrompt(promptId: string) {
    if (steeringPromptId) {
      return;
    }
    setSteeringPromptId(promptId);
    setError(null);
    try {
      const next = await window.arivu.steerQueuedPrompt(promptId);
      applyDesktopStateSnapshot(next);
      setStatus("Steering message into the current run");
    } catch (err) {
      setError(formatError(err));
      setStatus("Could not steer message");
    } finally {
      setSteeringPromptId(null);
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

  function retryPromptForAssistant(index: number): RetryPromptTarget | null {
    const message = visibleMessages[index]?.message;
    if (message?.role !== "assistant") {
      return null;
    }

    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const previous = visibleMessages[cursor];
      if (previous?.message.role === "user") {
        return {
          content: previous.message.content,
          userMessageIndex: previous.sourceIndexes.at(-1) ?? previous.messageIndex
        };
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

  async function stopAgentRun() {
    if (!state?.sessionId) {
      return;
    }
    try {
      const next = await window.arivu.stopAgentRun(state.sessionId);
      applyDesktopState(next);
      setStatus("Stopping run");
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

  async function respondElicitation(response: ElicitationResponse) {
    if (!elicitation) {
      return;
    }
    await window.arivu.respondElicitation(elicitation.id, response);
    setElicitation(null);
    setStatus(response.status === "answered" ? "Answers sent to the agent" : "Questions dismissed");
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !state) {
        return;
      }

      const shortcut = resolveAppKeyboardShortcut(event);
      if (!shortcut) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setCommandOutput(null);

      if (shortcut === "focus_composer") {
        setView("chat");
        setChatSearchOpen(false);
        setStatus("Composer focused");
        requestAnimationFrame(() => promptInputRef.current?.focus());
        return;
      }

      if (shortcut === "new_chat") {
        void startNewChat();
        return;
      }

      if (shortcut === "search_chat") {
        setView("chat");
        setChatSearchOpen(true);
        setStatus("Search chat");
        requestAnimationFrame(() => chatSearchInputRef.current?.focus());
        return;
      }

      if (shortcut === "settings") {
        const nextView = view === "settings" ? "chat" : "settings";
        setSettingsFocus(null);
        setView(nextView);
        setToolsPopoverOpen(false);
        setSkillsPopoverOpen(false);
        setComposerOptionsOpen(false);
        setStatus(nextView === "settings" ? "Settings opened" : "Chat opened");
        return;
      }

      if (shortcut === "refresh_state") {
        void refresh();
        return;
      }

      if (shortcut === "toggle_browser") {
        void toggleBrowserPaneOpen();
        return;
      }

      if (shortcut === "show_tools") {
        setView("chat");
        void showToolsPopover();
        requestAnimationFrame(() => promptInputRef.current?.focus());
        return;
      }

      if (shortcut === "show_skills") {
        setView("chat");
        void showSkillsPopover();
        requestAnimationFrame(() => promptInputRef.current?.focus());
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  });

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

  const workspaceName =
    state.projectRoot === null ? "No project selected" : (state.workspace.packageName ?? basename(state.workspace.root));
  const workspaceDetail = state.projectRoot === null ? "Standalone chats" : state.workspace.root;
  const gitValue = state.projectRoot === null ? "none" : `${state.workspace.gitBranch ?? "none"}${state.workspace.dirty ? " *" : ""}`;
  const recentProjects = projects.slice(0, 5);
  const standaloneSessionsAll = sessions.filter((session) => session.projectRoot === null).sort(compareSessionsForDisplay);
  const standaloneSessions = standaloneSessionsAll.slice(0, visibleChatCount);
  const hasMoreStandaloneSessions = standaloneSessionsAll.length > standaloneSessions.length;
  const chatStarted = Boolean(state.sessionId) || messages.some((message) => message.role !== "system");
  const canSelectChatProject = !chatStarted && !busy;
  const canCompactContext =
    Boolean(state.sessionId) && nonSystemMessageCount > CONTEXT_COMPACT_RECENT_MESSAGE_COUNT && !busy && !compactingContext;
  const effectiveSidebarWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth;
  const toolActivityCount = activity.filter((item) => item.kind !== "system").length;
  const effectiveActivityWidth = activityCollapsed
    ? ACTIVITY_COLLAPSED_WIDTH
    : clamp(activityWidth, ACTIVITY_MIN_WIDTH, ACTIVITY_MAX_WIDTH);
  const browserOpen = Boolean(browserState?.paneOpen);
  const activeAgentLoop = state.agentLoop;
  const agentLoopRunning = Boolean(activeAgentLoop && ["running", "stopping"].includes(activeAgentLoop.status));
  const agentLoopLabel = activeAgentLoop ? agentLoopStatusLabel(activeAgentLoop) : "Loop off";
  const workspaceGridClassName = ["workspace-grid", activityCollapsed ? "activity-collapsed" : ""].filter(Boolean).join(" ");

  return (
    <main
      className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}
      style={{ "--sidebar-width": `${effectiveSidebarWidth}px` } as React.CSSProperties}
    >
      <aside className={sidebarCollapsed ? "sidebar collapsed" : "sidebar"}>
        <div className="brand-row">
          <button
            className="icon-button sidebar-collapse-button"
            type="button"
            onClick={() => setSidebarCollapsed((current) => !current)}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
          <img className="brand-mark" src={arivuLogoUrl} alt="" />
          {!sidebarCollapsed ? (
            <div className="brand-copy">
              <div className="brand-title">Arivu</div>
            </div>
          ) : null}
        </div>

        <button className="primary-command" type="button" onClick={() => void startNewChat()}>
          <Plus size={17} />
          <span>New chat</span>
        </button>

        {!sidebarCollapsed ? (
          <div className="workspace-actions">
            <button className="secondary-command" type="button" onClick={chooseWorkspace}>
              <FolderOpen size={16} />
              Open
            </button>
            <button className="secondary-command" type="button" onClick={() => void createWorkspace()}>
              <FolderPlus size={16} />
              New workspace
            </button>
          </div>
        ) : null}

        {!sidebarCollapsed ? (
          <section
            className={
              collapsedSections.projects ? "sidebar-section projects-section collapsed-section" : "sidebar-section projects-section"
            }
          >
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
            {!collapsedSections.projects ? (
              <div className="recent-project-list">
                {recentProjects.length === 0 ? <div className="empty-sidebar-list">No recent workspaces yet.</div> : null}
                {recentProjects.map((project) => {
                  const expanded = expandedProjectRoots[project.projectRoot] ?? project.projectRoot === state.projectRoot;
                  const projectOpenBusy = openingWorkspaceRoot === project.projectRoot;
                  const projectForgetBusy = forgettingProjectRoot === project.projectRoot;
                  const projectMissing = !project.projectRootExists;
                  const projectRowClassName = ["project-row", projectMissing ? "missing with-action" : ""].filter(Boolean).join(" ");
                  const projectGroupClassName = [
                    "project-group",
                    project.projectRoot === state.projectRoot ? "active" : "",
                    projectMissing ? "missing" : ""
                  ]
                    .filter(Boolean)
                    .join(" ");
                  const projectStatus = projectMissing
                    ? `Missing folder - ${formatNumber(project.chatCount)} chat${project.chatCount === 1 ? "" : "s"}`
                    : projectOpenBusy
                      ? "Opening..."
                      : project.chatCount === 0
                        ? "Current workspace"
                        : `${project.chatCount} chats`;
                  return (
                    <div key={project.projectRoot} className={projectGroupClassName}>
                      <div className={projectRowClassName} title={project.projectRoot}>
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
                          disabled={Boolean(openingWorkspaceRoot) || projectMissing}
                          onClick={() => void openWorkspace(project.projectRoot)}
                          title={
                            projectMissing ? `Workspace folder missing: ${project.projectRoot}` : `Open workspace ${project.projectRoot}`
                          }
                          aria-current={project.projectRoot === state.projectRoot ? "page" : undefined}
                        >
                          {projectMissing ? (
                            <AlertTriangle className="project-folder-icon" size={14} />
                          ) : projectOpenBusy ? (
                            <RefreshCw className="project-folder-icon spinning" size={14} />
                          ) : (
                            <FolderOpen className="project-folder-icon" size={14} />
                          )}
                          <span className="recent-project-main">
                            <strong>{project.name}</strong>
                            <span>{projectStatus}</span>
                          </span>
                        </button>
                        {projectMissing ? (
                          <button
                            className="project-forget-button"
                            type="button"
                            onClick={() => void forgetMissingProject(project)}
                            disabled={projectForgetBusy}
                            title="Forget missing workspace and keep chats"
                            aria-label={`Forget missing workspace ${project.name}`}
                          >
                            {projectForgetBusy ? <RefreshCw className="spinning" size={13} /> : <X size={13} />}
                          </button>
                        ) : null}
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
                              onToggleMenu={() => setOpenChatMenuId((current) => (current === session.id ? null : session.id))}
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
              </div>
            ) : null}
          </section>
        ) : null}

        {!sidebarCollapsed ? (
          <section
            className={collapsedSections.chats ? "sidebar-section chats-section collapsed-section" : "sidebar-section chats-section"}
          >
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
              {!collapsedSections.chats && (hasMoreStandaloneSessions || standaloneSessionsAll.length > 0) ? (
                <button className="text-command" type="button" onClick={() => setView("history")}>
                  View all
                </button>
              ) : null}
            </div>
            {!collapsedSections.chats ? (
              <div className="recent-chat-list" ref={recentChatListRef}>
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
                        onToggleMenu={() => setOpenChatMenuId((current) => (current === session.id ? null : session.id))}
                        onRename={() => void renameSession(session)}
                        onTogglePin={() => void toggleSessionPin(session)}
                        onDelete={() => void deleteSession(session)}
                      />
                    ))
                  : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {!sidebarCollapsed ? (
          <div className="sidebar-footer">
            <span>{status}</span>
          </div>
        ) : null}
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
              <span className="workspace-header-path" title={workspaceDetail}>
                {workspaceDetail}
              </span>
              <RuntimeDetails state={state} gitValue={gitValue} />
            </div>
          </div>
          <div className="topbar-actions">
            <ThemeToggle theme={theme} onChange={setTheme} />
            <button
              type="button"
              className={
                browserState?.paneOpen
                  ? "ghost-button topbar-icon-action has-tooltip active"
                  : "ghost-button topbar-icon-action has-tooltip"
              }
              onClick={() => {
                setView("chat");
                void toggleBrowserPaneOpen();
              }}
              aria-label={browserState?.paneOpen ? "Hide browser window" : "Show browser window"}
              data-tooltip={browserState?.paneOpen ? "Hide browser window" : "Show browser window"}
            >
              <Globe size={14} />
            </button>
            <button
              type="button"
              className={
                chatSearchOpen ? "ghost-button topbar-icon-action has-tooltip active" : "ghost-button topbar-icon-action has-tooltip"
              }
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
              className={
                view === "settings" ? "ghost-button topbar-icon-action has-tooltip active" : "ghost-button topbar-icon-action has-tooltip"
              }
              onClick={() => {
                setSettingsFocus(null);
                setView((current) => (current === "settings" ? "chat" : "settings"));
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
                  visibleMessages.map(({ message, sourceIndexes, key: messageKey }, index) => {
                    const failedUserPrompt =
                      message.role === "user" &&
                      failedPrompt !== null &&
                      sourceIndexes.includes(failedPrompt.messageIndex) &&
                      chatContentEquals(failedPrompt.content, message.content);
                    const assistantRetryTarget = retryPromptForAssistant(index);
                    const promptToRetry = failedUserPrompt ? message.content : assistantRetryTarget?.content;
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
                            if (assistantRetryTarget) {
                              void submitPrompt(assistantRetryTarget.content, {
                                retryFromUserMessageIndex: assistantRetryTarget.userMessageIndex
                              });
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
                  <div className={agentLoopRunning ? "agent-thinking loop-active" : "agent-thinking"} role="status" aria-live="polite">
                    <LoaderCircle className="agent-working-spinner" size={16} aria-hidden="true" />
                    <span className="agent-thinking-label">
                      {agentLoopRunning && activeAgentLoop ? agentLoopLabel : "Agent is working"}
                    </span>
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
                    <button type="button" onClick={retryLastPrompt} disabled={busy} title="Retry query" aria-label="Retry query">
                      <RotateCcw size={14} />
                      <span className="message-action-tooltip" aria-hidden="true">
                        Retry query
                      </span>
                    </button>
                  ) : null}
                </div>
              ) : null}

              {state.queuedPrompts.length > 0 ? (
                <QueuedPromptList
                  prompts={state.queuedPrompts}
                  steeringPromptId={steeringPromptId}
                  onSteer={(promptId) => void steerQueuedPrompt(promptId)}
                />
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
                    placeholder={
                      busy
                        ? "Send another message — it will wait in the queue..."
                        : "Ask Arivu to inspect, edit, test, explain, or type / for commands..."
                    }
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
                  {imageAttachments.length > 0 ? <ImageAttachmentStrip images={imageAttachments} onRemove={removeImageAttachment} /> : null}
                  {fileAttachments.length > 0 ? <FileAttachmentStrip files={fileAttachments} onRemove={removeFileAttachment} /> : null}
                  {toolsPopoverOpen ? (
                    <ToolPanel tools={availableTools} onToggleTool={(name, disabled) => void toggleToolDisabled(name, disabled)} />
                  ) : null}
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
                              void toggleBrowserPaneOpen();
                            }}
                            onOpenSettings={() => {
                              setComposerOptionsOpen(false);
                              setSkillsPopoverOpen(false);
                              setSettingsFocus(null);
                              setView("settings");
                            }}
                            onOpenSkillsSettings={openSkillsSettings}
                            browserTaskModelLabel={modelDisplayName(browserTaskPickerContext().currentModel)}
                            onOpenBrowserTaskModel={openBrowserTaskModelPicker}
                            apiLogCount={apiRequestLog.length}
                            onOpenApiLog={openApiLog}
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
                        className={
                          agentWorktreeEnabled || worktreeContinuation || worktreePlanSource
                            ? "composer-worktree-button active"
                            : "composer-worktree-button"
                        }
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
                        aria-label={
                          agentWorktreeEnabled || worktreeContinuation || worktreePlanSource
                            ? "Turn off task worktree"
                            : "Turn on task worktree for the next prompt"
                        }
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
                          setStatus(
                            !agentLoopEnabled ? `Agent loop armed for ${DEFAULT_AGENT_LOOP_MAX_ITERATIONS} iterations` : "Agent loop off"
                          );
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
                    {busy ? (
                      <div className="composer-running-actions">
                        <button
                          className="composer-send-button icon-send-button composer-queue-button"
                          type="submit"
                          disabled={
                            queueSubmissionBusy ||
                            !chatContentHasRenderableContent(createPromptContent(prompt, imageAttachments, fileAttachments))
                          }
                          title="Queue message"
                          aria-label="Queue message"
                        >
                          {queueSubmissionBusy ? <LoaderCircle className="spinning" size={18} /> : <Rows3 size={18} />}
                        </button>
                        <button
                          className="composer-send-button icon-send-button composer-stop-button"
                          type="button"
                          onClick={() => void stopAgentRun()}
                          title="Stop run"
                          aria-label="Stop run"
                        >
                          <Square size={18} />
                        </button>
                      </div>
                    ) : (
                      <button
                        className="composer-send-button icon-send-button"
                        type="submit"
                        disabled={
                          slashQuery !== null ||
                          !chatContentHasRenderableContent(createPromptContent(prompt, imageAttachments, fileAttachments))
                        }
                        title="Send prompt"
                        aria-label="Send prompt"
                      >
                        <SendArrowIcon size={22} />
                      </button>
                    )}
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
                  {activityCollapsed && toolActivityCount > 0 ? (
                    <span className="activity-count-badge rail">{toolActivityCount}</span>
                  ) : null}
                </button>
              </div>
              {!activityCollapsed ? (
                <div className="activity-content">
                  {latestScreenshotActivity?.imagePreview ? <LatestActivityScreenshot item={latestScreenshotActivity} /> : null}
                  {liveBrowserTaskStep ? (
                    <div className="live-browser-step" role="status" aria-live="polite">
                      <span className="live-browser-step-dot" aria-hidden="true" />
                      <div className="live-browser-step-copy">
                        <strong>Browser task · step {liveBrowserTaskStep.stepIndex}</strong>
                        <span>{liveBrowserTaskStep.summary}</span>
                        {liveBrowserTaskStep.evaluation ? <small>{liveBrowserTaskStep.evaluation}</small> : null}
                      </div>
                    </div>
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
                            onUndoRun={handleUndoRun}
                            undoBusyRunId={undoBusyRunId}
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
            onToggleMenu={(id) => setOpenHistoryMenuId((current) => (current === id ? null : id))}
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
        ) : null}
      </section>

      {approval ? <ApprovalDialog approval={approval} onRespond={(approved) => void respondApproval(approved)} /> : null}
      {elicitation && !approval ? (
        <ElicitationDialog prompt={elicitation} onRespond={(response) => void respondElicitation(response)} />
      ) : null}
      {browserTaskModelPickerOpen && state ? (
        <ModelPickerDialog
          currentModel={browserTaskPickerContext().currentModel}
          baseUrl={browserTaskPickerContext().baseUrl}
          providerId={browserTaskPickerContext().providerId}
          includeAuto={false}
          title="Select browser task model"
          onSelect={(nextModel) => {
            setBrowserTaskModelPickerOpen(false);
            void applyBrowserTaskModel(nextModel);
          }}
          onClose={() => setBrowserTaskModelPickerOpen(false)}
        />
      ) : null}
      {apiLogOpen ? (
        <ApiRequestLogPanel entries={apiRequestLog} onClear={() => void clearApiRequestLogEntries()} onClose={() => setApiLogOpen(false)} />
      ) : null}
      {state &&
      !onboardingDismissed &&
      !state.config.apiKeyPresent &&
      !(state.config.providers ?? []).some((provider) => provider.apiKeyPresent) ? (
        <FirstRunOnboarding
          initialBaseUrl={state.config.baseUrl}
          initialModel={isAutoModelId(state.config.model) ? "" : state.config.model}
          initialTrustMode={state.config.trustMode}
          onStateUpdated={applyDesktopState}
          onDismiss={() => setOnboardingDismissed(true)}
        />
      ) : null}
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

function RuntimeDetails({ state, gitValue }: { state: DesktopState; gitValue: string }) {
  const webSearchProvider =
    state.config.webSearchProviders.find((provider) => provider.id === state.config.activeWebSearchProviderId) ??
    state.config.webSearchProviders[0];
  const details = [
    { label: "Provider", value: activeProviderName(state.config) },
    { label: "Model", value: modelDisplayName(state.config.model) },
    ...(state.modelSelection?.mode === "auto"
      ? [{ label: "Auto picked", value: `${state.modelSelection.model} (${state.modelSelection.providerName})` }]
      : []),
    { label: "Base URL", value: state.config.baseUrl },
    { label: "Approval mode", value: trustModeLabel(state.config.trustMode) },
    { label: "Git", value: gitValue },
    { label: "API key", value: state.config.apiKeyPresent ? "saved" : "missing" },
    {
      label: "Web search",
      value: webSearchProvider
        ? `${webSearchProvider.name} · ${
            webSearchProviderRequiresApiKey(webSearchProvider.kind)
              ? webSearchProvider.apiKeyPresent
                ? "key saved"
                : "key missing"
              : "keyless"
          }`
        : "Bing RSS · keyless"
    }
  ];

  return (
    <div className="runtime-details">
      <button type="button" className="runtime-details-button" aria-label="Runtime details" aria-describedby="runtime-details-popover">
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

function ApiRequestLogPanel({ entries, onClear, onClose }: { entries: ApiRequestLogEntry[]; onClear: () => void; onClose: () => void }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="model-dialog api-log-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="API request log"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="api-log-header">
          <div className="api-log-header-title">
            <Activity size={18} />
            <div>
              <h2>API requests</h2>
              <p className="api-log-subtitle">
                Last {entries.length} model calls, newest first. Metadata + bodies; API key redacted; in-memory only.
              </p>
            </div>
          </div>
          <div className="api-log-header-actions">
            <button type="button" className="secondary-command" onClick={onClear} disabled={entries.length === 0}>
              Clear
            </button>
            <button type="button" className="secondary-command" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        {entries.length === 0 ? (
          <p className="api-log-empty">No model calls recorded yet. Send a prompt and they will appear here.</p>
        ) : (
          <ul className="api-log-list">
            {entries.map((entry) => {
              const expanded = expandedId === entry.id;
              return (
                <li key={entry.id} className={`api-log-entry api-log-outcome-${entry.outcome}`}>
                  <button
                    type="button"
                    className="api-log-entry-summary"
                    onClick={() => setExpandedId(expanded ? null : entry.id)}
                    aria-expanded={expanded}
                  >
                    <span className="api-log-time">{formatApiLogTime(entry.at)}</span>
                    <span className="api-log-model">{entry.model}</span>
                    <span className="api-log-status">{entry.status ?? "—"}</span>
                    <span className="api-log-duration">{(entry.durationMs / 1000).toFixed(1)}s</span>
                    {entry.retries > 0 ? <span className="api-log-retries">↻{entry.retries}</span> : null}
                    <span className={`api-log-badge api-log-badge-${entry.outcome}`}>{apiLogOutcomeLabel(entry)}</span>
                  </button>
                  {expanded ? (
                    <div className="api-log-detail">
                      <ApiLogRow label="Outcome" value={entry.outcome} />
                      <ApiLogRow label="Finish reason" value={entry.finishReason ?? "—"} />
                      <ApiLogRow label="Streamed" value={entry.streamed ? "yes" : "no"} />
                      <ApiLogRow label="Content" value={`${entry.contentChars} chars`} />
                      <ApiLogRow label="Tools offered" value={entry.toolsOffered.length ? `${entry.toolsOffered.length}` : "none"} />
                      <ApiLogRow label="Tool calls" value={entry.toolCalls.length ? entry.toolCalls.join(", ") : "none"} />
                      {entry.droppedToolCalls.length ? (
                        <ApiLogRow label="Dropped (unavailable)" value={entry.droppedToolCalls.join(", ")} highlight />
                      ) : null}
                      {entry.usage?.totalTokens !== undefined ? <ApiLogRow label="Tokens" value={`${entry.usage.totalTokens}`} /> : null}
                      {entry.error ? <ApiLogRow label="Error" value={entry.error} highlight /> : null}
                      {entry.requestMessages ? (
                        <details className="api-log-body">
                          <summary>Request messages ({entry.requestMessages.length})</summary>
                          <pre>
                            {entry.requestMessages
                              .map(
                                (message) =>
                                  `[${message.role}]${message.toolCalls?.length ? ` calls: ${message.toolCalls.join(", ")}` : ""}\n${message.content}`
                              )
                              .join("\n\n")}
                          </pre>
                        </details>
                      ) : null}
                      {entry.responseBody ? (
                        <details className="api-log-body">
                          <summary>Response body</summary>
                          <pre>{entry.responseBody}</pre>
                        </details>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>,
    document.body
  );
}

function ApiLogRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={highlight ? "api-log-row api-log-row-highlight" : "api-log-row"}>
      <span className="api-log-row-label">{label}</span>
      <span className="api-log-row-value">{value}</span>
    </div>
  );
}

function apiLogOutcomeLabel(entry: ApiRequestLogEntry): string {
  if (entry.outcome === "error") {
    return "error";
  }
  if (entry.outcome === "empty") {
    return "empty";
  }
  return entry.toolCalls.length ? `${entry.toolCalls.length} tool call${entry.toolCalls.length === 1 ? "" : "s"}` : "ok";
}

function formatApiLogTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function modelSelectionStatus(selection: PublicModelSelection | undefined) {
  if (!selection || selection.mode !== "auto" || isAutoModelId(selection.model)) {
    return null;
  }
  return `Auto picked ${selection.model}`;
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
        detail: disabledReason
          ? undefined
          : `${formatNumber(fileAttachmentCount)} / ${formatNumber(MAX_CONTEXT_FILE_ATTACHMENTS)} attached`,
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
    subtitle: "The full chat is saved; context is the smaller working set currently sent to the model.",
    rows: [
      { label: "Chat ID", value: state.sessionId ?? "Draft chat (not saved yet)" },
      {
        label: "Project",
        value: state.projectRoot === null ? "No project selected" : (state.workspace.packageName ?? basename(state.projectRoot))
      },
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
      ...(latestRun?.usage
        ? [
            {
              label: "Tokens used",
              value: `${formatNumber(latestRun.usage.totalTokens)} total (${formatNumber(latestRun.usage.promptTokens)} prompt / ${formatNumber(
                latestRun.usage.completionTokens
              )} completion) over ${formatNumber(latestRun.usage.requestCount)} request${latestRun.usage.requestCount === 1 ? "" : "s"}`
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
      { label: "Approval mode", value: trustModeLabel(state.config.trustMode) },
      {
        label: "Context used",
        value: `~${formatNumber(estimatedContextTokens)} / ${formatNumber(COMPOSER_TOKEN_BUDGET)} tokens`
      },
      { label: "Context remaining", value: `~${formatNumber(remainingTokens)} tokens` },
      {
        label: "Context mode",
        value: state.context.compacted
          ? `Compacted${state.context.compactedAt ? ` ${formatDateTime(state.context.compactedAt)}` : ""}`
          : "Full chat"
      },
      { label: "Working messages", value: formatNumber(state.context.messageCount) },
      { label: "Saved history", value: `${formatNumber(nonSystemCount)} chat, ${formatNumber(messages.length)} total` },
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
  const transcript = messages.map((message) => `${message.role}: ${chatContentToText(message.content)}`).join("\n\n");
  return estimateTokenCount(transcript);
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

function savePersistedUiState(state: PersistedUiState) {
  try {
    window.localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Local storage can be unavailable in hardened browser contexts.
  }
}

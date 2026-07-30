import path from "node:path";
import blessed from "blessed";
import { execa } from "execa";
import { Agent } from "../agent/Agent.js";
import { chatContentToText } from "../agent/content.js";
import {
  COMPACT_RECENT_MESSAGE_COUNT,
  applyContextCompactionCheckpoint,
  compactSessionMessages,
  contextMessagesForSession
} from "../agent/contextCompaction.js";
import { OpenAICompatibleChatClient } from "../agent/OpenAICompatibleChatClient.js";
import { AgentRunAbortedError } from "../agent/types.js";
import type { AgentRunEvent, AgentSession, ChatMessage, ChatUsage } from "../agent/types.js";
import { resolveWebSearchProvider, workspacePolicyOverridesForRoot, workspaceScopeRulesForRoot, type AppConfig } from "../config.js";
import { ApprovalManager } from "../permissions/ApprovalManager.js";
import { ModelCatalogStore } from "../models/ModelCatalogStore.js";
import { resolveContextWindowTokens } from "../models/contextResolver.js";
import { emptyCatalog, type ModelCatalog } from "../models/modelCatalogSchema.js";
import { recordContextFromRuntime } from "../models/syncModelCatalog.js";
import { SessionStore } from "../sessions/SessionStore.js";
import {
  describeSessionListFilters,
  filterSessions,
  sessionDisplayTitle,
  sessionWorkspaceName,
  type SessionListFilters
} from "../sessions/sessionList.js";
import { detectWorkspace, type WorkspaceInfo } from "../workspace.js";
import {
  TUI_PALETTE_COMMANDS,
  TUI_SHORTCUT_HELP,
  escapeBlessedTags,
  editTuiPrompt,
  filterTuiPaletteCommands,
  formatTuiActivityDrawer,
  formatTuiAlignedLine,
  formatTuiContextUsage,
  formatTuiPaletteItems,
  formatTuiPromptDraft,
  formatTuiTokenCount,
  formatTuiTranscript,
  resolveTuiActivityDrawerWidth,
  type TuiActivityLine,
  type TuiLogLine,
  type TuiPaletteCommand
} from "./presentation.js";

type TuiAppOptions = {
  config: AppConfig;
  cwd: string;
  session?: AgentSession;
};

type FocusTarget = "input" | "conversation" | "activity";
type TuiPaneScrollTarget = "focused" | "activity";
type TuiPaneScrollAction = "page-up" | "page-down" | "top" | "bottom";
export type TuiPaneScrollShortcut = {
  target: TuiPaneScrollTarget;
  action: TuiPaneScrollAction;
};
export type TuiSlashCommand =
  | { kind: "activity" | "clear" | "continue" | "diff" | "exit" | "help" | "status" | "summarize" }
  | { kind: "compact"; recentMessageCount?: number }
  | { kind: "sessions"; limit: number; filters?: SessionListFilters; pick?: boolean }
  | { kind: "resume"; sessionId: string }
  | { kind: "error"; message: string }
  | { kind: "unknown" };

export type TuiGitDiffSummary = {
  root: string;
  branch?: string;
  stagedShortstat?: string;
  unstagedShortstat?: string;
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_TUI_SESSION_LIST_LIMIT = 10;
const MAX_TUI_SESSION_LIST_LIMIT = 50;
const TUI_PANE_SCROLL_KEY_BINDINGS: Array<{ keys: string[]; shortcut: TuiPaneScrollShortcut }> = [
  { keys: ["pageup"], shortcut: { target: "focused", action: "page-up" } },
  { keys: ["pagedown"], shortcut: { target: "focused", action: "page-down" } },
  { keys: ["S-pageup"], shortcut: { target: "activity", action: "page-up" } },
  { keys: ["S-pagedown"], shortcut: { target: "activity", action: "page-down" } },
  { keys: ["C-home"], shortcut: { target: "focused", action: "top" } },
  { keys: ["C-end"], shortcut: { target: "focused", action: "bottom" } },
  { keys: ["C-S-home"], shortcut: { target: "activity", action: "top" } },
  { keys: ["C-S-end"], shortcut: { target: "activity", action: "bottom" } }
];

export class TuiApp {
  private screen!: blessed.Widgets.Screen;
  private header!: blessed.Widgets.BoxElement;
  private conversation!: blessed.Widgets.BoxElement;
  private activity!: blessed.Widgets.BoxElement;
  private turnStatus!: blessed.Widgets.BoxElement;
  private composer!: blessed.Widgets.BoxElement;
  private promptPrefix!: blessed.Widgets.BoxElement;
  private promptInfo!: blessed.Widgets.BoxElement;
  private input!: blessed.Widgets.BoxElement;
  private commandBar!: blessed.Widgets.BoxElement;
  private agent!: Agent;
  private workspace!: WorkspaceInfo;
  private config!: AppConfig;
  private cwd!: string;
  private currentSession?: AgentSession;
  private readonly store = new SessionStore();
  private readonly catalogStore = new ModelCatalogStore();
  /** Loaded once in run(); createAgent() has six sync callers, so it reads this snapshot. */
  private modelCatalog: ModelCatalog = emptyCatalog();
  private readonly log: TuiLogLine[] = [];
  private readonly activityLog: TuiActivityLine[] = [];
  private entrySequence = 0;
  private busy = false;
  private runAbortController: AbortController | undefined;
  private lastRunUsage: { promptTokens: number; completionTokens: number; totalTokens: number; requestCount: number } | undefined;
  private currentContextTokens: number | undefined;
  private runStartedAt: number | undefined;
  private status = "Ready";
  private focusTarget: FocusTarget = "input";
  private spinnerFrame = 0;
  private spinner?: NodeJS.Timeout;
  private lastMessageCount = 0;
  private streamingAssistantIndex: number | undefined;
  private liveActivity = false;
  private modalOpen = false;
  private activityOpen = false;
  private forceConversationTail = true;
  private forceActivityTail = true;
  private quitArmedUntil = 0;
  private readonly promptQueue: string[] = [];
  private readonly streamingToolRows = new Map<string, number>();
  private promptDraft = "";
  private promptCursor = 0;
  private closing = false;

  constructor(private readonly options: TuiAppOptions) {}

  async run(): Promise<void> {
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      throw new Error("The Arivu TUI requires an interactive terminal. Use one-shot mode for non-TTY usage.");
    }

    this.currentSession = this.options.session;
    this.config = configForSession(this.options.config, this.currentSession);
    this.cwd = this.currentSession?.cwd ?? this.options.cwd;
    this.workspace = await detectWorkspace(this.cwd);
    this.lastMessageCount = this.currentSession?.messages.length ?? 0;
    this.modelCatalog = await this.catalogStore.load();
    this.agent = this.createAgent(this.currentSession);

    this.createScreen();
    this.seedFromSession(this.currentSession);
    this.render();

    await new Promise<void>((resolve) => {
      this.screen.once("destroy", resolve);
    });
  }

  private createScreen() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "Arivu",
      fullUnicode: true,
      dockBorders: true,
      sendFocus: true
    });

    this.header = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 2,
      tags: true,
      padding: { left: 2, right: 2 },
      style: {
        fg: "gray",
        bg: "black"
      }
    });

    this.conversation = blessed.box({
      top: 2,
      left: 0,
      width: "100%",
      bottom: 6,
      tags: true,
      wrap: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      padding: { left: 2, right: 3 },
      scrollbar: {
        ch: " ",
        track: { bg: "black" },
        style: { bg: "gray" }
      },
      style: {
        fg: "white",
        bg: "black",
        scrollbar: { bg: "gray" }
      }
    });

    this.activity = blessed.box({
      top: 2,
      right: 0,
      width: "38%",
      bottom: 6,
      label: " activity · Ctrl+G close ",
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      border: "line",
      padding: { left: 1, right: 1 },
      scrollbar: {
        ch: " ",
        track: { bg: "black" },
        style: { bg: "gray" }
      },
      style: {
        fg: "white",
        bg: "#111111",
        border: { fg: "gray" },
        focus: { border: { fg: "cyan" } }
      }
    });

    this.turnStatus = blessed.box({
      bottom: 5,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      mouse: true,
      padding: { left: 2, right: 2 },
      style: {
        fg: "gray",
        bg: "black",
        hover: { fg: "white" }
      }
    });

    this.composer = blessed.box({
      bottom: 1,
      left: 0,
      width: "100%",
      height: 4,
      border: "line",
      mouse: true,
      style: {
        fg: "white",
        bg: "black",
        border: { fg: "gray" },
        hover: { border: { fg: "cyan" } }
      }
    });

    this.promptPrefix = blessed.box({
      parent: this.composer,
      top: 0,
      left: 1,
      width: 2,
      height: 1,
      tags: true,
      content: "{bold}{cyan-fg}❯{/cyan-fg}{/bold}",
      mouse: true,
      style: { fg: "cyan", bg: "black" }
    });

    this.input = blessed.box({
      parent: this.composer,
      top: 0,
      left: 3,
      right: 1,
      height: 1,
      keys: true,
      mouse: true,
      tags: true,
      style: {
        fg: "white",
        bg: "black",
        focus: { fg: "white", bg: "black" }
      }
    });

    this.promptInfo = blessed.box({
      parent: this.composer,
      bottom: 0,
      left: 2,
      right: 1,
      height: 1,
      align: "right",
      tags: true,
      style: { fg: "gray", bg: "black" }
    });

    this.commandBar = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      padding: { left: 1, right: 1 },
      style: {
        fg: "gray",
        bg: "black"
      }
    });

    this.screen.append(this.header);
    this.screen.append(this.conversation);
    this.screen.append(this.activity);
    this.screen.append(this.turnStatus);
    this.screen.append(this.composer);
    this.screen.append(this.commandBar);
    this.activity.hide();

    const bindMainKey = (keys: string | string[], handler: () => void) => {
      const run = () => {
        if (!this.modalOpen) {
          handler();
        }
      };
      this.screen.key(keys, () => {
        if (this.screen.focused !== this.input) {
          run();
        }
      });
      this.input.key(keys, run);
    };
    bindMainKey(["C-c"], () => this.handleCtrlC());
    bindMainKey(["C-q"], () => this.requestExit());
    bindMainKey(["escape"], () => {
      if (this.modalOpen) {
        return;
      }
      if (this.busy) {
        this.stopRun();
        return;
      }
      if (this.activityOpen) {
        this.toggleActivity(false);
        return;
      }
      this.focusInput();
      this.render();
    });
    bindMainKey(["tab"], () => this.focusNext());
    bindMainKey(["S-tab"], () => this.focusPrevious());
    bindMainKey(["C-p"], () => this.openCommandPalette());
    bindMainKey(["C-x"], () => this.showHelp());
    bindMainKey(["C-g"], () => this.toggleActivity());
    bindMainKey(["C-s"], () => {
      if (this.busy) {
        this.setStatus("Stop the active turn before switching sessions");
        return;
      }
      void this.pickSession(DEFAULT_TUI_SESSION_LIST_LIMIT);
    });
    bindMainKey(["C-l"], () => this.clearConversation());
    bindMainKey(["C-r"], () => this.render());
    for (const binding of TUI_PANE_SCROLL_KEY_BINDINGS) {
      bindMainKey(binding.keys, () => this.scrollPane(binding.shortcut));
    }

    this.input.on("keypress", (character, key) => this.handlePromptKeypress(character, key));
    this.conversation.key(["?"], () => this.openCommandPalette());
    this.conversation.on("click", () => this.focusConversation());
    this.activity.on("click", () => this.focusActivity());
    this.turnStatus.on("click", () => {
      if (this.busy) {
        this.stopRun();
      }
    });
    this.turnStatus.setHover("Click to stop the active turn");
    this.composer.on("click", () => this.focusInput());
    this.promptPrefix.on("click", () => this.focusInput());
    this.input.on("click", () => this.focusInput());
    this.screen.on("resize", () => {
      this.applyResponsiveLayout();
      this.render();
    });

    this.applyResponsiveLayout();
    this.focusInput();
  }

  private createAgent(session?: AgentSession) {
    const scopePolicyRules = workspaceScopeRulesForRoot(this.config, this.workspace.root);
    return new Agent({
      client: new OpenAICompatibleChatClient(this.config),
      approvals: new ApprovalManager(
        this.config.trustMode,
        (message) => this.confirm(message),
        workspacePolicyOverridesForRoot(this.config, this.workspace.root),
        undefined,
        scopePolicyRules,
        this.workspace.root
      ),
      cwd: this.cwd,
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      webSearchProvider: resolveWebSearchProvider(this.config),
      mcpServers: this.config.mcpServers,
      scopePolicyRules,
      // Per-model window from the catalog, capped by any hand-entered provider value.
      contextWindowTokens: resolveContextWindowTokens(
        this.config,
        { model: this.config.model, baseUrl: this.config.baseUrl },
        this.modelCatalog
      ),
      onContextWindowObserved: (tokens) =>
        recordContextFromRuntime(this.catalogStore, { baseUrl: this.config.baseUrl, model: this.config.model }, tokens),
      session
    });
  }

  private appendLog(kind: TuiLogLine["kind"], text: string, time = new Date()) {
    const index = this.log.length;
    this.log.push({ kind, text, time, sequence: ++this.entrySequence });
    return index;
  }

  private appendActivityLine(kind: TuiActivityLine["kind"], title: string, detail?: string, time = new Date()) {
    const index = this.activityLog.length;
    this.activityLog.push({ kind, title, detail, time, sequence: ++this.entrySequence });
    return index;
  }

  private seedFromSession(session?: AgentSession) {
    const messages = session?.messages ?? [];
    for (const message of messages) {
      const time = parseTuiDate(message.createdAt);
      if (message.role === "user") {
        this.appendLog("user", chatContentToText(message.content), time);
      }
      if (message.role === "assistant" && chatContentToText(message.content).trim()) {
        this.appendLog("assistant", chatContentToText(message.content), time);
      }
      if (message.role === "assistant" && message.toolCalls?.length) {
        for (const call of message.toolCalls) {
          this.appendActivityLine("call", call.name, prettyJson(call.arguments), time);
        }
      }
      if (message.role === "tool") {
        this.appendActivityLine("result", message.name ?? "tool", chatContentToText(message.content), time);
      }
    }

    if (this.log.length === 0) {
      this.appendLog("system", "Welcome to Arivu. Describe what you want to build, or press Ctrl+P for commands.");
    }

    this.appendActivityLine("system", "workspace", `${this.workspace.root}\n${this.workspace.dirty ? "git: dirty" : "git: clean"}`);
  }

  private async submit(rawValue: string) {
    const value = rawValue.trim();
    this.clearPromptDraft();
    this.focusInput();

    if (!value) {
      this.render();
      return;
    }

    if (await this.handleSlashCommand(value)) {
      this.render();
      return;
    }

    if (this.busy) {
      this.promptQueue.push(value);
      this.appendActivityLine("system", "Queued prompt", value);
      this.setStatus(`${this.promptQueue.length} prompt${this.promptQueue.length === 1 ? "" : "s"} queued`);
      return;
    }

    await this.runPrompt(value);
  }

  private async runPrompt(value: string) {
    this.appendLog("user", value);
    this.forceConversationTail = true;
    await this.executeAgentTurn((signal) =>
      this.agent.run(value, {
        onEvent: (event) => this.handleAgentEvent(event),
        onUsage: (usage) => this.recordRunUsage(usage),
        signal
      })
    );
  }

  private async continueTurn(): Promise<void> {
    if (this.busy) {
      return;
    }
    if (!this.currentSession || this.currentSession.messages.length === 0) {
      this.setStatus("Nothing to continue");
      this.render();
      return;
    }
    await this.executeAgentTurn((signal) =>
      this.agent.continue({
        onEvent: (event) => this.handleAgentEvent(event),
        onUsage: (usage) => this.recordRunUsage(usage),
        signal
      })
    );
  }

  private recordRunUsage(usage: ChatUsage) {
    const previous = this.lastRunUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, requestCount: 0 };
    if (usage.promptTokens !== undefined) {
      this.currentContextTokens = usage.promptTokens;
    }
    this.lastRunUsage = {
      promptTokens: previous.promptTokens + (usage.promptTokens ?? 0),
      completionTokens: previous.completionTokens + (usage.completionTokens ?? 0),
      totalTokens: previous.totalTokens + (usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)),
      requestCount: previous.requestCount + 1
    };
  }

  private async executeAgentTurn(runner: (signal: AbortSignal) => Promise<{ output: string; session: AgentSession }>): Promise<void> {
    this.busy = true;
    this.runAbortController = new AbortController();
    this.runStartedAt = Date.now();
    this.lastRunUsage = undefined;
    this.streamingAssistantIndex = undefined;
    this.liveActivity = false;
    this.streamingToolRows.clear();
    this.forceConversationTail = true;
    this.forceActivityTail = true;
    this.startSpinner();
    this.setStatus("Responding");

    try {
      const before = this.lastMessageCount;
      const result = await runner(this.runAbortController.signal);
      await this.store.save(result.session);
      this.currentSession = result.session;
      this.cwd = result.session.cwd;
      if (!this.liveActivity) {
        this.appendActivity(result.session.messages.slice(before));
      }
      this.lastMessageCount = result.session.messages.length;
      if (this.streamingAssistantIndex === undefined) {
        this.appendLog("assistant", result.output || "(no response)");
      } else if (!this.log[this.streamingAssistantIndex]?.text.trim() && result.output) {
        this.log[this.streamingAssistantIndex].text = result.output;
      }
      this.setStatus(`Saved ${result.session.id.slice(0, 8)}`);
    } catch (error) {
      if (error instanceof AgentRunAbortedError || this.runAbortController?.signal.aborted) {
        this.appendLog("system", "Run stopped.");
        this.setStatus("Run stopped");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.appendLog("error", message);
        this.appendActivityLine("error", "agent error", message);
        this.setStatus("Error");
      }
    } finally {
      this.busy = false;
      this.runAbortController = undefined;
      this.runStartedAt = undefined;
      this.stopSpinner();
      if (!this.closing) {
        this.focusInput();
        this.render();
        const nextPrompt = this.promptQueue.shift();
        if (nextPrompt) {
          this.setStatus(`Starting queued prompt${this.promptQueue.length > 0 ? ` · ${this.promptQueue.length} remaining` : ""}`);
          setImmediate(() => void this.runPrompt(nextPrompt));
        }
      }
    }
  }

  private async handleSlashCommand(value: string): Promise<boolean> {
    const command = parseTuiSlashCommand(value);
    if (!command || command.kind === "unknown") {
      return false;
    }

    if (this.busy && commandChangesRunState(command)) {
      this.setStatus("Stop the active turn before changing sessions or context");
      return true;
    }

    if (command.kind === "exit") {
      this.exit();
      return true;
    }

    if (command.kind === "help") {
      this.showHelp();
      return true;
    }

    if (command.kind === "activity") {
      this.toggleActivity();
      return true;
    }

    if (command.kind === "clear") {
      this.clearConversation();
      return true;
    }

    if (command.kind === "continue") {
      await this.continueTurn();
      return true;
    }

    if (command.kind === "status") {
      this.showStatus();
      return true;
    }

    if (command.kind === "diff") {
      await this.showGitDiff();
      return true;
    }

    if (command.kind === "compact") {
      await this.compactCurrentSession(command.recentMessageCount);
      return true;
    }

    if (command.kind === "summarize") {
      await this.summarizeCurrentSession();
      return true;
    }

    if (command.kind === "sessions") {
      if (command.pick) {
        await this.pickSession(command.limit, command.filters);
      } else {
        await this.showSessions(command.limit, command.filters);
      }
      return true;
    }

    if (command.kind === "resume") {
      await this.resumeSession(command.sessionId);
      return true;
    }

    if (command.kind === "error") {
      this.appendLog("error", command.message);
      this.setStatus("Command error");
    }
    return true;
  }

  private appendActivity(messages: ChatMessage[]) {
    for (const message of messages) {
      if (message.role === "assistant" && message.toolCalls?.length) {
        for (const call of message.toolCalls) {
          this.appendActivityLine("call", call.name, prettyJson(call.arguments), parseTuiDate(message.createdAt));
        }
      }
      if (message.role === "tool") {
        this.appendActivityLine("result", message.name ?? "tool", chatContentToText(message.content), parseTuiDate(message.createdAt));
      }
    }
  }

  private handleAgentEvent(event: AgentRunEvent) {
    if (event.type === "assistant_delta") {
      const index = this.ensureStreamingAssistant();
      this.log[index].text += event.delta;
      this.render();
      return;
    }

    if (event.type === "tool_call_delta") {
      this.liveActivity = true;
      const key = event.toolCallId || `index-${event.index}`;
      const row = this.ensureStreamingToolRow(key, event.name || `tool ${event.index + 1}`);
      this.activityLog[row] = {
        ...this.activityLog[row],
        title: event.name || this.activityLog[row].title,
        detail: event.argumentsText || "(waiting for arguments)"
      };
      this.render();
      return;
    }

    if (event.type === "tool_call") {
      this.liveActivity = true;
      const row = this.ensureStreamingToolRow(event.call.id, event.call.name);
      this.activityLog[row] = {
        ...this.activityLog[row],
        title: event.call.name,
        detail: prettyJson(event.call.arguments)
      };
      this.render();
      return;
    }

    if (event.type === "browser_task_progress") {
      this.liveActivity = true;
      const row = this.ensureStreamingToolRow("browser_task_progress", "browser_task");
      this.activityLog[row] = {
        ...this.activityLog[row],
        title: `browser_task (step ${event.stepIndex})`,
        detail: event.summary
      };
      this.render();
      return;
    }

    if (event.type === "empty_response_retry") {
      this.liveActivity = true;
      const minutes = Math.round(event.delayMs / 60_000);
      const row = this.ensureStreamingToolRow("empty_response_retry", "model");
      this.activityLog[row] = {
        ...this.activityLog[row],
        title: "Empty response from model",
        detail: `Retrying in ${minutes} min (attempt ${event.attempt} of ${event.maxAttempts})…`
      };
      this.setStatus(`Empty response — retrying in ${minutes} min (${event.attempt}/${event.maxAttempts})`);
      this.render();
      return;
    }

    if (event.type === "tool_result") {
      this.liveActivity = true;
      this.streamingAssistantIndex = undefined;
      const existing = this.streamingToolRows.get(event.toolCallId);
      if (existing !== undefined && this.activityLog[existing]) {
        this.activityLog[existing] = {
          ...this.activityLog[existing],
          kind: "result",
          title: event.name,
          detail: event.result,
          time: new Date()
        };
      } else {
        this.appendActivityLine("result", event.name, event.result);
      }
      this.render();
    }
  }

  private ensureStreamingAssistant() {
    if (this.streamingAssistantIndex !== undefined && this.log[this.streamingAssistantIndex]?.kind === "assistant") {
      return this.streamingAssistantIndex;
    }

    this.streamingAssistantIndex = this.appendLog("assistant", "");
    return this.streamingAssistantIndex;
  }

  private ensureStreamingToolRow(key: string, title: string) {
    const existing = this.streamingToolRows.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const index = this.appendActivityLine("call", title, "(waiting for arguments)");
    this.streamingToolRows.set(key, index);
    return index;
  }

  private openCommandPalette() {
    if (this.modalOpen) {
      return;
    }

    const modal = blessed.box({
      top: "center",
      left: "center",
      width: "82%",
      height: Math.min(Math.max(TUI_PALETTE_COMMANDS.length + 8, 14), Math.max(Number(this.screen.height) - 2, 14)),
      label: " commands ",
      tags: true,
      border: "line",
      padding: { left: 1, right: 1 },
      style: {
        fg: "white",
        bg: "#111111",
        border: { fg: "cyan" }
      }
    });
    let query = "";
    const search = blessed.box({
      parent: modal,
      top: 0,
      left: 0,
      right: 0,
      height: 3,
      label: " search ",
      border: "line",
      keys: true,
      mouse: true,
      tags: true,
      padding: { left: 1 },
      style: {
        fg: "white",
        bg: "#111111",
        border: { fg: "gray" },
        focus: { border: { fg: "cyan" } }
      }
    });
    const list = blessed.list({
      parent: modal,
      top: 3,
      left: 0,
      right: 0,
      bottom: 3,
      tags: true,
      keys: true,
      mouse: true,
      vi: true,
      items: formatTuiPaletteItems(TUI_PALETTE_COMMANDS),
      style: {
        selected: { bg: "#263238", fg: "white", bold: true },
        item: { fg: "white", bg: "#111111" }
      }
    });
    const description = blessed.box({
      parent: modal,
      left: 0,
      right: 0,
      bottom: 1,
      height: 2,
      tags: true,
      style: { fg: "gray", bg: "#111111" }
    });
    blessed.box({
      parent: modal,
      left: 0,
      right: 0,
      bottom: 0,
      height: 1,
      tags: true,
      content: "{gray-fg}Type to filter  ↑/↓ move  Enter run  Esc close{/gray-fg}",
      style: { bg: "#111111" }
    });

    let matches: TuiPaletteCommand[] = TUI_PALETTE_COMMANDS;
    let selectedIndex = 0;
    let closed = false;
    const updateDescription = () => {
      const entry = matches[selectedIndex];
      description.setContent(entry ? `{gray-fg}${escapeBlessedTags(entry.description)}{/gray-fg}` : "");
    };
    const refresh = () => {
      matches = filterTuiPaletteCommands(query);
      selectedIndex = Math.min(selectedIndex, Math.max(matches.length - 1, 0));
      search.setContent(
        query ? `{cyan-fg}❯{/cyan-fg} ${escapeBlessedTags(query)}` : "{cyan-fg}❯{/cyan-fg} {gray-fg}Filter commands…{/gray-fg}"
      );
      list.setItems(matches.length > 0 ? formatTuiPaletteItems(matches) : ["{gray-fg}No matching commands{/gray-fg}"]);
      list.select(selectedIndex);
      updateDescription();
      this.screen.render();
    };
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      this.modalOpen = false;
      modal.destroy();
      this.focusInput();
      this.render();
    };
    const choose = (index = selectedIndex) => {
      const entry = matches[index];
      if (!entry) {
        return;
      }
      close();
      void this.handleSlashCommand(entry.command).then(() => this.render());
    };

    search.on("keypress", (character, key) => {
      if (key.name === "escape") {
        close();
        return;
      }
      if (key.name === "enter") {
        choose();
        return;
      }
      if (key.name === "up") {
        selectedIndex = Math.max(0, selectedIndex - 1);
        list.select(selectedIndex);
        updateDescription();
        this.screen.render();
        return;
      }
      if (key.name === "down") {
        selectedIndex = Math.min(Math.max(matches.length - 1, 0), selectedIndex + 1);
        list.select(selectedIndex);
        updateDescription();
        this.screen.render();
        return;
      }
      if (key.name === "backspace") {
        query = query.slice(0, -1);
        refresh();
        return;
      }
      const codePoint = character?.codePointAt(0);
      if (character && !key.ctrl && !key.meta && codePoint !== undefined && codePoint >= 32 && codePoint !== 127) {
        query += character;
        refresh();
      }
    });
    list.on("select", (_item, index) => choose(index));
    list.key(["escape"], close);
    modal.key(["escape"], close);

    refresh();
    this.screen.append(modal);
    this.modalOpen = true;
    search.focus();
    this.screen.render();
  }

  private showHelp() {
    this.openTextModal(" keyboard shortcuts ", TUI_SHORTCUT_HELP);
  }

  private openTextModal(label: string, content: string) {
    if (this.modalOpen) {
      return;
    }
    const modal = blessed.box({
      top: "center",
      left: "center",
      width: "78%",
      height: "80%",
      label,
      content,
      tags: true,
      wrap: true,
      scrollable: true,
      alwaysScroll: false,
      keys: true,
      vi: true,
      mouse: true,
      border: "line",
      padding: { left: 2, right: 2, top: 1, bottom: 1 },
      scrollbar: {
        ch: " ",
        track: { bg: "#111111" },
        style: { bg: "gray" }
      },
      style: {
        fg: "white",
        bg: "#111111",
        border: { fg: "cyan" }
      }
    });
    const close = () => {
      this.modalOpen = false;
      modal.destroy();
      this.focusInput();
      this.render();
    };
    modal.key(["escape", "q", "C-x"], close);
    this.screen.append(modal);
    this.modalOpen = true;
    modal.focus();
    this.screen.render();
  }

  private showStatus() {
    this.appendLog(
      "system",
      [
        `Session: ${this.currentSession?.id ?? "new"}`,
        `Workspace: ${this.workspace.root}`,
        `Project: ${this.workspace.packageName ?? path.basename(this.workspace.root)}`,
        `Git: ${this.workspace.gitBranch ?? "no branch"} / ${this.workspace.dirty ? "dirty" : "clean"}`,
        `Model: ${this.config.model}`,
        `Base URL: ${this.config.baseUrl}`,
        `Trust: ${this.config.trustMode}`,
        this.lastRunUsage
          ? `Last run tokens: ${this.lastRunUsage.totalTokens} total (${this.lastRunUsage.promptTokens} prompt / ${this.lastRunUsage.completionTokens} completion) over ${this.lastRunUsage.requestCount} request${this.lastRunUsage.requestCount === 1 ? "" : "s"}`
          : "Last run tokens: not reported"
      ].join("\n")
    );
    this.setStatus("Status");
  }

  private async showGitDiff() {
    try {
      const summary = await loadTuiGitDiffSummary(this.workspace.root);
      this.appendLog("system", formatTuiGitDiffSummary(summary));
      this.setStatus("Diff");
    } catch (error) {
      this.appendLog("error", `Unable to summarize git diff: ${error instanceof Error ? error.message : String(error)}`);
      this.setStatus("Diff failed");
    }
  }

  private async compactCurrentSession(recentMessageCount = COMPACT_RECENT_MESSAGE_COUNT) {
    if (!this.currentSession) {
      this.appendLog("system", "No saved session to compact yet. Send a prompt first, then run /compact.");
      this.setStatus("No session");
      return;
    }

    try {
      const now = new Date();
      const result = compactSessionMessages(contextMessagesForSession(this.currentSession), {
        recentMessageCount,
        now
      });

      if (!result.compacted) {
        this.appendLog(
          "system",
          `Session ${this.currentSession.id} is already compact enough. Non-system messages: ${result.remainingMessageCount}; recent window: ${recentMessageCount}.`,
          now
        );
        this.setStatus("Already compact");
        return;
      }

      const compactedSession: AgentSession = {
        ...this.currentSession,
        updatedAt: now.toISOString()
      };
      applyContextCompactionCheckpoint(compactedSession, result, "deterministic", now);
      await this.store.save(compactedSession);

      this.currentSession = compactedSession;
      this.agent = this.createAgent(compactedSession);
      this.lastMessageCount = compactedSession.messages.length;
      this.streamingAssistantIndex = undefined;
      this.liveActivity = false;
      this.streamingToolRows.clear();
      this.log.splice(0, this.log.length);
      this.activityLog.splice(0, this.activityLog.length);
      this.seedFromSession(compactedSession);
      this.appendLog(
        "system",
        [
          `Compacted session ${compactedSession.id}.`,
          `Compacted messages: ${result.compactedMessageCount}`,
          `Kept recent messages: ${result.remainingMessageCount}`,
          `Working context messages: ${result.messages.length}`,
          `Full transcript messages preserved: ${compactedSession.messages.length}`
        ].join("\n"),
        now
      );
      this.forceConversationTail = true;
      this.forceActivityTail = true;
      this.setStatus("Compacted");
    } catch (error) {
      this.appendLog("error", `Unable to compact session: ${error instanceof Error ? error.message : String(error)}`);
      this.setStatus("Compaction failed");
    }
  }

  private async summarizeCurrentSession() {
    if (!this.currentSession) {
      this.appendLog("system", "No saved session to summarize yet. Send a prompt first, then run /summarize.");
      this.setStatus("No session");
      return;
    }
    if (this.busy) {
      return;
    }

    this.busy = true;
    this.runAbortController = new AbortController();
    this.runStartedAt = Date.now();
    this.startSpinner();
    this.setStatus("Summarizing context");
    try {
      const agent = this.createAgent(this.currentSession);
      const result = await agent.summarizeContext({ signal: this.runAbortController.signal });
      if (!result.compacted) {
        this.appendLog("system", "Session is already compact enough to skip summarizing.");
        this.setStatus("Already compact");
        return;
      }
      const now = new Date();
      const summarizedSession: AgentSession = { ...result.session, updatedAt: now.toISOString() };
      await this.store.save(summarizedSession);
      this.currentSession = summarizedSession;
      this.agent = this.createAgent(summarizedSession);
      this.lastMessageCount = summarizedSession.messages.length;
      this.streamingAssistantIndex = undefined;
      this.liveActivity = false;
      this.streamingToolRows.clear();
      this.log.splice(0, this.log.length);
      this.activityLog.splice(0, this.activityLog.length);
      this.seedFromSession(summarizedSession);
      this.appendLog(
        "system",
        [
          `Summarized session ${summarizedSession.id} (${result.source}).`,
          `Summarized messages: ${result.compactedMessageCount}`,
          `Working context messages: ${result.remainingMessageCount}`,
          `Full transcript messages preserved: ${summarizedSession.messages.length}`
        ].join("\n"),
        now
      );
      this.forceConversationTail = true;
      this.forceActivityTail = true;
      this.setStatus("Summarized");
    } catch (error) {
      if (error instanceof AgentRunAbortedError || this.runAbortController?.signal.aborted) {
        this.setStatus("Summary stopped");
      } else {
        this.appendLog("error", `Unable to summarize session: ${error instanceof Error ? error.message : String(error)}`);
        this.setStatus("Summary failed");
      }
    } finally {
      this.busy = false;
      this.runAbortController = undefined;
      this.runStartedAt = undefined;
      this.stopSpinner();
      if (!this.closing) {
        this.focusInput();
        this.render();
      }
    }
  }

  private async showSessions(limit: number, filters?: SessionListFilters) {
    try {
      const sessions = await this.store.list();
      this.appendLog("system", formatTuiSessionList(sessions, limit, filters));
      this.setStatus("Sessions");
    } catch (error) {
      this.appendLog("error", `Unable to list sessions: ${error instanceof Error ? error.message : String(error)}`);
      this.setStatus("Session list failed");
    }
  }

  private async pickSession(limit: number, filters?: SessionListFilters) {
    try {
      const sessions = filterSessions(await this.store.list(), filters).slice(0, clampSessionLimit(limit));
      if (sessions.length === 0) {
        const filterDescription = describeSessionListFilters(filters);
        this.appendLog("system", filterDescription ? `No saved sessions match filters: ${filterDescription}.` : "No saved sessions.");
        this.setStatus("Sessions");
        return;
      }
      await this.openSessionPicker(sessions, filters);
    } catch (error) {
      this.appendLog("error", `Unable to open session picker: ${error instanceof Error ? error.message : String(error)}`);
      this.setStatus("Session picker failed");
    }
  }

  private openSessionPicker(sessions: AgentSession[], filters?: SessionListFilters): Promise<void> {
    return new Promise((resolve) => {
      const filterDescription = describeSessionListFilters(filters);
      const screenHeight = Math.max(Number(this.screen.height) || 24, 10);
      const height = Math.min(Math.max(sessions.length + (filterDescription ? 8 : 6), 10), Math.max(screenHeight - 2, 10));
      const modal = blessed.box({
        top: "center",
        left: "center",
        width: "86%",
        height,
        label: " saved sessions ",
        tags: true,
        border: "line",
        padding: { left: 1, right: 1, top: 1 },
        style: {
          bg: "black",
          fg: "white",
          border: { fg: "cyan" }
        }
      });
      blessed.box({
        parent: modal,
        top: 0,
        left: 0,
        right: 0,
        height: filterDescription ? 3 : 2,
        tags: true,
        content: [
          "{bold}Select a session to resume{/bold}",
          filterDescription ? `{gray-fg}Filters: ${filterDescription}{/gray-fg}` : undefined
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n")
      });
      const list = blessed.list({
        parent: modal,
        top: filterDescription ? 3 : 2,
        left: 0,
        right: 0,
        bottom: 2,
        keys: true,
        mouse: true,
        vi: true,
        tags: true,
        items: formatTuiSessionPickerItems(sessions),
        scrollbar: {
          ch: " ",
          track: { bg: "black" },
          style: { bg: "cyan" }
        },
        style: {
          selected: { bg: "blue", fg: "white" },
          item: { fg: "white" }
        }
      });
      blessed.box({
        parent: modal,
        left: 0,
        right: 0,
        bottom: 0,
        height: 1,
        tags: true,
        content: "{gray-fg}Enter resume  Up/Down move  Esc cancel{/gray-fg}"
      });
      const close = () => {
        this.modalOpen = false;
        modal.destroy();
        this.focusInput();
        this.render();
      };
      list.on("select", (_item, index) => {
        const session = sessions[index];
        if (!session) {
          return;
        }
        close();
        void this.resumeSession(session.id).finally(resolve);
      });
      const cancel = () => {
        close();
        this.setStatus("Session picker dismissed");
        resolve();
      };
      modal.key(["escape", "q"], cancel);
      list.key(["escape", "q"], cancel);
      this.screen.append(modal);
      this.modalOpen = true;
      list.focus();
      this.screen.render();
    });
  }

  private async resumeSession(sessionId: string) {
    try {
      const session = await this.store.load(sessionId);
      this.currentSession = session;
      this.config = configForSession(this.options.config, session);
      this.cwd = session.cwd;
      this.workspace = await detectWorkspace(this.cwd);
      this.agent = this.createAgent(session);
      this.lastMessageCount = session.messages.length;
      this.streamingAssistantIndex = undefined;
      this.liveActivity = false;
      this.streamingToolRows.clear();
      this.log.splice(0, this.log.length);
      this.activityLog.splice(0, this.activityLog.length);
      this.seedFromSession(session);
      this.currentContextTokens = undefined;
      this.forceConversationTail = true;
      this.forceActivityTail = true;
      this.focusInput();
      this.setStatus(`Resumed session ${session.id}`);
    } catch (error) {
      this.appendLog("error", `Unable to resume session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      this.setStatus("Resume failed");
    }
  }

  private confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = blessed.box({
        top: "center",
        left: "center",
        width: "74%",
        height: 11,
        label: " approval required ",
        tags: true,
        border: "line",
        padding: { left: 2, right: 2, top: 1 },
        content: [
          "{yellow-fg}Action needs approval{/yellow-fg}",
          "",
          escapeBlessedTags(truncate(message, 900)),
          "",
          "{green-fg}y{/green-fg} approve    {red-fg}n{/red-fg} deny    {gray-fg}esc{/gray-fg} deny"
        ].join("\n"),
        style: {
          bg: "black",
          fg: "white",
          border: { fg: "yellow" }
        }
      });

      const finish = (approved: boolean) => {
        this.appendActivityLine(approved ? "system" : "error", approved ? "approval granted" : "approval denied", message);
        this.modalOpen = false;
        modal.destroy();
        this.focusInput();
        this.render();
        resolve(approved);
      };

      modal.key(["y", "Y"], () => finish(true));
      modal.key(["n", "N", "escape"], () => finish(false));
      this.screen.append(modal);
      this.modalOpen = true;
      modal.focus();
      this.screen.render();
    });
  }

  private render() {
    if (this.closing) {
      return;
    }
    const conversationScroll = this.conversation.getScroll();
    const conversationAtTail = this.forceConversationTail || this.conversation.getScrollPerc() >= 98;
    const activityScroll = this.activity.getScroll();
    const activityAtTail = this.forceActivityTail || this.activity.getScrollPerc() >= 98;

    this.header.setContent(this.formatHeader());
    this.conversation.setContent(this.formatConversation());
    this.activity.setContent(this.formatActivity());
    this.turnStatus.setContent(this.formatTurnStatus());
    this.promptInfo.setContent(this.formatPromptInfo());
    this.commandBar.setContent(this.formatCommandBar());
    this.input.setContent(
      formatTuiPromptDraft(
        { value: this.promptDraft, cursor: this.promptCursor },
        Math.max(8, Number(this.screen.width) - 8),
        this.focusTarget === "input" && !this.modalOpen
      )
    );
    this.promptPrefix.setContent(
      this.busy ? `{bold}{yellow-fg}${SPINNER[this.spinnerFrame]}{/yellow-fg}{/bold}` : "{bold}{cyan-fg}❯{/cyan-fg}{/bold}"
    );

    if (conversationAtTail) {
      this.conversation.setScrollPerc(100);
    } else {
      this.conversation.setScroll(conversationScroll);
    }
    if (activityAtTail) {
      this.activity.setScrollPerc(100);
    } else {
      this.activity.setScroll(activityScroll);
    }
    this.forceConversationTail = false;
    this.forceActivityTail = false;
    this.screen.render();
  }

  private formatHeader() {
    const width = Math.max(24, Number(this.screen.width) - 4);
    const git = this.workspace.gitBranch ? `${this.workspace.gitBranch}${this.workspace.dirty ? "*" : ""}` : "no git";
    const totalTokens = resolveContextWindowTokens(
      this.config,
      { model: this.config.model, baseUrl: this.config.baseUrl },
      this.modelCatalog
    );
    const context = formatTuiContextUsage(this.estimatedContextTokens(), totalTokens);
    const leftBudget = Math.max(18, width - context.length - git.length - 8);
    const left = `{gray-fg} ${escapeBlessedTags(git)}  ${escapeBlessedTags(shortenPath(this.workspace.root, leftBudget))}{/gray-fg}`;
    const right = `{white-fg}${context}{/white-fg}`;
    return formatTuiAlignedLine(left, right, width);
  }

  private formatConversation() {
    return formatTuiTranscript(this.log, this.activityLog, Math.max(24, Number(this.screen.width) - 5));
  }

  private formatActivity() {
    return formatTuiActivityDrawer(this.activityLog);
  }

  private formatTurnStatus() {
    const width = Math.max(24, Number(this.screen.width) - 4);
    if (this.busy) {
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - (this.runStartedAt ?? Date.now())) / 1_000));
      const queued = this.promptQueue.length > 0 ? ` · ${this.promptQueue.length} queued` : "";
      const left = `{cyan-fg}${SPINNER[this.spinnerFrame]}{/cyan-fg} ${escapeBlessedTags(this.status)}{gray-fg}${queued}{/gray-fg}`;
      const used = this.lastRunUsage?.totalTokens;
      const tokens = used ? ` · ${formatTuiTokenCount(used)}` : "";
      const right = `{gray-fg}${elapsedSeconds}s${tokens}{/gray-fg}  {red-fg}[stop]{/red-fg}`;
      return formatTuiAlignedLine(left, right, width);
    }
    if (this.promptQueue.length > 0) {
      return `{yellow-fg}◇{/yellow-fg} ${this.promptQueue.length} queued prompt${this.promptQueue.length === 1 ? "" : "s"}`;
    }
    return `{gray-fg}${escapeBlessedTags(this.status)}{/gray-fg}`;
  }

  private formatPromptInfo() {
    const model = shortenPath(this.config.model, Math.max(18, Math.floor(Number(this.screen.width) / 2)));
    return `{gray-fg}${escapeBlessedTags(model)} · ${escapeBlessedTags(this.config.trustMode)}{/gray-fg}`;
  }

  private formatCommandBar() {
    const width = Number(this.screen.width);
    const join = (items: string[]) => items.join("  {gray-fg}│{/gray-fg}  ");
    if (this.busy) {
      const items = [
        "{bold}Enter{/bold}:queue",
        "{bold}Esc{/bold}:stop",
        "{bold}Ctrl+G{/bold}:activity",
        "{bold}Ctrl+P{/bold}:commands",
        "{bold}Ctrl+X{/bold}:shortcuts"
      ];
      return join(width < 92 ? items.slice(0, 4) : items);
    }
    if (this.focusTarget === "conversation") {
      const items = [
        "{bold}PgUp/PgDn{/bold}:scroll",
        "{bold}Tab{/bold}:prompt",
        "{bold}Ctrl+G{/bold}:activity",
        "{bold}Ctrl+P{/bold}:commands",
        "{bold}Ctrl+Q{/bold}:quit"
      ];
      return join(width < 92 ? [items[0], items[1], items[3], items[4]] : items);
    }
    if (this.focusTarget === "activity") {
      return join([
        "{bold}PgUp/PgDn{/bold}:scroll",
        "{bold}Ctrl+G{/bold}:close",
        "{bold}Tab{/bold}:prompt",
        "{bold}Ctrl+P{/bold}:commands"
      ]);
    }
    const items = [
      "{bold}Enter{/bold}:send",
      "{bold}Tab{/bold}:scrollback",
      "{bold}Ctrl+P{/bold}:commands",
      "{bold}Ctrl+S{/bold}:sessions",
      "{bold}Ctrl+G{/bold}:activity",
      "{bold}Ctrl+Q{/bold}:quit"
    ];
    if (width < 92) {
      return join([items[0], items[2], items[4], items[5]]);
    }
    if (width < 126) {
      return join([items[0], items[1], items[2], items[4], items[5]]);
    }
    return join(items);
  }

  private estimatedContextTokens() {
    if (this.currentContextTokens !== undefined) {
      return this.currentContextTokens;
    }
    if (!this.currentSession) {
      return 0;
    }
    const characters = contextMessagesForSession(this.currentSession).reduce(
      (total, message) => total + chatContentToText(message.content).length,
      0
    );
    return Math.ceil(characters / 4);
  }

  private setStatus(message: string) {
    this.status = message;
    this.render();
  }

  private startSpinner() {
    this.stopSpinner();
    this.spinner = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
      this.render();
    }, 160);
  }

  private stopSpinner() {
    if (this.spinner) {
      clearInterval(this.spinner);
      this.spinner = undefined;
    }
    this.spinnerFrame = 0;
  }

  private focusNext() {
    if (this.focusTarget === "input") {
      this.focusConversation();
    } else if (this.focusTarget === "conversation" && this.activityOpen) {
      this.focusActivity();
    } else {
      this.focusInput();
    }
    this.render();
  }

  private focusPrevious() {
    if (this.focusTarget === "input" && this.activityOpen) {
      this.focusActivity();
    } else if (this.focusTarget === "activity") {
      this.focusConversation();
    } else {
      this.focusInput();
    }
    this.render();
  }

  private focusInput() {
    this.focusTarget = "input";
    this.input.focus();
  }

  private handlePromptKeypress(character: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) {
    if (this.modalOpen || this.screen.focused !== this.input) {
      return;
    }
    const result = editTuiPrompt({ value: this.promptDraft, cursor: this.promptCursor }, character, key);
    if (!result.handled) {
      return;
    }
    this.promptDraft = result.value;
    this.promptCursor = result.cursor;
    if (result.submitted !== undefined) {
      void this.submit(result.submitted);
      return;
    }
    this.render();
  }

  private clearPromptDraft() {
    this.promptDraft = "";
    this.promptCursor = 0;
  }

  private focusConversation() {
    this.focusTarget = "conversation";
    this.conversation.focus();
  }

  private focusActivity() {
    if (!this.activityOpen) {
      this.toggleActivity(true);
    }
    this.focusTarget = "activity";
    this.activity.focus();
  }

  private scrollPane(shortcut: TuiPaneScrollShortcut) {
    if (shortcut.target === "activity" && !this.activityOpen) {
      this.toggleActivity(true);
    }
    const pane = shortcut.target === "activity" ? this.activity : this.focusTarget === "activity" ? this.activity : this.conversation;
    if (shortcut.action === "top") {
      pane.setScrollPerc(0);
    } else if (shortcut.action === "bottom") {
      pane.setScrollPerc(100);
    } else {
      const pageLines = Math.max(4, Math.floor(Number(this.screen.height || 24) / 2));
      pane.scroll(shortcut.action === "page-up" ? -pageLines : pageLines);
    }
    this.screen.render();
  }

  private clearConversation() {
    this.log.splice(0, this.log.length);
    this.activityLog.splice(0, this.activityLog.length);
    this.streamingAssistantIndex = undefined;
    this.streamingToolRows.clear();
    this.appendLog("system", "Visible transcript cleared. Saved session history is still preserved.");
    this.forceConversationTail = true;
    this.forceActivityTail = true;
    this.setStatus("Cleared");
  }

  private applyResponsiveLayout() {
    const width = Number(this.screen.width);
    this.conversation.width = "100%";
    this.activity.width = resolveTuiActivityDrawerWidth(Number.isFinite(width) ? width : 80);
    if (this.activityOpen) {
      this.activity.show();
      this.activity.setFront();
    } else {
      this.activity.hide();
    }
  }

  private toggleActivity(force?: boolean) {
    this.activityOpen = force ?? !this.activityOpen;
    this.forceActivityTail = this.activityOpen;
    if (!this.activityOpen && this.focusTarget === "activity") {
      this.focusInput();
    }
    this.applyResponsiveLayout();
    if (this.activityOpen) {
      this.focusTarget = "activity";
      this.activity.focus();
    }
    this.render();
  }

  private stopRun() {
    if (this.runAbortController && !this.runAbortController.signal.aborted) {
      this.runAbortController.abort(new AgentRunAbortedError());
      this.setStatus("Stopping");
    }
  }

  private handleCtrlC() {
    if (this.modalOpen) {
      return;
    }
    if (this.promptDraft) {
      this.clearPromptDraft();
      this.setStatus("Draft cleared");
      return;
    }
    if (this.busy) {
      this.stopRun();
      return;
    }
    this.requestExit("Ctrl+C");
  }

  private requestExit(shortcut = "Ctrl+Q") {
    if (this.modalOpen) {
      return;
    }
    const now = Date.now();
    if (now <= this.quitArmedUntil) {
      this.exit();
      return;
    }
    this.quitArmedUntil = now + 2_000;
    this.setStatus(`Press ${shortcut} again to quit`);
  }

  private exit() {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.stopSpinner();
    if (this.runAbortController && !this.runAbortController.signal.aborted) {
      this.runAbortController.abort(new AgentRunAbortedError());
    }
    this.screen.destroy();
  }
}

function commandChangesRunState(command: TuiSlashCommand) {
  return (
    command.kind === "compact" ||
    command.kind === "continue" ||
    command.kind === "resume" ||
    command.kind === "summarize" ||
    (command.kind === "sessions" && Boolean(command.pick))
  );
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
}

function parseTuiDate(value: string | undefined) {
  if (!value) {
    return new Date();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function resolveTuiPaneScrollShortcut(keyName: string): TuiPaneScrollShortcut | null {
  const normalized = normalizeTuiKeyName(keyName);
  for (const binding of TUI_PANE_SCROLL_KEY_BINDINGS) {
    if (binding.keys.some((key) => normalizeTuiKeyName(key) === normalized)) {
      return binding.shortcut;
    }
  }
  return null;
}

function normalizeTuiKeyName(keyName: string) {
  return keyName
    .trim()
    .toLowerCase()
    .replace(/^shift-/, "s-")
    .replace(/^ctrl-/, "c-")
    .replace(/^control-/, "c-")
    .replace(/^c-shift-/, "c-s-")
    .replace(/^shift-c-/, "c-s-")
    .replace(/^s-c-/, "c-s-")
    .replace(/^pgup$/, "pageup")
    .replace(/^pgdn$/, "pagedown");
}

function shortenPath(value: string, max: number) {
  if (value.length <= max) {
    return value;
  }
  return `...${value.slice(value.length - max + 3)}`;
}

export function parseTuiSlashCommand(value: string): TuiSlashCommand | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const [name = "", ...args] = trimmed.split(/\s+/);
  switch (name.toLowerCase()) {
    case "/exit":
    case "/quit":
      return { kind: "exit" };
    case "/help":
      return { kind: "help" };
    case "/activity":
    case "/tools":
      return { kind: "activity" };
    case "/clear":
      return { kind: "clear" };
    case "/continue":
      return { kind: "continue" };
    case "/status":
      return { kind: "status" };
    case "/diff":
      return { kind: "diff" };
    case "/compact":
      return parseCompactCommand(args);
    case "/summarize":
      return { kind: "summarize" };
    case "/sessions":
      return parseSessionsCommand(args);
    case "/resume":
      if (!args[0]) {
        return { kind: "error", message: "Usage: /resume <session-id>" };
      }
      return { kind: "resume", sessionId: args[0] };
    default:
      return { kind: "unknown" };
  }
}

function parseCompactCommand(args: string[]): TuiSlashCommand {
  if (args.length === 0) {
    return { kind: "compact" };
  }
  if (args.length > 1) {
    return compactUsageError();
  }
  const recentMessageCount = Number.parseInt(args[0] ?? "", 10);
  if (!Number.isFinite(recentMessageCount) || recentMessageCount < 1) {
    return compactUsageError();
  }
  return { kind: "compact", recentMessageCount };
}

function compactUsageError(): TuiSlashCommand {
  return { kind: "error", message: "Usage: /compact [positive-recent-message-count]" };
}

export async function loadTuiGitDiffSummary(root: string): Promise<TuiGitDiffSummary> {
  await execa("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]);
  const [branch, stagedShortstat, unstagedShortstat, stagedFiles, unstagedFiles, statusShort] = await Promise.all([
    gitOutput(root, ["branch", "--show-current"]),
    gitOutput(root, ["diff", "--cached", "--shortstat"]),
    gitOutput(root, ["diff", "--shortstat"]),
    gitOutput(root, ["diff", "--cached", "--name-status", "--"]),
    gitOutput(root, ["diff", "--name-status", "--"]),
    gitOutput(root, ["status", "--short", "--untracked-files=normal"])
  ]);

  return {
    root,
    branch: branch || undefined,
    stagedShortstat: stagedShortstat || undefined,
    unstagedShortstat: unstagedShortstat || undefined,
    stagedFiles: splitGitLines(stagedFiles).map(formatNameStatusLine),
    unstagedFiles: splitGitLines(unstagedFiles).map(formatNameStatusLine),
    untrackedFiles: splitGitLines(statusShort)
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
  };
}

export function formatTuiGitDiffSummary(summary: TuiGitDiffSummary) {
  const hasChanges =
    Boolean(summary.stagedShortstat || summary.unstagedShortstat) ||
    summary.stagedFiles.length > 0 ||
    summary.unstagedFiles.length > 0 ||
    summary.untrackedFiles.length > 0;
  if (!hasChanges) {
    return [
      "Git diff summary:",
      `Root: ${summary.root}`,
      summary.branch ? `Branch: ${summary.branch}` : undefined,
      "",
      "No staged, unstaged, or untracked changes."
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  return [
    "Git diff summary:",
    `Root: ${summary.root}`,
    summary.branch ? `Branch: ${summary.branch}` : undefined,
    "",
    formatDiffSection("Staged", summary.stagedShortstat, summary.stagedFiles),
    "",
    formatDiffSection("Unstaged", summary.unstagedShortstat, summary.unstagedFiles),
    "",
    formatDiffSection("Untracked", undefined, summary.untrackedFiles)
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function formatTuiSessionList(sessions: AgentSession[], limit = DEFAULT_TUI_SESSION_LIST_LIMIT, filters?: SessionListFilters) {
  const filterDescription = describeSessionListFilters(filters);
  const visible = filterSessions(sessions, filters).slice(0, clampSessionLimit(limit));
  if (visible.length === 0) {
    return filterDescription ? `No saved sessions match filters: ${filterDescription}.` : "No saved sessions.";
  }

  return [
    filterDescription ? "Matching sessions:" : "Recent sessions:",
    filterDescription ? `Filters: ${filterDescription}` : undefined,
    "",
    ...visible.map((session) =>
      [session.id, formatSessionUpdatedAt(session.updatedAt), sessionWorkspaceName(session), sessionDisplayTitle(session)].join("  ")
    ),
    "",
    "Resume with /resume <session-id>."
  ].join("\n");
}

export function formatTuiSessionPickerItems(sessions: AgentSession[]) {
  return sessions.map((session, index) =>
    [
      `${index + 1}.`,
      escapeBlessedTags(session.id),
      escapeBlessedTags(formatSessionUpdatedAt(session.updatedAt)),
      escapeBlessedTags(sessionWorkspaceName(session)),
      session.pinnedAt ? "{yellow-fg}pinned{/yellow-fg}" : "{gray-fg}unpinned{/gray-fg}",
      escapeBlessedTags(sessionDisplayTitle(session))
    ].join("  ")
  );
}

function parseSessionsCommand(args: string[]): TuiSlashCommand {
  if (args.length === 0) {
    return { kind: "sessions", limit: DEFAULT_TUI_SESSION_LIST_LIMIT };
  }

  let index = 0;
  let limit = DEFAULT_TUI_SESSION_LIST_LIMIT;
  if (!args[0]?.startsWith("--")) {
    limit = Number.parseInt(args[0] ?? "", 10);
    if (!Number.isFinite(limit) || limit < 1) {
      return {
        kind: "error",
        message:
          "Usage: /sessions [positive-limit] [--pick] [--search text] [--workspace text] [--pinned|--unpinned] [--project|--standalone]"
      };
    }
    index = 1;
  }

  const filters: SessionListFilters = {};
  let pick = false;
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--pick" || flag === "--interactive") {
      pick = true;
      index += 1;
      continue;
    }
    if (flag === "--search") {
      const result = readFlagValue(args, index + 1);
      if (!result.value) {
        return sessionUsageError();
      }
      filters.search = result.value;
      index = result.nextIndex;
      continue;
    }
    if (flag === "--workspace") {
      const result = readFlagValue(args, index + 1);
      if (!result.value) {
        return sessionUsageError();
      }
      filters.workspace = result.value;
      index = result.nextIndex;
      continue;
    }
    if (flag === "--pinned") {
      if (filters.pinned === "unpinned") {
        return sessionUsageError("Use only one of --pinned or --unpinned.");
      }
      filters.pinned = "pinned";
      index += 1;
      continue;
    }
    if (flag === "--unpinned") {
      if (filters.pinned === "pinned") {
        return sessionUsageError("Use only one of --pinned or --unpinned.");
      }
      filters.pinned = "unpinned";
      index += 1;
      continue;
    }
    if (flag === "--project") {
      if (filters.project === "standalone") {
        return sessionUsageError("Use only one of --project or --standalone.");
      }
      filters.project = "project";
      index += 1;
      continue;
    }
    if (flag === "--standalone") {
      if (filters.project === "project") {
        return sessionUsageError("Use only one of --project or --standalone.");
      }
      filters.project = "standalone";
      index += 1;
      continue;
    }
    return sessionUsageError();
  }

  const hasFilters = Boolean(filters.search || filters.workspace || filters.pinned || filters.project);
  return { kind: "sessions", limit: clampSessionLimit(limit), ...(hasFilters ? { filters } : {}), ...(pick ? { pick } : {}) };
}

function readFlagValue(args: string[], startIndex: number) {
  const parts: string[] = [];
  let index = startIndex;
  while (index < args.length && !args[index]?.startsWith("--")) {
    parts.push(args[index] ?? "");
    index += 1;
  }
  return { value: parts.join(" ").trim(), nextIndex: index };
}

function sessionUsageError(message?: string): TuiSlashCommand {
  return {
    kind: "error",
    message:
      message ??
      "Usage: /sessions [positive-limit] [--pick] [--search text] [--workspace text] [--pinned|--unpinned] [--project|--standalone]"
  };
}

async function gitOutput(root: string, args: string[]) {
  const result = await execa("git", ["-C", root, ...args]);
  return result.stdout.trim();
}

function splitGitLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatNameStatusLine(line: string) {
  const [status = "", ...paths] = line.split("\t");
  return `${status.padEnd(3)} ${paths.join(" -> ")}`.trimEnd();
}

function formatDiffSection(title: string, shortstat: string | undefined, files: string[]) {
  if (!shortstat && files.length === 0) {
    return `${title}:\n  none`;
  }
  return [`${title}:`, shortstat ? `  ${shortstat}` : undefined, ...files.map((file) => `  ${file}`)]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function clampSessionLimit(value: number) {
  return Math.min(Math.max(Math.floor(value), 1), MAX_TUI_SESSION_LIST_LIMIT);
}

function formatSessionUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function configForSession(config: AppConfig, session?: AgentSession): AppConfig {
  if (!session) {
    return config;
  }
  return {
    ...config,
    model: session.model ?? config.model,
    baseUrl: session.baseUrl ?? config.baseUrl,
    trustMode: session.trustMode
  };
}

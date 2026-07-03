import path from "node:path";
import blessed from "blessed";
import { execa } from "execa";
import { Agent } from "../agent/Agent.js";
import { chatContentToText } from "../agent/content.js";
import { OpenAICompatibleChatClient } from "../agent/OpenAICompatibleChatClient.js";
import type { AgentRunEvent, AgentSession, ChatMessage } from "../agent/types.js";
import { workspacePolicyOverridesForRoot, type AppConfig } from "../config.js";
import { ApprovalManager } from "../permissions/ApprovalManager.js";
import { SessionStore } from "../sessions/SessionStore.js";
import { detectWorkspace, type WorkspaceInfo } from "../workspace.js";

type TuiAppOptions = {
  config: AppConfig;
  cwd: string;
  session?: AgentSession;
};

type LogLine = {
  kind: "user" | "assistant" | "system" | "error";
  text: string;
  time: Date;
};

type ActivityLine = {
  kind: "call" | "result" | "system" | "error";
  title: string;
  detail?: string;
  time: Date;
};

type FocusTarget = "input" | "conversation" | "activity";
export type TuiSlashCommand =
  | { kind: "clear" | "diff" | "exit" | "help" | "status" }
  | { kind: "sessions"; limit: number }
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

const SPINNER = ["-", "\\", "|", "/"];
const DEFAULT_TUI_SESSION_LIST_LIMIT = 10;
const MAX_TUI_SESSION_LIST_LIMIT = 50;

export class TuiApp {
  private screen!: blessed.Widgets.Screen;
  private header!: blessed.Widgets.BoxElement;
  private conversation!: blessed.Widgets.BoxElement;
  private activity!: blessed.Widgets.BoxElement;
  private input!: blessed.Widgets.TextboxElement;
  private commandBar!: blessed.Widgets.BoxElement;
  private agent!: Agent;
  private workspace!: WorkspaceInfo;
  private config!: AppConfig;
  private cwd!: string;
  private currentSession?: AgentSession;
  private readonly store = new SessionStore();
  private readonly log: LogLine[] = [];
  private readonly activityLog: ActivityLine[] = [];
  private busy = false;
  private status = "Ready";
  private focusTarget: FocusTarget = "input";
  private spinnerFrame = 0;
  private spinner?: NodeJS.Timeout;
  private lastMessageCount = 0;
  private streamingAssistantIndex: number | undefined;
  private liveActivity = false;
  private readonly streamingToolRows = new Map<string, number>();

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
      dockBorders: true
    });

    this.header = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 4,
      tags: true,
      padding: { left: 1, right: 1 },
      border: "line",
      style: {
        fg: "white",
        bg: "black",
        border: { fg: "cyan" }
      }
    });

    this.conversation = blessed.box({
      top: 4,
      left: 0,
      width: "68%",
      bottom: 6,
      label: " conversation ",
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
        style: { bg: "cyan" }
      },
      style: {
        fg: "white",
        bg: "black",
        border: { fg: "cyan" },
        focus: { border: { fg: "green" } }
      }
    });

    this.activity = blessed.box({
      top: 4,
      right: 0,
      width: "32%",
      bottom: 6,
      label: " activity ",
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
        style: { bg: "yellow" }
      },
      style: {
        fg: "white",
        bg: "black",
        border: { fg: "gray" },
        focus: { border: { fg: "green" } }
      }
    });

    this.input = blessed.textbox({
      bottom: 1,
      left: 0,
      width: "100%",
      height: 5,
      label: " prompt ",
      border: "line",
      inputOnFocus: true,
      keys: true,
      mouse: true,
      padding: { left: 1, right: 1 },
      style: {
        fg: "white",
        bg: "black",
        border: { fg: "green" },
        focus: { border: { fg: "green" } }
      }
    });

    this.commandBar = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      style: {
        fg: "gray",
        bg: "black"
      }
    });

    this.screen.append(this.header);
    this.screen.append(this.conversation);
    this.screen.append(this.activity);
    this.screen.append(this.input);
    this.screen.append(this.commandBar);

    this.screen.key(["C-c"], () => this.exit());
    this.screen.key(["escape"], () => {
      if (!this.busy) {
        this.exit();
      }
    });
    this.screen.key(["tab"], () => this.focusNext());
    this.screen.key(["S-tab"], () => this.focusPrevious());
    this.screen.key(["C-l"], () => this.clearConversation());
    this.screen.key(["C-r"], () => this.render());

    this.input.key(["C-c"], () => this.exit());
    this.input.on("submit", (value) => void this.submit(String(value ?? "")));
    this.screen.on("resize", () => {
      this.applyResponsiveLayout();
      this.render();
    });

    this.applyResponsiveLayout();
    this.focusInput();
  }

  private createAgent(session?: AgentSession) {
    return new Agent({
      client: new OpenAICompatibleChatClient(this.config),
      approvals: new ApprovalManager(
        this.config.trustMode,
        (message) => this.confirm(message),
        workspacePolicyOverridesForRoot(this.config, this.workspace.root)
      ),
      cwd: this.cwd,
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      tavilyApiKey: this.config.tavilyApiKey,
      mcpServers: this.config.mcpServers,
      session
    });
  }

  private seedFromSession(session?: AgentSession) {
    const messages = session?.messages ?? [];
    for (const message of messages) {
      if (message.role === "user") {
        this.log.push({ kind: "user", text: chatContentToText(message.content), time: new Date() });
      }
      if (message.role === "assistant" && chatContentToText(message.content).trim()) {
        this.log.push({ kind: "assistant", text: chatContentToText(message.content), time: new Date() });
      }
      if (message.role === "tool") {
        this.activityLog.push({
          kind: "result",
          title: message.name ?? "tool",
          detail: chatContentToText(message.content),
          time: new Date()
        });
      }
    }

    if (this.log.length === 0) {
      this.log.push({
        kind: "system",
        text: [
          "Welcome to Arivu.",
          "Ask a coding task, or type /help for commands."
        ].join("\n"),
        time: new Date()
      });
    }

    this.activityLog.push({
      kind: "system",
      title: "workspace",
      detail: `${this.workspace.root}\n${this.workspace.dirty ? "git: dirty" : "git: clean"}`,
      time: new Date()
    });
  }

  private async submit(rawValue: string) {
    const value = rawValue.trim();
    this.input.clearValue();
    this.input.focus();

    if (!value || this.busy) {
      this.render();
      return;
    }

    if (await this.handleSlashCommand(value)) {
      this.render();
      return;
    }

    this.busy = true;
    this.streamingAssistantIndex = undefined;
    this.liveActivity = false;
    this.streamingToolRows.clear();
    this.startSpinner();
    this.log.push({ kind: "user", text: value, time: new Date() });
    this.setStatus("Running agent");
    this.render();

    try {
      const before = this.lastMessageCount;
      const result = await this.agent.run(value, {
        onEvent: (event) => this.handleAgentEvent(event)
      });
      await this.store.save(result.session);
      this.currentSession = result.session;
      this.cwd = result.session.cwd;
      if (!this.liveActivity) {
        this.appendActivity(result.session.messages.slice(before));
      }
      this.lastMessageCount = result.session.messages.length;
      if (this.streamingAssistantIndex === undefined) {
        this.log.push({ kind: "assistant", text: result.output || "(no response)", time: new Date() });
      } else if (!this.log[this.streamingAssistantIndex]?.text.trim() && result.output) {
        this.log[this.streamingAssistantIndex].text = result.output;
      }
      this.setStatus(`Saved session ${result.session.id}`);
    } catch (error) {
      this.log.push({ kind: "error", text: error instanceof Error ? error.message : String(error), time: new Date() });
      this.activityLog.push({
        kind: "error",
        title: "agent error",
        detail: error instanceof Error ? error.message : String(error),
        time: new Date()
      });
      this.setStatus("Error");
    } finally {
      this.busy = false;
      this.stopSpinner();
      this.focusInput();
      this.render();
    }
  }

  private async handleSlashCommand(value: string): Promise<boolean> {
    const command = parseTuiSlashCommand(value);
    if (!command || command.kind === "unknown") {
      return false;
    }

    if (command.kind === "exit") {
      this.exit();
      return true;
    }

    if (command.kind === "help") {
      this.showHelp();
      return true;
    }

    if (command.kind === "clear") {
      this.clearConversation();
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

    if (command.kind === "sessions") {
      await this.showSessions(command.limit);
      return true;
    }

    if (command.kind === "resume") {
      await this.resumeSession(command.sessionId);
      return true;
    }

    if (command.kind === "error") {
      this.log.push({ kind: "error", text: command.message, time: new Date() });
      this.setStatus("Command error");
    }
    return true;
  }

  private appendActivity(messages: ChatMessage[]) {
    for (const message of messages) {
      if (message.role === "assistant" && message.toolCalls?.length) {
        for (const call of message.toolCalls) {
          this.activityLog.push({
            kind: "call",
            title: call.name,
            detail: prettyJson(call.arguments),
            time: new Date()
          });
        }
      }
      if (message.role === "tool") {
        this.activityLog.push({
          kind: "result",
          title: message.name ?? "tool",
          detail: chatContentToText(message.content),
          time: new Date()
        });
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

    this.liveActivity = true;
    this.streamingAssistantIndex = undefined;
    this.activityLog.push({
      kind: "result",
      title: event.name,
      detail: event.result,
      time: new Date()
    });
    this.render();
  }

  private ensureStreamingAssistant() {
    if (this.streamingAssistantIndex !== undefined && this.log[this.streamingAssistantIndex]?.kind === "assistant") {
      return this.streamingAssistantIndex;
    }

    this.log.push({ kind: "assistant", text: "", time: new Date() });
    this.streamingAssistantIndex = this.log.length - 1;
    return this.streamingAssistantIndex;
  }

  private ensureStreamingToolRow(key: string, title: string) {
    const existing = this.streamingToolRows.get(key);
    if (existing !== undefined) {
      return existing;
    }

    this.activityLog.push({
      kind: "call",
      title,
      detail: "(waiting for arguments)",
      time: new Date()
    });
    const index = this.activityLog.length - 1;
    this.streamingToolRows.set(key, index);
    return index;
  }

  private showHelp() {
    this.log.push({
      kind: "system",
      text: [
        "Commands:",
        "/help          Show this help",
        "/clear         Clear the visible conversation",
        "/status        Show workspace and model status",
        "/diff          Show staged, unstaged, and untracked git changes",
        "/sessions [n]  List recent saved sessions",
        "/resume <id>   Resume a saved session in this TUI",
        "/exit          Quit",
        "",
        "Keys:",
        "Tab / Shift-Tab changes focus",
        "Ctrl-L clears the visible conversation",
        "Ctrl-C exits"
      ].join("\n"),
      time: new Date()
    });
    this.setStatus("Help");
  }

  private showStatus() {
    this.log.push({
      kind: "system",
      text: [
        `Session: ${this.currentSession?.id ?? "new"}`,
        `Workspace: ${this.workspace.root}`,
        `Project: ${this.workspace.packageName ?? path.basename(this.workspace.root)}`,
        `Git: ${this.workspace.gitBranch ?? "no branch"} / ${this.workspace.dirty ? "dirty" : "clean"}`,
        `Model: ${this.config.model}`,
        `Base URL: ${this.config.baseUrl}`,
        `Trust: ${this.config.trustMode}`
      ].join("\n"),
      time: new Date()
    });
    this.setStatus("Status");
  }

  private async showGitDiff() {
    try {
      const summary = await loadTuiGitDiffSummary(this.workspace.root);
      this.log.push({
        kind: "system",
        text: formatTuiGitDiffSummary(summary),
        time: new Date()
      });
      this.setStatus("Diff");
    } catch (error) {
      this.log.push({
        kind: "error",
        text: `Unable to summarize git diff: ${error instanceof Error ? error.message : String(error)}`,
        time: new Date()
      });
      this.setStatus("Diff failed");
    }
  }

  private async showSessions(limit: number) {
    try {
      const sessions = await this.store.list();
      this.log.push({
        kind: "system",
        text: formatTuiSessionList(sessions, limit),
        time: new Date()
      });
      this.setStatus("Sessions");
    } catch (error) {
      this.log.push({
        kind: "error",
        text: `Unable to list sessions: ${error instanceof Error ? error.message : String(error)}`,
        time: new Date()
      });
      this.setStatus("Session list failed");
    }
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
      this.focusInput();
      this.setStatus(`Resumed session ${session.id}`);
    } catch (error) {
      this.log.push({
        kind: "error",
        text: `Unable to resume session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        time: new Date()
      });
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
          truncate(message, 900),
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
        this.activityLog.push({
          kind: approved ? "system" : "error",
          title: approved ? "approval granted" : "approval denied",
          detail: message,
          time: new Date()
        });
        modal.destroy();
        this.focusInput();
        this.render();
        resolve(approved);
      };

      modal.key(["y", "Y"], () => finish(true));
      modal.key(["n", "N", "escape"], () => finish(false));
      this.screen.append(modal);
      modal.focus();
      this.screen.render();
    });
  }

  private render() {
    this.header.setContent(this.formatHeader());
    this.conversation.setContent(this.formatConversation());
    this.activity.setContent(this.formatActivity());
    this.commandBar.setContent(this.formatCommandBar());
    this.conversation.setScrollPerc(100);
    this.activity.setScrollPerc(100);
    this.screen.render();
  }

  private formatHeader() {
    const project = this.workspace.packageName ?? path.basename(this.workspace.root);
    const git = this.workspace.gitBranch ? `${this.workspace.gitBranch}${this.workspace.dirty ? "*" : ""}` : "no-git";
    const state = this.busy ? `${SPINNER[this.spinnerFrame]} ${this.status}` : this.status;
    return [
      `{bold}{cyan-fg}Arivu{/cyan-fg}{/bold}  ${project}`,
      `{gray-fg}${shortenPath(this.workspace.root, 70)}{/gray-fg}`,
      `model {green-fg}${this.options.config.model}{/green-fg}  trust {yellow-fg}${this.options.config.trustMode}{/yellow-fg}  git {magenta-fg}${git}{/magenta-fg}  status {white-fg}${state}{/white-fg}`
    ].join("\n");
  }

  private formatConversation() {
    return this.log
      .slice(-80)
      .map((line) => {
        const meta = `{gray-fg}${formatTime(line.time)}{/gray-fg}`;
        if (line.kind === "user") {
          return `{green-fg}YOU{/green-fg} ${meta}\n${indent(line.text)}`;
        }
        if (line.kind === "assistant") {
          return `{cyan-fg}AGENT{/cyan-fg} ${meta}\n${indent(line.text)}`;
        }
        if (line.kind === "error") {
          return `{red-fg}ERROR{/red-fg} ${meta}\n${indent(line.text)}`;
        }
        return `{gray-fg}SYSTEM{/gray-fg} ${meta}\n${indent(line.text)}`;
      })
      .join("\n\n{gray-fg}" + "-".repeat(48) + "{/gray-fg}\n\n");
  }

  private formatActivity() {
    if (this.activityLog.length === 0) {
      return "{gray-fg}No tool activity yet.{/gray-fg}";
    }

    return this.activityLog
      .slice(-80)
      .map((line) => {
        const color =
          line.kind === "call" ? "yellow" : line.kind === "result" ? "green" : line.kind === "error" ? "red" : "gray";
        const detail = line.detail ? `\n{gray-fg}${truncate(line.detail, 900)}{/gray-fg}` : "";
        return `{${color}-fg}${line.kind.toUpperCase()}{/${color}-fg} {bold}${line.title}{/bold} {gray-fg}${formatTime(line.time)}{/gray-fg}${detail}`;
      })
      .join("\n\n");
  }

  private formatCommandBar() {
    const focus = this.focusTarget === "input" ? "prompt" : this.focusTarget;
    return [
      ` ${this.busy ? "Running" : "Ready"}`,
      `focus: ${focus}`,
      "Enter Submit",
      "Up/Down Scroll",
      "Tab Cycle Focus",
      "Ctrl-L Clear",
      "Esc Close",
      "Ctrl-C Exit"
    ].join("  |  ");
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
    }, 140);
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
    } else if (this.focusTarget === "conversation") {
      this.focusActivity();
    } else {
      this.focusInput();
    }
    this.render();
  }

  private focusPrevious() {
    if (this.focusTarget === "input") {
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

  private focusConversation() {
    this.focusTarget = "conversation";
    this.conversation.focus();
  }

  private focusActivity() {
    this.focusTarget = "activity";
    this.activity.focus();
  }

  private clearConversation() {
    this.log.splice(0, this.log.length, {
      kind: "system",
      text: "Visible conversation cleared. Session history is still preserved.",
      time: new Date()
    });
    this.setStatus("Cleared");
  }

  private applyResponsiveLayout() {
    const width = Number(this.screen.width);
    if (width < 100) {
      this.conversation.width = "100%";
      this.activity.hide();
    } else {
      this.conversation.width = "68%";
      this.activity.show();
    }
  }

  private exit() {
    this.stopSpinner();
    this.screen.destroy();
  }
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

function formatTime(date: Date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function indent(value: string) {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
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
    case "/clear":
      return { kind: "clear" };
    case "/status":
      return { kind: "status" };
    case "/diff":
      return { kind: "diff" };
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

export function formatTuiSessionList(sessions: AgentSession[], limit = DEFAULT_TUI_SESSION_LIST_LIMIT) {
  const visible = sessions.slice(0, clampSessionLimit(limit));
  if (visible.length === 0) {
    return "No saved sessions.";
  }

  return [
    "Recent sessions:",
    "",
    ...visible.map((session) =>
      [
        session.id,
        formatSessionUpdatedAt(session.updatedAt),
        path.basename(session.projectRoot ?? session.cwd),
        tuiSessionTitle(session)
      ].join("  ")
    ),
    "",
    "Resume with /resume <session-id>."
  ].join("\n");
}

function parseSessionsCommand(args: string[]): TuiSlashCommand {
  if (args.length === 0) {
    return { kind: "sessions", limit: DEFAULT_TUI_SESSION_LIST_LIMIT };
  }

  const limit = Number.parseInt(args[0] ?? "", 10);
  if (!Number.isFinite(limit) || limit < 1) {
    return { kind: "error", message: "Usage: /sessions [positive-limit]" };
  }

  return { kind: "sessions", limit: clampSessionLimit(limit) };
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
  return [
    `${title}:`,
    shortstat ? `  ${shortstat}` : undefined,
    ...files.map((file) => `  ${file}`)
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function clampSessionLimit(value: number) {
  return Math.min(Math.max(Math.floor(value), 1), MAX_TUI_SESSION_LIST_LIMIT);
}

function tuiSessionTitle(session: AgentSession) {
  const content = session.messages.find((message) => message.role === "user")?.content;
  const title = content ? chatContentToText(content).trim().split(/\s+/).slice(0, 10).join(" ") : "";
  return title || "Untitled session";
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

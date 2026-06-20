import path from "node:path";
import blessed from "blessed";
import { Agent } from "../agent/Agent.js";
import { chatContentToText } from "../agent/content.js";
import { OpenAICompatibleChatClient } from "../agent/OpenAICompatibleChatClient.js";
import type { AgentRunEvent, AgentSession, ChatMessage } from "../agent/types.js";
import type { AppConfig } from "../config.js";
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

const SPINNER = ["-", "\\", "|", "/"];

export class TuiApp {
  private screen!: blessed.Widgets.Screen;
  private header!: blessed.Widgets.BoxElement;
  private conversation!: blessed.Widgets.BoxElement;
  private activity!: blessed.Widgets.BoxElement;
  private input!: blessed.Widgets.TextboxElement;
  private commandBar!: blessed.Widgets.BoxElement;
  private agent!: Agent;
  private workspace!: WorkspaceInfo;
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

    this.workspace = await detectWorkspace(this.options.cwd);
    this.lastMessageCount = this.options.session?.messages.length ?? 0;
    this.agent = new Agent({
      client: new OpenAICompatibleChatClient(this.options.config),
      approvals: new ApprovalManager(this.options.config.trustMode, (message) => this.confirm(message)),
      cwd: this.options.cwd,
      model: this.options.config.model,
      baseUrl: this.options.config.baseUrl,
      tavilyApiKey: this.options.config.tavilyApiKey,
      mcpServers: this.options.config.mcpServers,
      session: this.options.session
    });

    this.createScreen();
    this.seedFromSession();
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

  private seedFromSession() {
    const messages = this.options.session?.messages ?? [];
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

    if (this.handleSlashCommand(value)) {
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

  private handleSlashCommand(value: string): boolean {
    if (value === "/exit" || value === "/quit") {
      this.exit();
      return true;
    }

    if (value === "/help") {
      this.log.push({
        kind: "system",
        text: [
          "Commands:",
          "/help    Show this help",
          "/clear   Clear the visible conversation",
          "/status  Show workspace and model status",
          "/exit    Quit",
          "",
          "Keys:",
          "Tab / Shift-Tab changes focus",
          "Ctrl-L clears the visible conversation",
          "Ctrl-C exits"
        ].join("\n"),
        time: new Date()
      });
      this.setStatus("Help");
      return true;
    }

    if (value === "/clear") {
      this.clearConversation();
      return true;
    }

    if (value === "/status") {
      this.log.push({
        kind: "system",
        text: [
          `Workspace: ${this.workspace.root}`,
          `Project: ${this.workspace.packageName ?? path.basename(this.workspace.root)}`,
          `Git: ${this.workspace.gitBranch ?? "no branch"} / ${this.workspace.dirty ? "dirty" : "clean"}`,
          `Model: ${this.options.config.model}`,
          `Base URL: ${this.options.config.baseUrl}`,
          `Trust: ${this.options.config.trustMode}`
        ].join("\n"),
        time: new Date()
      });
      this.setStatus("Status");
      return true;
    }

    return false;
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

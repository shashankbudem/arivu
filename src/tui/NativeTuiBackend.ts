import { randomUUID } from "node:crypto";
import path from "node:path";
import { Agent } from "../agent/Agent.js";
import { BrowserUseCliController } from "../browser/browserUseCliController.js";
import { chatContentToText } from "../agent/content.js";
import {
  COMPACT_RECENT_MESSAGE_COUNT,
  applyContextCompactionCheckpoint,
  compactSessionMessages,
  contextMessagesForSession
} from "../agent/contextCompaction.js";
import { OpenAICompatibleChatClient } from "../agent/OpenAICompatibleChatClient.js";
import { AgentRunAbortedError, type AgentRunEvent, type AgentSession, type ApprovalPromptRequest, type ChatUsage } from "../agent/types.js";
import {
  normalizeCapabilityBaseUrl,
  resolveModelListEndpoint,
  resolveWebSearchProvider,
  workspacePolicyOverridesForRoot,
  workspaceScopeRulesForRoot,
  type AppConfig
} from "../config.js";
import { ModelCatalogStore } from "../models/ModelCatalogStore.js";
import { resolveContextWindowTokens } from "../models/contextResolver.js";
import { emptyCatalog, type ModelCatalog } from "../models/modelCatalogSchema.js";
import { recordContextFromRuntime } from "../models/syncModelCatalog.js";
import { ApprovalManager } from "../permissions/ApprovalManager.js";
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
  clampSessionLimit,
  formatSessionUpdatedAt,
  formatTuiGitDiffSummary,
  formatTuiSessionList,
  loadTuiGitDiffSummary,
  parseTuiSlashCommand,
  type TuiSlashCommand
} from "./commands.js";
import { NATIVE_TUI_COMMANDS, NATIVE_TUI_HELP } from "./nativeCommands.js";
import { NativeTuiProcess } from "./nativeLauncher.js";
import type { NativeActivityItem, NativeClientEvent, NativeInitData, NativeServerEvent } from "./nativeProtocol.js";
import {
  formatShellCommandDisplay,
  parseShellEscape,
  runShellCommand,
  sanitizeTerminalText,
  TerminalTextSanitizer,
  type ShellCommandRunner
} from "./shellEscape.js";
import {
  activityForSession,
  formatActivityDetail,
  inferToolResultPhase,
  prettyJson,
  transcriptForSession,
  truncateNativeActivityDetail
} from "./nativeSessionPresentation.js";

export type NativeTuiBackendOptions = {
  config: AppConfig;
  cwd: string;
  session?: AgentSession;
};

type RunUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
};

type ModelOperation = {
  generation: number;
  kind: "picker" | "switch";
  controller: AbortController;
  snapshot: { model: string; baseUrl: string; sessionId?: string };
};

type QueuedInput = { kind: "prompt"; value: string } | { kind: "shell"; command: string };

export class NativeTuiBackend {
  private config!: AppConfig;
  private cwd!: string;
  private workspace!: WorkspaceInfo;
  private currentSession?: AgentSession;
  private agent!: Agent;
  private transport?: NativeTuiProcess;
  private readonly store = new SessionStore();
  private readonly catalogStore = new ModelCatalogStore();
  private modelCatalog: ModelCatalog = emptyCatalog();
  private lastRunUsage?: RunUsage;
  private currentContextTokens?: number;
  private busy = false;
  private closing = false;
  private runAbortController?: AbortController;
  private readonly promptQueue: QueuedInput[] = [];
  private readonly approvalResolvers = new Map<string, (approved: boolean) => void>();
  private readonly activityInputs = new Map<string, string>();
  private activeBrowserToolId?: string;
  private queuedDispatchGeneration = 0;
  private pendingQueuedInput?: QueuedInput;
  private modelOperationGeneration = 0;
  private modelOperation?: ModelOperation;
  private browserController?: BrowserUseCliController;
  private browserSessionKey = `tui-${randomUUID()}`;
  private shellCommandRunner: ShellCommandRunner = runShellCommand;

  constructor(private readonly options: NativeTuiBackendOptions) {}

  async run() {
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      throw new Error("The Arivu TUI requires an interactive terminal. Use one-shot mode for non-TTY usage.");
    }

    this.currentSession = this.options.session;
    if (this.currentSession) {
      this.resetBrowserController(this.currentSession.id);
    }
    this.config = configForSession(this.options.config, this.currentSession);
    this.cwd = this.currentSession?.cwd ?? this.options.cwd;
    this.workspace = await detectWorkspace(this.cwd);
    this.modelCatalog = await this.catalogStore.load();
    this.agent = this.createAgent(this.currentSession);

    this.transport = new NativeTuiProcess({
      cwd: this.cwd,
      onMessage: (event) => this.handleNativeEvent(event),
      onDisconnect: () => this.handleNativeDisconnect()
    });

    try {
      await this.transport.start();
      this.send({ type: "init", data: this.buildInitData() });
      await this.transport.wait();
    } finally {
      this.closing = true;
      this.stopRun();
      this.resolveAllApprovals(false);
      this.transport.close();
    }
  }

  private createAgent(session?: AgentSession) {
    const scopePolicyRules = workspaceScopeRulesForRoot(this.config, this.workspace.root);
    return new Agent({
      client: new OpenAICompatibleChatClient(this.config),
      approvals: new ApprovalManager(
        this.config.trustMode,
        (message, request) => this.confirm(message, request),
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
      browser: this.browserControllerForSession(),
      manualBrowserTools: true,
      customInstructions: this.config.customSystemPrompt,
      minStepIntervalMs: this.config.chatModelRequestDelayMs,
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

  private browserControllerForSession() {
    if (!this.browserController) {
      this.browserController = new BrowserUseCliController({ sessionId: this.browserSessionKey });
    }
    return this.browserController;
  }

  private resetBrowserController(sessionId?: string) {
    this.browserSessionKey = sessionId ?? `tui-${randomUUID()}`;
    this.browserController = undefined;
  }

  private async handleNativeEvent(event: Exclude<NativeClientEvent, { type: "hello" }>) {
    switch (event.type) {
      case "submit":
        await this.submit(event.value);
        break;
      case "stop":
        this.cancelModelOperation();
        this.stopRun();
        break;
      case "quit":
        this.exit();
        break;
      case "approval_response":
        this.approvalResolvers.get(event.id)?.(event.approved);
        this.approvalResolvers.delete(event.id);
        break;
      case "resume_session":
        if (this.busy) {
          this.setStatus("Stop the active turn before switching sessions");
        } else {
          this.cancelModelOperation();
          await this.resumeSession(event.id);
        }
        break;
      case "select_model":
        if (this.busy) {
          this.setStatus("Stop the active turn before switching models", true);
        } else {
          this.requestModelSwitch(event.id);
        }
        break;
    }
  }

  private handleNativeDisconnect() {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.cancelModelOperation();
    this.stopRun();
    this.resolveAllApprovals(false);
  }

  private async submit(rawValue: string) {
    const value = rawValue.trim();
    if (!value || this.closing) {
      return;
    }

    if (await this.handleSlashCommand(value)) {
      return;
    }

    const shellEscape = parseShellEscape(value);
    if (shellEscape) {
      if (!shellEscape.command) {
        this.commitError("Usage: ! <command>");
        this.setStatus("Command error");
        return;
      }
      if (this.isModelSwitching()) {
        this.setStatus("Model switch in progress — wait before running a command");
        return;
      }
      // A shell escape is intentionally isolated from model/session state, but
      // it still owns the foreground run slot and therefore follows the same
      // FIFO behavior as a prompt sent while a turn is active.
      this.cancelModelOperation();
      const input: QueuedInput = { kind: "shell", command: shellEscape.command };
      if (this.busy) {
        this.queueInput(input);
      } else {
        this.runInBackground(this.runQueuedInput(input), "Unable to run command");
      }
      return;
    }

    if (this.isModelSwitching()) {
      this.setStatus("Model switch in progress — wait before sending a prompt");
      return;
    }
    // A normal prompt changes the active state. Do not let a late /models response
    // surface a picker over a turn that has already started.
    this.cancelModelOperation();

    const input: QueuedInput = { kind: "prompt", value };
    if (this.busy) {
      this.queueInput(input);
    } else {
      this.runInBackground(this.runQueuedInput(input), "Unable to run prompt");
    }
  }

  private queueInput(input: QueuedInput) {
    this.promptQueue.push(input);
    this.send({
      type: "status",
      message: `${this.promptQueue.length} item${this.promptQueue.length === 1 ? "" : "s"} queued`,
      busy: true,
      queue_len: this.promptQueue.length
    });
  }

  private async runQueuedInput(input: QueuedInput) {
    if (this.closing) {
      return;
    }
    if (input.kind === "shell") {
      await this.runShellEscape(input.command);
      return;
    }
    await this.runPrompt(input.value);
  }

  private async runPrompt(value: string) {
    this.send({ type: "commit", entry: { kind: "user", text: value, time: new Date().toISOString() } });
    await this.executeAgentTurn((signal) =>
      this.agent.run(value, {
        onEvent: (event) => this.handleAgentEvent(event),
        onUsage: (usage) => this.recordRunUsage(usage),
        signal
      })
    );
  }

  private async runShellEscape(command: string) {
    this.busy = true;
    const controller = new AbortController();
    this.runAbortController = controller;
    this.lastRunUsage = undefined;
    this.activeBrowserToolId = undefined;
    this.activityInputs.clear();
    const displayCommand = formatShellCommandDisplay(command);
    const liveOutputSanitizers = {
      stdout: new TerminalTextSanitizer(),
      stderr: new TerminalTextSanitizer()
    };
    this.send({ type: "shell_started", command: displayCommand });

    try {
      const result = await this.shellCommandRunner(command, {
        cwd: this.cwd,
        signal: controller.signal,
        onOutput: ({ stream, delta }) => {
          const safeDelta = liveOutputSanitizers[stream].write(delta);
          if (!this.closing && this.runAbortController === controller) {
            if (safeDelta) {
              this.send({ type: "shell_output", stream, delta: safeDelta });
            }
          }
        }
      });
      if (!this.closing && this.runAbortController === controller) {
        this.send({
          type: "shell_completed",
          command: displayCommand,
          output: sanitizeTerminalText(result.output),
          exit_code: result.exitCode,
          signal: result.signal,
          elapsed_ms: result.elapsedMs,
          stopped: result.aborted,
          output_truncated: result.outputTruncated
        });
      }
    } catch (error) {
      if (!this.closing && this.runAbortController === controller) {
        if (controller.signal.aborted) {
          this.send({
            type: "shell_completed",
            command: displayCommand,
            output: "",
            elapsed_ms: 0,
            stopped: true
          });
        } else {
          this.send({
            type: "shell_failed",
            command: displayCommand,
            message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
            elapsed_ms: 0
          });
        }
      }
    } finally {
      if (this.runAbortController === controller) {
        this.runAbortController = undefined;
        this.activeBrowserToolId = undefined;
        this.finishForegroundRun();
      }
    }
  }

  private async continueTurn() {
    if (this.busy) {
      return;
    }
    if (!this.currentSession || this.currentSession.messages.length === 0) {
      this.commitSystem("Nothing to continue.");
      this.setStatus("Nothing to continue");
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

  private async executeAgentTurn(runner: (signal: AbortSignal) => Promise<{ output: string; session: AgentSession }>) {
    this.busy = true;
    this.runAbortController = new AbortController();
    this.lastRunUsage = undefined;
    this.activeBrowserToolId = undefined;
    this.activityInputs.clear();
    this.send({ type: "run_started", status: "Working" });

    try {
      const result = await runner(this.runAbortController.signal);
      await this.store.save(result.session);
      this.currentSession = result.session;
      this.cwd = result.session.cwd;
      const usage = this.lastRunUsage as RunUsage | undefined;
      this.send({
        type: "run_completed",
        output: result.output || "(no response)",
        session_id: result.session.id,
        usage: usage
          ? {
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
              total_tokens: usage.totalTokens
            }
          : undefined
      });
    } catch (error) {
      if (error instanceof AgentRunAbortedError || this.runAbortController.signal.aborted) {
        this.send({ type: "run_stopped", message: "Run stopped." });
      } else {
        this.send({ type: "run_failed", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      this.runAbortController = undefined;
      this.activeBrowserToolId = undefined;
      this.finishForegroundRun();
    }
  }

  private finishForegroundRun() {
    if (this.closing) {
      this.busy = false;
      return;
    }
    const next = this.promptQueue.shift();
    // Reserve the foreground slot before deferring dispatch. Otherwise a
    // keystroke arriving in this tiny gap could start a second run alongside
    // the queued command or prompt.
    this.busy = Boolean(next);
    const nextLabel = next?.kind === "shell" ? "command" : "prompt";
    this.send({
      type: "status",
      message: next ? `Starting queued ${nextLabel}` : "Ready",
      busy: Boolean(next),
      queue_len: this.promptQueue.length,
      context_used: this.currentContextTokens
    });
    if (next) {
      const generation = (this.queuedDispatchGeneration += 1);
      this.pendingQueuedInput = next;
      setImmediate(() => {
        if (this.closing || generation !== this.queuedDispatchGeneration || this.pendingQueuedInput !== next) {
          return;
        }
        this.pendingQueuedInput = undefined;
        this.runInBackground(this.runQueuedInput(next), `Unable to run queued ${nextLabel}`);
      });
    }
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

  private handleAgentEvent(event: AgentRunEvent) {
    if (event.type === "assistant_delta") {
      this.send({ type: "assistant_delta", delta: event.delta });
      return;
    }

    if (event.type === "tool_call_delta") {
      this.setStatus(`Preparing ${event.name || `tool ${event.index + 1}`}`, true);
      return;
    }

    if (event.type === "tool_call") {
      const input = prettyJson(event.call.arguments);
      this.activityInputs.set(event.call.id, input);
      if (event.call.name === "browser_task") {
        this.activeBrowserToolId = event.call.id;
      }
      this.sendActivity({
        id: event.call.id,
        phase: "running",
        name: event.call.name,
        detail: formatActivityDetail({ input })
      });
      return;
    }

    if (event.type === "browser_task_progress") {
      const id = this.activeBrowserToolId ?? "browser-task-progress";
      this.sendActivity({
        id,
        phase: "running",
        name: `browser_task · step ${event.stepIndex}`,
        detail: formatActivityDetail({
          input: this.activityInputs.get(id),
          progress: [event.summary, event.evaluation, event.memory].filter(Boolean).join("\n")
        })
      });
      return;
    }

    if (event.type === "empty_response_retry") {
      const minutes = Math.max(1, Math.round(event.delayMs / 60_000));
      this.sendActivity({
        id: "model-empty-response-retry",
        phase: "running",
        name: "Model returned an empty response",
        detail: `Retrying in ${minutes} min · attempt ${event.attempt}/${event.maxAttempts}`
      });
      this.setStatus(`Empty response — retrying in ${minutes} min (${event.attempt}/${event.maxAttempts})`, true);
      return;
    }

    if (event.type === "tool_result") {
      this.sendActivity({
        id: event.toolCallId,
        phase: inferToolResultPhase(event.result),
        name: event.name,
        detail: formatActivityDetail({
          input: this.activityInputs.get(event.toolCallId),
          result: event.result
        })
      });
      if (event.toolCallId === this.activeBrowserToolId) {
        this.activeBrowserToolId = undefined;
      }
    }
  }

  private async handleSlashCommand(value: string) {
    const command = parseTuiSlashCommand(value);
    if (!command || command.kind === "unknown") {
      return false;
    }

    if (this.busy && commandChangesRunState(command)) {
      this.setStatus("Stop the active turn before changing models, sessions, or context", true);
      return true;
    }
    if (this.isModelSwitching() && commandChangesRunState(command)) {
      this.setStatus("Model switch in progress — wait before changing session or context");
      return true;
    }

    switch (command.kind) {
      case "exit":
        this.exit();
        break;
      case "help":
        this.send({ type: "modal", title: "Keyboard & slash commands", body: NATIVE_TUI_HELP });
        break;
      case "activity":
        this.send({ type: "toggle_activity" });
        break;
      case "clear":
        this.send({ type: "clear" });
        this.setStatus("Visible transcript cleared");
        break;
      case "continue":
        this.runInBackground(this.continueTurn(), "Unable to continue session");
        break;
      case "status":
        this.showStatus();
        break;
      case "model":
        if (command.model) {
          this.requestModelSwitch(command.model);
        } else {
          this.requestModelPicker();
        }
        break;
      case "diff":
        await this.showGitDiff();
        break;
      case "compact":
        await this.compactCurrentSession(command.recentMessageCount);
        break;
      case "summarize":
        this.runInBackground(this.summarizeCurrentSession(), "Unable to summarize session");
        break;
      case "sessions":
        if (command.pick) {
          await this.pickSession(command.limit, command.filters);
        } else {
          await this.showSessions(command.limit, command.filters);
        }
        break;
      case "resume":
        await this.resumeSession(command.sessionId);
        break;
      case "error":
        this.commitError(command.message);
        this.setStatus("Command error");
        break;
    }
    return true;
  }

  private showStatus() {
    this.commitSystem(
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
      this.commitSystem(formatTuiGitDiffSummary(await loadTuiGitDiffSummary(this.workspace.root)));
      this.setStatus("Diff");
    } catch (error) {
      this.commitError(`Unable to summarize git diff: ${error instanceof Error ? error.message : String(error)}`);
      this.setStatus("Diff failed");
    }
  }

  private async compactCurrentSession(recentMessageCount = COMPACT_RECENT_MESSAGE_COUNT) {
    this.cancelModelOperation();
    if (!this.currentSession) {
      this.commitSystem("No saved session to compact yet. Send a prompt first, then run /compact.");
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
        this.commitSystem(
          `Session ${this.currentSession.id} is already compact enough. Non-system messages: ${result.remainingMessageCount}; recent window: ${recentMessageCount}.`
        );
        this.setStatus("Already compact");
        return;
      }

      const compactedSession: AgentSession = { ...this.currentSession, updatedAt: now.toISOString() };
      applyContextCompactionCheckpoint(compactedSession, result, "deterministic", now);
      await this.store.save(compactedSession);
      this.currentSession = compactedSession;
      this.agent = this.createAgent(compactedSession);
      this.send({ type: "reset", data: this.buildInitData() });
      this.commitSystem(
        [
          `Compacted session ${compactedSession.id}.`,
          `Compacted messages: ${result.compactedMessageCount}`,
          `Kept recent messages: ${result.remainingMessageCount}`,
          `Working context messages: ${result.messages.length}`,
          `Full transcript messages preserved: ${compactedSession.messages.length}`
        ].join("\n")
      );
      this.setStatus("Compacted");
    } catch (error) {
      this.commitError(`Unable to compact session: ${error instanceof Error ? error.message : String(error)}`);
      this.setStatus("Compaction failed");
    }
  }

  private async summarizeCurrentSession() {
    this.cancelModelOperation();
    if (!this.currentSession) {
      this.commitSystem("No saved session to summarize yet. Send a prompt first, then run /summarize.");
      this.setStatus("No session");
      return;
    }
    if (this.busy) {
      return;
    }

    this.busy = true;
    this.runAbortController = new AbortController();
    this.send({ type: "run_started", status: "Summarizing context" });
    try {
      const agent = this.createAgent(this.currentSession);
      const result = await agent.summarizeContext({ signal: this.runAbortController.signal });
      if (!result.compacted) {
        this.send({ type: "run_completed", output: "Session is already compact enough to skip summarizing." });
        return;
      }
      const now = new Date();
      const summarizedSession: AgentSession = { ...result.session, updatedAt: now.toISOString() };
      await this.store.save(summarizedSession);
      this.currentSession = summarizedSession;
      this.agent = this.createAgent(summarizedSession);
      this.send({ type: "reset", data: this.buildInitData() });
      this.commitSystem(
        [
          `Summarized session ${summarizedSession.id} (${result.source}).`,
          `Summarized messages: ${result.compactedMessageCount}`,
          `Working context messages: ${result.remainingMessageCount}`,
          `Full transcript messages preserved: ${summarizedSession.messages.length}`
        ].join("\n")
      );
      this.setStatus("Summarized");
    } catch (error) {
      if (error instanceof AgentRunAbortedError || this.runAbortController.signal.aborted) {
        this.send({ type: "run_stopped", message: "Summary stopped." });
      } else {
        this.send({
          type: "run_failed",
          message: `Unable to summarize session: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    } finally {
      this.busy = false;
      this.runAbortController = undefined;
    }
  }

  private async showSessions(limit: number, filters?: SessionListFilters) {
    try {
      this.commitSystem(formatTuiSessionList(await this.store.list(), limit, filters));
      this.setStatus("Sessions");
    } catch (error) {
      this.commitError(`Unable to list sessions: ${error instanceof Error ? error.message : String(error)}`);
      this.setStatus("Session list failed");
    }
  }

  private async pickSession(limit: number, filters?: SessionListFilters) {
    try {
      const sessions = filterSessions(await this.store.list(), filters).slice(0, clampSessionLimit(limit));
      if (sessions.length === 0) {
        const description = describeSessionListFilters(filters);
        this.commitSystem(description ? `No saved sessions match filters: ${description}.` : "No saved sessions.");
        return;
      }
      this.send({
        type: "session_picker",
        title: "Saved sessions",
        sessions: sessions.map((session) => ({
          id: session.id,
          label: `${shortId(session.id)}  ${sessionDisplayTitle(session)}`,
          description: `${formatSessionUpdatedAt(session.updatedAt)} · ${sessionWorkspaceName(session)}${session.pinnedAt ? " · pinned" : ""}`
        }))
      });
    } catch (error) {
      this.commitError(`Unable to open session picker: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private requestModelPicker() {
    if (this.busy) {
      this.setStatus("Stop the active turn before choosing a model", true);
      return;
    }
    const operation = this.beginModelOperation("picker");
    // Discovery may wait for an OpenAI-compatible endpoint. Keep the socket's
    // input dispatcher free so Esc/Stop and other native events are never held.
    this.runInBackground(
      this.runModelOperation(operation, () => this.pickModel(operation)),
      "Unable to open model picker"
    );
  }

  private requestModelSwitch(model: string) {
    if (this.busy) {
      this.setStatus("Stop the active turn before switching models", true);
      return;
    }
    if (this.isModelSwitching()) {
      this.setStatus("Model switch already in progress");
      return;
    }
    const operation = this.beginModelOperation("switch");
    this.runInBackground(
      this.runModelOperation(operation, () => this.switchModel(model, operation)),
      "Unable to switch model"
    );
  }

  private async pickModel(operation: ModelOperation) {
    const endpoint = resolveModelListEndpoint(this.config, { baseUrl: this.config.baseUrl });
    const catalogModels = this.catalogModelsForEndpoint(endpoint.baseUrl);
    let models = catalogModels;
    let notice: string | undefined;
    try {
      const discovered = await this.discoverModels(endpoint, operation.controller.signal);
      models = Array.from(new Set([...models, ...discovered]));
      if (models.length === 0) {
        notice = "No models were returned. Type /model <model-id> to use a manual model ID.";
      }
    } catch {
      if (!this.isModelOperationCurrent(operation) || this.busy) {
        return;
      }
      notice = models.length
        ? "Provider model discovery was unavailable; showing verified catalog models. Use /model <model-id> for a manual ID."
        : "Provider model discovery was unavailable. Use /model <model-id> for a manual model ID.";
    }
    if (!this.isModelOperationCurrent(operation) || this.busy) {
      return;
    }
    this.send({
      type: "model_picker",
      title: "Select model for this session",
      current_model: this.config.model,
      endpoint_label: endpoint.baseUrl,
      models: models
        .sort((left, right) => left.localeCompare(right))
        .map((id) => ({
          id,
          label: id,
          description: id === this.config.model ? "current model" : undefined
        })),
      notice
    });
    this.finishModelOperation(operation);
  }

  private catalogModelsForEndpoint(baseUrl: string) {
    const provider = this.modelCatalog.providers[normalizeCapabilityBaseUrl(baseUrl)];
    return Object.values(provider?.models ?? {})
      .filter((model) => !model.removedAt && !["not_entitled", "busy", "rate_limited", "error"].includes(model.status))
      .map((model) => model.id);
  }

  private async discoverModels(endpoint: { baseUrl: string; apiKey?: string }, signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new Error("Model discovery cancelled");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (endpoint.apiKey) {
        headers.Authorization = `Bearer ${endpoint.apiKey}`;
      }
      const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, "")}/models`, { headers, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Provider model list failed (${response.status})`);
      }
      const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
      return (body.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string" && Boolean(id.trim()));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async switchModel(rawModel: string, operation: ModelOperation) {
    const model = rawModel.trim();
    if (!model) {
      this.commitError("Usage: /model <model-id>");
      this.setStatus("Command error");
      return;
    }
    if (model === this.config.model) {
      this.setStatus(`Already using ${model}`);
      this.finishModelOperation(operation);
      return;
    }
    const endpoint = resolveModelListEndpoint(this.config, { baseUrl: this.config.baseUrl });
    const catalogModels = this.catalogModelsForEndpoint(endpoint.baseUrl);
    const catalogEntry = this.modelCatalog.providers[normalizeCapabilityBaseUrl(endpoint.baseUrl)]?.models[model];
    if (catalogEntry && (catalogEntry.removedAt || ["not_entitled", "busy", "rate_limited", "error"].includes(catalogEntry.status))) {
      this.commitError(`Model "${model}" is not currently usable with the active provider. Use /model to choose another model.`);
      this.setStatus("Model unavailable");
      this.finishModelOperation(operation);
      return;
    }
    try {
      const discovered = await this.discoverModels(endpoint, operation.controller.signal);
      if (!this.isModelOperationCurrent(operation) || this.busy) {
        return;
      }
      if (!discovered.includes(model) && !catalogModels.includes(model)) {
        this.commitError(`Model "${model}" is not available from the active provider. Use /model to choose an available model.`);
        this.setStatus("Model unavailable");
        this.finishModelOperation(operation);
        return;
      }
    } catch {
      if (!this.isModelOperationCurrent(operation) || this.busy) {
        return;
      }
      // The desktop picker intentionally permits a manual model ID when an OpenAI-compatible
      // endpoint does not expose /models. Keep that established behavior without inventing a
      // fallback model; a bad manual ID will be reported by the provider on the next turn.
      this.commitSystem(`Provider model discovery is unavailable; using manual model ID ${model}.`);
    }
    if (!this.isModelOperationCurrent(operation) || this.busy) {
      return;
    }
    const nextConfig = { ...this.config, model, baseUrl: endpoint.baseUrl };
    const nextSession = this.currentSession
      ? {
          ...this.currentSession,
          model,
          baseUrl: endpoint.baseUrl,
          modelMode: "manual" as const,
          selectedModel: model,
          updatedAt: new Date().toISOString()
        }
      : undefined;
    if (nextSession) {
      await this.store.save(nextSession);
    }
    // Saving can yield to a resume, quit, or a newer model operation. Only publish
    // the new runtime after the original operation still owns this exact session.
    if (!this.isModelOperationCurrent(operation) || this.busy) {
      return;
    }
    this.config = nextConfig;
    if (nextSession) {
      this.currentSession = nextSession;
    }
    this.currentContextTokens = undefined;
    this.agent = this.createAgent(this.currentSession);
    this.send({ type: "reset", data: this.buildInitData() });
    this.setStatus(`Model switched to ${model}`);
    this.finishModelOperation(operation);
  }

  private async resumeSession(sessionId: string) {
    this.cancelModelOperation();
    try {
      const session = await this.store.load(sessionId);
      this.currentSession = session;
      this.resetBrowserController(session.id);
      this.config = configForSession(this.options.config, session);
      this.cwd = session.cwd;
      this.workspace = await detectWorkspace(this.cwd);
      this.agent = this.createAgent(session);
      this.currentContextTokens = undefined;
      this.send({ type: "reset", data: this.buildInitData() });
      this.setStatus(`Resumed session ${shortId(session.id)}`);
    } catch (error) {
      this.commitError(`Unable to resume session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      this.setStatus("Resume failed");
    }
  }

  private confirm(message: string, request?: ApprovalPromptRequest) {
    return new Promise<boolean>((resolve) => {
      const id = randomUUID();
      this.approvalResolvers.set(id, resolve);
      this.send({
        type: "approval",
        id,
        title: request?.summary || "Approval required",
        message,
        risky: request?.risky
      });
    });
  }

  private resolveAllApprovals(approved: boolean) {
    for (const resolve of this.approvalResolvers.values()) {
      resolve(approved);
    }
    this.approvalResolvers.clear();
  }

  private buildInitData(): NativeInitData {
    return {
      project_name: this.workspace.packageName ?? path.basename(this.workspace.root),
      cwd: this.cwd,
      root: this.workspace.root,
      branch: this.workspace.gitBranch,
      dirty: this.workspace.dirty,
      model: this.config.model,
      trust: this.config.trustMode,
      session_id: this.currentSession?.id,
      context_used: this.estimatedContextTokens(),
      context_total: resolveContextWindowTokens(this.config, { model: this.config.model, baseUrl: this.config.baseUrl }, this.modelCatalog),
      transcript: transcriptForSession(this.currentSession),
      activity: activityForSession(this.currentSession),
      commands: NATIVE_TUI_COMMANDS
    };
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

  private sendActivity(item: NativeActivityItem) {
    this.send({
      type: "activity",
      item: {
        ...item,
        detail: truncateNativeActivityDetail(item.detail ?? "")
      }
    });
  }

  private commitSystem(text: string) {
    this.send({ type: "commit", entry: { kind: "system", text, time: new Date().toISOString() } });
  }

  private commitError(text: string) {
    this.send({ type: "commit", entry: { kind: "error", text, time: new Date().toISOString() } });
  }

  private setStatus(message: string, busy = this.busy) {
    this.send({
      type: "status",
      message,
      busy,
      queue_len: this.promptQueue.length,
      context_used: this.currentContextTokens
    });
  }

  private stopRun() {
    this.cancelModelOperation();
    if (this.runAbortController && !this.runAbortController.signal.aborted) {
      this.runAbortController.abort(new AgentRunAbortedError());
      this.setStatus("Stopping", true);
      return;
    }
    if (this.pendingQueuedInput) {
      const pending = this.pendingQueuedInput;
      this.pendingQueuedInput = undefined;
      this.queuedDispatchGeneration += 1;
      this.busy = false;
      if (this.closing || this.promptQueue.length === 0) {
        this.setStatus(`Queued ${pending.kind === "shell" ? "command" : "prompt"} stopped`);
      } else {
        // Match the established active-run behavior: the selected pending item
        // is cancelled, while later FIFO entries remain deliberate work and
        // continue through the normal foreground handoff.
        this.finishForegroundRun();
      }
    }
  }

  private runInBackground(operation: Promise<void>, label: string) {
    void operation.catch((error: unknown) => {
      if (this.closing) {
        return;
      }
      this.send({
        type: "run_failed",
        message: `${label}: ${error instanceof Error ? error.message : String(error)}`
      });
    });
  }

  private exit() {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.cancelModelOperation();
    this.stopRun();
    this.resolveAllApprovals(false);
    this.send({ type: "quit" });
  }

  private send(event: NativeServerEvent) {
    this.transport?.send(event);
  }

  private beginModelOperation(kind: ModelOperation["kind"]): ModelOperation {
    this.cancelModelOperation();
    const operation: ModelOperation = {
      generation: (this.modelOperationGeneration += 1),
      kind,
      controller: new AbortController(),
      snapshot: { model: this.config.model, baseUrl: this.config.baseUrl, sessionId: this.currentSession?.id }
    };
    this.modelOperation = operation;
    return operation;
  }

  private finishModelOperation(operation: ModelOperation) {
    if (this.modelOperation?.generation === operation.generation) {
      this.modelOperation = undefined;
    }
  }

  private async runModelOperation(operation: ModelOperation, task: () => Promise<void>) {
    try {
      await task();
    } finally {
      this.finishModelOperation(operation);
    }
  }

  private cancelModelOperation() {
    this.modelOperationGeneration += 1;
    this.modelOperation?.controller.abort();
    this.modelOperation = undefined;
  }

  private isModelOperationCurrent(operation: ModelOperation) {
    return (
      !this.closing &&
      !operation.controller.signal.aborted &&
      this.modelOperation?.generation === operation.generation &&
      this.config.model === operation.snapshot.model &&
      this.config.baseUrl === operation.snapshot.baseUrl &&
      this.currentSession?.id === operation.snapshot.sessionId
    );
  }

  private isModelSwitching() {
    return this.modelOperation?.kind === "switch" && !this.modelOperation.controller.signal.aborted;
  }
}

function commandChangesRunState(command: TuiSlashCommand) {
  return (
    command.kind === "compact" ||
    command.kind === "model" ||
    command.kind === "continue" ||
    command.kind === "resume" ||
    command.kind === "summarize" ||
    (command.kind === "sessions" && Boolean(command.pick))
  );
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

function shortId(id: string) {
  return id.slice(0, 8);
}

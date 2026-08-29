import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent } from "../agent/Agent.js";
import { BrowserUseCliController } from "../browser/browserUseCliController.js";
import { chatContentToText, textPart, type ChatContent, type ChatContentPart } from "../agent/content.js";
import {
  countAttachmentLines,
  imageMimeTypeForPath,
  MAX_CONTEXT_FILE_ATTACHMENTS,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_FILE_CHARS,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES
} from "../agent/attachmentPolicy.js";
import { promptTextWithFileContext, type PromptFileContext } from "../agent/fileContext.js";
import {
  COMPACT_RECENT_MESSAGE_COUNT,
  applyContextCompactionCheckpoint,
  compactSessionMessages,
  contextMessagesForSession
} from "../agent/contextCompaction.js";
import { OpenAICompatibleChatClient } from "../agent/OpenAICompatibleChatClient.js";
import {
  AgentRunAbortedError,
  type AgentRunEvent,
  type AgentSession,
  type AgentTaskRun,
  type AgentTaskRunApprovalEvent,
  type ApprovalPromptRequest,
  type ChatUsage
} from "../agent/types.js";
import { configForModelSelection, applyModelSelectionToSession } from "../harness/sessionRuntime.js";
import { RuntimeControlService } from "../harness/runtimeControlService.js";
import {
  createDisabledToolsReader,
  normalizeDisabledTools,
  proposeMcpServer,
  reviewMcpProposal,
  safeMcpProposalDisplay
} from "../harness/mcpProposals.js";
import {
  beginAgentLoopIteration,
  continuationAgentLoopInstruction,
  createAgentLoopState,
  finishAgentLoop,
  finishAgentLoopIteration,
  initialAgentLoopInstruction,
  planningApprovalInstruction,
  stripAgentLoopDecision
} from "../harness/agentLoop.js";
import {
  abortTaskWorktreeConflict,
  cleanupMergedTaskWorktree,
  createTaskWorktree,
  discardTaskWorktree,
  mergeTaskWorktree,
  previewTaskWorktreePatch,
  summarizeTaskWorktree,
  syncTaskWorktreeWithOriginal,
  continueTaskWorktreeConflict,
  approvedPlanWorktreeInstruction,
  replayTaskWorktreeInstruction,
  taskWorktreeInstruction,
  prepareTaskWorktreePullRequest,
  createTaskWorktreePullRequest,
  refreshTaskWorktreePullRequest,
  fetchTaskWorktreePullRequestCheckLogs,
  resolveTaskWorktreePath
} from "../agent/taskWorktree.js";
import { resolveModelForPrompt } from "../agent/modelRouter.js";
import { buildTaskRunReportRemediationInstruction } from "../agent/reportRemediation.js";
import {
  enqueuePrompt,
  markPromptForSteering,
  restoreQueuedPrompt,
  takeNextQueuedPrompt,
  takeSteeringMessages
} from "../agent/queuedPrompts.js";
import {
  createAgentTaskRun,
  finishTaskRun,
  markTaskRunRunning,
  recordTaskRunApproval,
  recordTaskRunEvent,
  recordLatestAssistantTaskMetadata,
  syncTaskRunLoopState,
  trimTaskRuns
} from "../agent/taskRuns.js";
import { ChangeCheckpoint, type ChangeCheckpointEntry } from "../tools/changeCheckpoint.js";
import { createToolRegistry } from "../tools/registry.js";
import { validateElicitationResponse, type ElicitationRequest, type ElicitationResponse } from "../tools/elicitation.js";
import {
  loadConfig,
  saveConfig,
  normalizeCapabilityBaseUrl,
  appDataDir,
  resolveModelListEndpoint,
  resolveWebSearchProvider,
  workspacePolicyOverridesForRoot,
  workspaceScopeRulesForRoot,
  type AppConfig,
  type McpToolProposal
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
import type {
  NativeActivityItem,
  NativeClientEvent,
  NativeElicitationQuestion,
  NativeInitData,
  NativeServerEvent
} from "./nativeProtocol.js";
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

type QueuedInput = { kind: "prompt"; content: ChatContent; queuedPromptId?: string } | { kind: "shell"; command: string };

const NATIVE_PLAN_TOOL_NAMES = [
  "list",
  "read",
  "search",
  "git_status",
  "current_datetime",
  "current_location",
  "list_skills",
  "read_skill"
];

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
  private readonly pendingAttachments: ChatContentPart[] = [];
  private readonly pendingFileContexts: PromptFileContext[] = [];
  private nextPromptPlanMode = false;
  private nextPromptApprovedPlanTaskRunId?: string;
  private nextPromptLoopMaxIterations?: number;
  private nextPromptWorktreeMode = false;
  private nextPromptWorktreeContinuation?: { taskRunId: string; replayOfTaskRunId?: string };
  private readonly approvalResolvers = new Map<string, (approved: boolean) => void>();
  private readonly elicitationResolvers = new Map<string, (response: ElicitationResponse) => void>();
  private readonly elicitationRequests = new Map<string, ElicitationRequest>();
  private readonly activityInputs = new Map<string, string>();
  private activeBrowserToolId?: string;
  private queuedDispatchGeneration = 0;
  private pendingQueuedInput?: QueuedInput;
  private pendingQueueCancellation?: Promise<void>;
  private deferQueuedPromptHandoff = false;
  private queueStartupBlocked = false;
  private modelOperationGeneration = 0;
  private modelOperation?: ModelOperation;
  private browserController?: BrowserUseCliController;
  private browserSessionKey = `tui-${randomUUID()}`;
  private shellCommandRunner: ShellCommandRunner = runShellCommand;
  private activeTaskRunId?: string;
  private activeCheckpoint?: ChangeCheckpoint;
  private activeExecutionCwd?: string;
  private activeRuntimeControl?: RuntimeControlService;
  private readonly sessionDisabledTools = new Map<string, Set<string>>();

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
    this.restoreDurablePromptQueue();

    this.transport = new NativeTuiProcess({
      cwd: this.cwd,
      onMessage: (event) => this.handleNativeEvent(event),
      onDisconnect: () => this.handleNativeDisconnect()
    });

    try {
      await this.transport.start();
      this.send({ type: "init", data: this.buildInitData() });
      if (this.promptQueue.length > 0) {
        this.finishForegroundRun();
      }
      await this.transport.wait();
    } finally {
      this.closing = true;
      this.stopRun();
      this.resolveAllApprovals(false);
      this.resolveAllElicitations();
      await this.pendingQueueCancellation?.catch(() => undefined);
      this.transport.close();
    }
  }

  private createAgent(session?: AgentSession, taskRunId?: string, checkpoint?: ChangeCheckpoint, config = this.config, cwd = this.cwd) {
    const scopePolicyRules = workspaceScopeRulesForRoot(config, this.workspace.root);
    const sessionDisabledTools = session ? (this.sessionDisabledTools.get(session.id) ?? new Set<string>()) : new Set<string>();
    if (session) this.sessionDisabledTools.set(session.id, sessionDisabledTools);
    const runtimeControl = new RuntimeControlService({
      configuredBrowserTaskModel: { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey },
      readSavedDisabledTools: createDisabledToolsReader(config.disabledTools ?? []),
      sessionDisabledTools,
      onSessionBrowserModelChange: () => undefined,
      onProposeMcpServer: proposeMcpServer
    });
    this.activeRuntimeControl = runtimeControl;
    return new Agent({
      client: new OpenAICompatibleChatClient(config),
      approvals: new ApprovalManager(
        config.trustMode,
        (message, request) => this.confirm(message, request),
        workspacePolicyOverridesForRoot(config, this.workspace.root),
        taskRunId && session ? (event) => this.recordApprovalEvent(session, taskRunId, event) : undefined,
        scopePolicyRules,
        this.workspace.root
      ),
      cwd,
      model: config.model,
      baseUrl: config.baseUrl,
      webSearchProvider: resolveWebSearchProvider(config),
      mcpServers: config.mcpServers,
      scopePolicyRules,
      browser: this.browserControllerForSession(),
      manualBrowserTools: true,
      runtimeControl,
      customInstructions: config.customSystemPrompt,
      minStepIntervalMs: config.chatModelRequestDelayMs,
      // Native TUI has no browser_task supervisor. It deliberately retains the direct
      // Browser Use primitives while sharing the run evidence/checkpoint machinery.
      directEditReview: true,
      elicit: (request) => this.elicit(request),
      checkpoint,
      contextWindowTokens: resolveContextWindowTokens(config, { model: config.model, baseUrl: config.baseUrl }, this.modelCatalog),
      onContextWindowObserved: (tokens) =>
        recordContextFromRuntime(this.catalogStore, { baseUrl: config.baseUrl, model: config.model }, tokens),
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
        if (typeof event.id !== "string" || typeof event.approved !== "boolean") {
          this.setStatus("The approval response is invalid.", true);
          break;
        }
        this.approvalResolvers.get(event.id)?.(event.approved);
        this.approvalResolvers.delete(event.id);
        break;
      case "elicitation_response": {
        if (typeof event.id !== "string" || (event.status !== "answered" && event.status !== "declined")) {
          this.setStatus("The question response is invalid.", true);
          break;
        }
        const request = this.elicitationRequests.get(event.id);
        let validationError = "The question request is no longer active.";
        try {
          validationError = request
            ? (validateElicitationResponse(request, { status: event.status, answers: event.answers }) ?? "")
            : validationError;
        } catch {
          validationError = "The question response is invalid.";
        }
        if (validationError) {
          this.setStatus(validationError, true);
          break;
        }
        this.elicitationResolvers.get(event.id)?.({ status: event.status, answers: event.answers });
        this.elicitationResolvers.delete(event.id);
        this.elicitationRequests.delete(event.id);
        break;
      }
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
    this.resolveAllElicitations();
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
      if (this.busy || this.hasQueuedPromptBacklog()) {
        await this.queueInput(input);
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

    const content = this.composePromptContent(value);
    const input: QueuedInput = { kind: "prompt", content };
    if (this.busy || this.hasQueuedPromptBacklog()) {
      await this.queueInput(input);
      this.pendingAttachments.length = 0;
      this.pendingFileContexts.length = 0;
    } else {
      this.runInBackground(this.runQueuedInput(input), "Unable to run prompt");
      this.pendingAttachments.length = 0;
      this.pendingFileContexts.length = 0;
    }
  }

  private async queueInput(input: QueuedInput) {
    if (input.kind === "prompt" && this.currentSession) {
      const id = randomUUID();
      enqueuePrompt(this.currentSession, { id, content: input.content, state: "queued", createdAt: new Date().toISOString() });
      input = { ...input, queuedPromptId: id };
      this.currentSession.updatedAt = new Date().toISOString();
      await this.store.save(this.currentSession);
    }
    this.promptQueue.push(input);
    this.send({
      type: "status",
      message: `${this.promptQueue.length} item${this.promptQueue.length === 1 ? "" : "s"} queued`,
      busy: this.busy,
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
    if (input.queuedPromptId && this.currentSession) {
      const prompt = takeNextQueuedPrompt(this.currentSession);
      if (!prompt || prompt.id !== input.queuedPromptId) {
        throw new Error("Queued prompt state no longer matches the foreground queue.");
      }
      this.currentSession.updatedAt = new Date().toISOString();
      await this.store.save(this.currentSession);
      this.deferQueuedPromptHandoff = true;
      let taskRunStarted: boolean | undefined;
      try {
        taskRunStarted = await this.runPrompt(prompt.content);
      } finally {
        this.deferQueuedPromptHandoff = false;
      }
      // A routing failure occurs before a task run exists. Restore its durable and in-memory
      // FIFO ownership before letting the foreground scheduler choose the next item; otherwise
      // a later prompt can observe the restored durable A while holding in-memory B.
      if (taskRunStarted === false && this.currentSession) {
        // A steering prompt has no active run after a preflight failure. Recover
        // it as ordinary FIFO work, matching restart behavior, rather than
        // leaving an orphaned steering record that can never be consumed.
        const recovered = { ...prompt, state: "queued" as const };
        restoreQueuedPrompt(this.currentSession, recovered);
        this.currentSession.updatedAt = new Date().toISOString();
        await this.store.save(this.currentSession);
        this.promptQueue.unshift({ ...input, queuedPromptId: recovered.id });
        this.queueStartupBlocked = true;
        this.busy = false;
        this.setStatus("Queued startup failed. Queue is paused; use /queue retry after fixing configuration.");
      }
      return;
    }
    await this.runPrompt(input.content);
  }

  private restoreDurablePromptQueue() {
    if (!this.currentSession?.queuedPrompts?.length || this.promptQueue.length > 0) {
      return;
    }
    this.promptQueue.push(
      ...this.currentSession.queuedPrompts
        // A steering request is only special while an Agent turn is active. Once
        // that turn is gone, recover it as ordinary FIFO work rather than orphaning
        // its durable record on restart.
        .filter((prompt) => prompt.state === "queued" || prompt.state === "steering")
        .map((prompt) => ({
          kind: "prompt" as const,
          content: prompt.content,
          queuedPromptId: prompt.id
        }))
    );
  }

  private hasQueuedPromptBacklog() {
    return this.promptQueue.length > 0 || Boolean(this.currentSession?.queuedPrompts?.length);
  }

  private retryQueuedPrompts() {
    if (this.busy) {
      this.setStatus("Stop the active turn before retrying queued prompts", true);
      return;
    }
    this.restoreDurablePromptQueue();
    if (this.promptQueue.length === 0) {
      this.setStatus("No queued prompts to retry");
      return;
    }
    this.queueStartupBlocked = false;
    this.busy = true;
    this.finishForegroundRun();
  }

  private async runPrompt(content: ChatContent): Promise<boolean> {
    const controller = this.reserveAgentTurn("Working");
    let taskRunStarted = false;
    try {
      // Resolve `auto` for every prompt, just as the desktop harness does. The durable
      // session keeps `auto` as the selected mode but records the concrete model that served
      // this task run for later review.
      const baseConfig = configForSession(this.config, this.currentSession);
      const selection = resolveModelForPrompt(baseConfig, content, { session: this.currentSession });
      const runConfig = configForModelSelection(baseConfig, selection);
      const now = new Date().toISOString();
      const session = applyModelSelectionToSession(
        this.currentSession
          ? { ...this.currentSession, messages: [...this.currentSession.messages], updatedAt: now }
          : {
              id: randomUUID(),
              cwd: this.cwd,
              projectRoot: this.workspace.root,
              trustMode: runConfig.trustMode,
              messages: [],
              createdAt: now,
              updatedAt: now
            },
        selection
      );
      session.trustMode = runConfig.trustMode;
      const planModeEnabled = this.nextPromptPlanMode;
      const loopMaxIterations = !planModeEnabled ? this.nextPromptLoopMaxIterations : undefined;
      const approvedPlanTaskRunId = !planModeEnabled ? this.nextPromptApprovedPlanTaskRunId : undefined;
      const worktreeContinuation = !planModeEnabled ? this.nextPromptWorktreeContinuation : undefined;
      const worktreeModeArmed = !planModeEnabled && this.nextPromptWorktreeMode;
      const approvedPlan = approvedPlanTaskRunId ? this.resolveTaskRunId(session, approvedPlanTaskRunId) : undefined;
      this.nextPromptPlanMode = false;
      this.nextPromptApprovedPlanTaskRunId = undefined;
      this.nextPromptLoopMaxIterations = undefined;
      this.nextPromptWorktreeMode = false;
      this.nextPromptWorktreeContinuation = undefined;
      if (
        approvedPlanTaskRunId &&
        (!approvedPlan?.planMode?.enabled || approvedPlan.planReview?.status !== "approved" || !approvedPlan.plan)
      )
        throw new Error("Approved plan task run was not found or is not approved.");
      const worktreeModeEnabled = !planModeEnabled && (worktreeModeArmed || Boolean(worktreeContinuation) || Boolean(approvedPlan));
      const loop = loopMaxIterations ? createAgentLoopState(content, loopMaxIterations, now) : undefined;
      if (planModeEnabled) {
        session.messages.push({ role: "system", content: planningApprovalInstruction(), createdAt: now });
      }
      if (loop) session.agentLoop = loop;
      if (loop) session.messages.push({ role: "system", content: initialAgentLoopInstruction(loop), createdAt: now });
      const taskRun = createAgentTaskRun({
        userMessageIndex: session.messages.length,
        prompt: content,
        model: selection.model,
        providerName: selection.providerName,
        modelSelectionReason: selection.reason,
        planModeEnabled,
        loop,
        worktreeEnabled: worktreeModeEnabled,
        now
      });
      session.taskRuns = trimTaskRuns([...(session.taskRuns ?? []), taskRun]);
      this.currentSession = session;
      this.activeTaskRunId = taskRun.id;
      taskRunStarted = true;
      let executionCwd = this.cwd;
      if (worktreeModeEnabled) {
        const source = worktreeContinuation ? this.resolveTaskRunId(session, worktreeContinuation.taskRunId) : undefined;
        const worktree = source?.worktree;
        if (
          worktreeContinuation &&
          (!worktree?.enabled || !worktree.path || !worktree.branch || !worktree.originalRoot || !worktree.baseRef)
        )
          throw new Error("Managed worktree continuation was not found.");
        const prepared = worktreeContinuation
          ? {
              path: await resolveTaskWorktreePath(worktree!),
              branch: worktree!.branch!,
              originalRoot: worktree!.originalRoot!,
              baseRef: worktree!.baseRef!,
              createdAt: worktree!.createdAt ?? now
            }
          : await createTaskWorktree({ cwd: this.cwd, sessionId: session.id, taskRunId: taskRun.id });
        if (!(await stat(prepared.path)).isDirectory()) throw new Error("Task worktree target is not a folder.");
        taskRun.worktree = {
          enabled: true,
          status: "ready",
          ...prepared,
          plannedFromTaskRunId: approvedPlan?.id,
          continuedFromTaskRunId: source?.id,
          replayOfTaskRunId: worktreeContinuation?.replayOfTaskRunId
        };
        executionCwd = prepared.path;
        session.messages.push({
          role: "system",
          content: [
            taskWorktreeInstruction(prepared),
            approvedPlan ? approvedPlanWorktreeInstruction(approvedPlan.id) : undefined,
            source ? `This prompt continues existing task run ${source.id}. Keep the repair in the same task worktree.` : undefined,
            worktreeContinuation?.replayOfTaskRunId ? replayTaskWorktreeInstruction(worktreeContinuation.replayOfTaskRunId) : undefined
          ]
            .filter(Boolean)
            .join("\n"),
          createdAt: now
        });
        taskRun.userMessageIndex += 1;
      }
      this.config = configForSession(this.config, session);
      this.activeExecutionCwd = executionCwd;
      this.activeCheckpoint = worktreeModeEnabled ? undefined : new ChangeCheckpoint();
      markTaskRunRunning(taskRun, now);
      this.agent = this.createAgent(session, taskRun.id, this.activeCheckpoint, runConfig, executionCwd);
      this.send({ type: "commit", entry: { kind: "user", text: chatContentToText(content), time: new Date().toISOString() } });
      // A started run is durable before the first provider request. If startup itself fails,
      // the catch path below upgrades this same record to failed/stopped with recovery state.
      await this.store.save(session);
      await this.executeAgentTurn((signal) =>
        loop
          ? this.runNativeAgentLoop(content, signal)
          : this.agent.run(content, {
              allowedToolNames: planModeEnabled ? NATIVE_PLAN_TOOL_NAMES : undefined,
              disabledToolNames: () => this.activeRuntimeControl?.disabledToolNames() ?? Promise.resolve([]),
              onEvent: (event) => this.handleAgentEvent(event),
              onUsage: (usage) => this.recordRunUsage(usage),
              takeSteeringMessages: () => (this.currentSession ? takeSteeringMessages(this.currentSession) : []),
              onSteeringMessagesApplied: async () => {
                if (this.currentSession) {
                  this.dropConsumedQueuedInputs();
                  this.currentSession.updatedAt = new Date().toISOString();
                  await this.store.save(this.currentSession);
                }
              },
              signal
            })
      );
      return true;
    } catch (error) {
      await this.failPreparedAgentTurn(error, controller, !this.deferQueuedPromptHandoff || taskRunStarted);
      return taskRunStarted;
    }
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
    const controller = this.reserveAgentTurn("Working");
    try {
      const content: ChatContent = "Continue the current task.";
      const baseConfig = configForSession(this.config, this.currentSession);
      const selection = resolveModelForPrompt(baseConfig, content, { session: this.currentSession });
      const runConfig = configForModelSelection(baseConfig, selection);
      const now = new Date().toISOString();
      const session = applyModelSelectionToSession(
        { ...this.currentSession, messages: [...this.currentSession.messages], updatedAt: now },
        selection
      );
      const taskRun = createAgentTaskRun({
        userMessageIndex: this.mostRecentUserMessageIndex(session),
        prompt: content,
        model: selection.model,
        providerName: selection.providerName,
        modelSelectionReason: selection.reason,
        now
      });
      session.taskRuns = trimTaskRuns([...(session.taskRuns ?? []), taskRun]);
      markTaskRunRunning(taskRun, now);
      this.currentSession = session;
      this.config = configForSession(this.config, session);
      this.activeTaskRunId = taskRun.id;
      this.activeCheckpoint = new ChangeCheckpoint();
      this.agent = this.createAgent(session, taskRun.id, this.activeCheckpoint, runConfig);
      await this.store.save(session);
      await this.executeAgentTurn((signal) =>
        this.agent.continue({
          disabledToolNames: () => this.activeRuntimeControl?.disabledToolNames() ?? Promise.resolve([]),
          onEvent: (event) => this.handleAgentEvent(event),
          onUsage: (usage) => this.recordRunUsage(usage),
          takeSteeringMessages: () => (this.currentSession ? takeSteeringMessages(this.currentSession) : []),
          onSteeringMessagesApplied: async () => {
            if (this.currentSession) {
              this.dropConsumedQueuedInputs();
              this.currentSession.updatedAt = new Date().toISOString();
              await this.store.save(this.currentSession);
            }
          },
          signal
        })
      );
    } catch (error) {
      await this.failPreparedAgentTurn(error, controller);
    }
  }

  private reserveAgentTurn(status: string) {
    // Reserve before the first await in model routing/setup. The normal FIFO handoff already
    // reserves `busy`; replacing its controller here preserves that reservation and ensures a
    // keystroke cannot start a second foreground model run in the setup window.
    const controller = new AbortController();
    this.busy = true;
    this.runAbortController = controller;
    this.lastRunUsage = undefined;
    this.activeBrowserToolId = undefined;
    this.activityInputs.clear();
    this.send({ type: "run_started", status });
    return controller;
  }

  private async executeAgentTurn(runner: (signal: AbortSignal) => Promise<{ output: string; session: AgentSession }>) {
    const controller = this.runAbortController ?? this.reserveAgentTurn("Working");

    try {
      const result = await runner(controller.signal);
      await this.completeTaskRun(
        result.session,
        this.activeTaskRunId,
        taskRunStatusForLoop(result.session.agentLoop),
        this.activeCheckpoint
      );
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
      // Agent keeps partial messages/tool evidence and adds a recovery note before it throws.
      // Save that exact mutable session for both Stop and failures instead of only the happy path.
      const session = this.currentSession;
      if (error instanceof AgentRunAbortedError || controller.signal.aborted) {
        if (session) {
          if (session.agentLoop?.status === "running") session.agentLoop = finishAgentLoop(session.agentLoop, "stopped");
          await this.completeTaskRun(session, this.activeTaskRunId, "stopped", this.activeCheckpoint);
          await this.store.save(session);
        }
        this.send({ type: "run_stopped", message: "Run stopped." });
      } else {
        if (session) {
          if (session.agentLoop?.status === "running") session.agentLoop = finishAgentLoop(session.agentLoop, "failed");
          await this.completeTaskRun(
            session,
            this.activeTaskRunId,
            "failed",
            this.activeCheckpoint,
            error instanceof Error ? error.message : String(error)
          );
          await this.store.save(session);
        }
        this.send({ type: "run_failed", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (this.runAbortController === controller) {
        this.runAbortController = undefined;
      }
      this.activeBrowserToolId = undefined;
      this.activeTaskRunId = undefined;
      this.activeCheckpoint = undefined;
      this.activeExecutionCwd = undefined;
      this.finishForegroundRun();
    }
  }

  private async runNativeAgentLoop(content: ChatContent, signal: AbortSignal): Promise<{ output: string; session: AgentSession }> {
    let output = "";
    let session = this.currentSession!;
    while (session.agentLoop?.status === "running") {
      const startedAt = new Date().toISOString();
      session.agentLoop = beginAgentLoopIteration(session.agentLoop, startedAt);
      const run = session.taskRuns?.find((entry) => entry.id === this.activeTaskRunId);
      if (run) syncTaskRunLoopState(run, session.agentLoop);
      const toolStartCount = run?.tools.length ?? 0;
      const artifactStartCount = run?.artifacts.length ?? 0;
      session.updatedAt = startedAt;
      await this.store.save(session);
      const result =
        session.agentLoop.iteration === 1
          ? await this.agent.run(content, {
              disabledToolNames: () => this.activeRuntimeControl?.disabledToolNames() ?? Promise.resolve([]),
              onEvent: (event) => this.handleAgentEvent(event),
              onUsage: (usage) => this.recordRunUsage(usage),
              takeSteeringMessages: () => (this.currentSession ? takeSteeringMessages(this.currentSession) : []),
              onSteeringMessagesApplied: async () => {
                this.dropConsumedQueuedInputs();
                if (this.currentSession) await this.store.save(this.currentSession);
              },
              signal
            })
          : await this.agent.continue({
              disabledToolNames: () => this.activeRuntimeControl?.disabledToolNames() ?? Promise.resolve([]),
              onEvent: (event) => this.handleAgentEvent(event),
              onUsage: (usage) => this.recordRunUsage(usage),
              takeSteeringMessages: () => (this.currentSession ? takeSteeringMessages(this.currentSession) : []),
              onSteeringMessagesApplied: async () => {
                this.dropConsumedQueuedInputs();
                if (this.currentSession) await this.store.save(this.currentSession);
              },
              signal
            });
      session = result.session;
      this.currentSession = session;
      const activeLoop = session.agentLoop;
      if (!activeLoop) break;
      const decision = stripAgentLoopDecision(session) ?? "done";
      output = chatContentToText([...session.messages].reverse().find((message) => message.role === "assistant")?.content ?? result.output);
      const afterRun = this.findTaskRun(session, this.activeTaskRunId);
      if (afterRun) recordLatestAssistantTaskMetadata(afterRun, session.messages);
      const terminal = activeLoop.stopRequested
        ? "stopped"
        : decision === "blocked"
          ? "blocked"
          : decision === "continue" && activeLoop.iteration < activeLoop.maxIterations
            ? undefined
            : decision === "continue"
              ? "max_iterations"
              : "completed";
      const assistantMessageIndex = session.messages.map((message) => message.role).lastIndexOf("assistant");
      session.agentLoop = finishAgentLoopIteration(activeLoop, {
        decision,
        status: terminal ?? "continued",
        output,
        assistantMessageIndex: assistantMessageIndex >= 0 ? assistantMessageIndex : undefined,
        toolCallCount: Math.max(0, (afterRun?.tools.length ?? 0) - toolStartCount),
        artifactCount: Math.max(0, (afterRun?.artifacts.length ?? 0) - artifactStartCount)
      });
      if (terminal) session.agentLoop = finishAgentLoop(session.agentLoop, terminal);
      const taskRun = this.findTaskRun(session, this.activeTaskRunId);
      if (taskRun) syncTaskRunLoopState(taskRun, session.agentLoop);
      if (terminal === "stopped") {
        output = "Loop stopped after the current iteration.";
        session.messages.push({ role: "assistant", content: output, createdAt: new Date().toISOString() });
      }
      if (terminal === "max_iterations") {
        output = `Loop stopped after reaching ${session.agentLoop.maxIterations} iterations.`;
        session.messages.push({
          role: "assistant",
          content: `${output} Review the latest result or continue manually.`,
          createdAt: new Date().toISOString()
        });
      }
      if (!terminal) {
        const remediation = buildTaskRunReportRemediationInstruction(taskRun, session.messages);
        if (remediation) session.messages.push({ role: "system", content: remediation, createdAt: new Date().toISOString() });
        const loopForContinuation = session.agentLoop;
        session.messages.push({
          role: "system",
          content: continuationAgentLoopInstruction(loopForContinuation),
          createdAt: new Date().toISOString()
        });
        session.agentLoop = { ...loopForContinuation, updatedAt: new Date().toISOString() };
        if (taskRun) syncTaskRunLoopState(taskRun, session.agentLoop);
      }
      session.updatedAt = new Date().toISOString();
      await this.store.save(session);
    }
    return { output, session };
  }

  private async failPreparedAgentTurn(error: unknown, controller: AbortController, handOffForeground = true) {
    if (this.runAbortController !== controller) {
      return;
    }
    const stopped = error instanceof AgentRunAbortedError || controller.signal.aborted;
    const session = this.currentSession;
    try {
      if (session) {
        await this.completeTaskRun(
          session,
          this.activeTaskRunId,
          stopped ? "stopped" : "failed",
          this.activeCheckpoint,
          stopped ? undefined : error instanceof Error ? error.message : String(error)
        );
        await this.store.save(session);
      }
      this.send(
        stopped
          ? { type: "run_stopped", message: "Run stopped." }
          : { type: "run_failed", message: error instanceof Error ? error.message : String(error) }
      );
    } finally {
      this.runAbortController = undefined;
      this.activeBrowserToolId = undefined;
      this.activeTaskRunId = undefined;
      this.activeCheckpoint = undefined;
      this.activeExecutionCwd = undefined;
      if (handOffForeground) this.finishForegroundRun();
    }
  }

  private finishForegroundRun() {
    if (this.closing) {
      this.busy = false;
      return;
    }
    if (this.queueStartupBlocked) {
      this.busy = false;
      this.setStatus("Queued startup is paused; use /queue retry after fixing configuration.");
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
        this.runInBackground(
          (async () => {
            await this.pendingQueueCancellation;
            this.pendingQueueCancellation = undefined;
            await this.runQueuedInput(next);
          })(),
          `Unable to run queued ${nextLabel}`
        );
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
    const taskRun = this.findTaskRun(this.currentSession, this.activeTaskRunId);
    if (taskRun) {
      taskRun.usage = {
        promptTokens: (taskRun.usage?.promptTokens ?? 0) + (usage.promptTokens ?? 0),
        completionTokens: (taskRun.usage?.completionTokens ?? 0) + (usage.completionTokens ?? 0),
        totalTokens: (taskRun.usage?.totalTokens ?? 0) + (usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)),
        requestCount: (taskRun.usage?.requestCount ?? 0) + 1
      };
      taskRun.updatedAt = new Date().toISOString();
    }
  }

  private async handleAgentEvent(event: AgentRunEvent) {
    const taskRun = this.findTaskRun(this.currentSession, this.activeTaskRunId);
    if (taskRun) {
      const changed = recordTaskRunEvent(taskRun, event, new Date().toISOString(), { workspaceRoot: this.activeExecutionCwd ?? this.cwd });
      if (changed && this.currentSession) {
        this.currentSession.updatedAt = taskRun.updatedAt;
        // Persist tool/audit evidence at each safe event boundary. This makes an app crash
        // reviewable too, rather than treating end-of-turn as the only durable checkpoint.
        await this.store.save(this.currentSession);
      }
    }
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

  private findTaskRun(session: AgentSession | undefined, taskRunId: string | undefined) {
    return taskRunId ? session?.taskRuns?.find((run) => run.id === taskRunId) : undefined;
  }

  private resolveTaskRunId(session: AgentSession | undefined, value: string) {
    const runs = session?.taskRuns ?? [];
    const exact = runs.find((run) => run.id === value);
    if (exact) {
      return exact;
    }
    const matches = runs.filter((run) => run.id.startsWith(value));
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw new Error(`Task-run prefix ${JSON.stringify(value)} is ambiguous; use the full id shown in /runs.`);
    }
    return undefined;
  }

  private mostRecentUserMessageIndex(session: AgentSession) {
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      if (session.messages[index]?.role === "user") {
        return index;
      }
    }
    // `/continue` is unavailable for an empty session; retain a safe schema-valid fallback.
    return 0;
  }

  private async recordApprovalEvent(session: AgentSession, taskRunId: string, event: AgentTaskRunApprovalEvent) {
    const taskRun = this.findTaskRun(session, taskRunId);
    if (!taskRun) {
      return;
    }
    recordTaskRunApproval(taskRun, event, new Date().toISOString());
    session.updatedAt = taskRun.updatedAt;
    await this.store.save(session);
  }

  private checkpointFile(sessionId: string, taskRunId: string) {
    return path.join(appDataDir(), "checkpoints", sessionId, `${taskRunId}.json`);
  }

  private async completeTaskRun(
    session: AgentSession,
    taskRunId: string | undefined,
    status: AgentTaskRun["status"],
    checkpoint: ChangeCheckpoint | undefined,
    error?: string
  ) {
    const taskRun = this.findTaskRun(session, taskRunId);
    if (!taskRun) {
      return;
    }
    const now = new Date().toISOString();
    recordLatestAssistantTaskMetadata(taskRun, session.messages, now);
    if (checkpoint && checkpoint.size > 0) {
      const file = this.checkpointFile(session.id, taskRun.id);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, JSON.stringify(checkpoint.toJSON()), { encoding: "utf8", mode: 0o600 });
      taskRun.checkpoint = { changedPaths: checkpoint.changedPaths(), capturedAt: now };
    }
    finishTaskRun(taskRun, status, error, now);
    session.updatedAt = taskRun.updatedAt;
  }

  private async undoTaskRun(taskRunId: string) {
    const session = this.currentSession;
    const taskRun = this.resolveTaskRunId(session, taskRunId);
    if (!session || !taskRun?.checkpoint) {
      throw new Error("No revertible checkpoint was found for that run.");
    }
    if (taskRun.checkpoint.revertedAt) {
      throw new Error("This run's checkpoint was already reverted.");
    }
    const raw = await readFile(this.checkpointFile(session.id, taskRun.id), "utf8");
    const reverted = await new ChangeCheckpoint(JSON.parse(raw) as ChangeCheckpointEntry[]).revert();
    const now = new Date().toISOString();
    taskRun.checkpoint = { ...taskRun.checkpoint, revertedAt: now };
    taskRun.updatedAt = now;
    session.updatedAt = now;
    await this.store.save(session);
    await rm(this.checkpointFile(session.id, taskRun.id), { force: true });
    this.commitSystem(`Undid ${reverted.length} path${reverted.length === 1 ? "" : "s"} from run ${shortId(taskRun.id)}.`);
    this.setStatus("Changes undone");
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
      case "tools":
        await this.manageToolAvailability(command.action, command.name);
        break;
      case "integrations":
        await this.manageMcpIntegrations(command.action, command.id);
        break;
      case "clear":
        this.send({ type: "clear" });
        this.setStatus("Visible transcript cleared");
        break;
      case "new":
        await this.startNewSession();
        break;
      case "delete":
        await this.deleteCurrentSession();
        break;
      case "rename":
        await this.renameCurrentSession(command.title);
        break;
      case "pin":
        await this.pinCurrentSession();
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
      case "runs":
        this.showTaskRuns();
        break;
      case "undo":
        await this.undoTaskRun(command.taskRunId).catch((error) => {
          this.commitError(`Unable to undo run: ${error instanceof Error ? error.message : String(error)}`);
          this.setStatus("Undo failed");
        });
        break;
      case "steer":
        await this.steerQueuedPrompt(command.promptId);
        break;
      case "queue":
        this.retryQueuedPrompts();
        break;
      case "attach":
        await this.attachWorkspaceContext(command.attachmentType, command.path);
        break;
      case "attachments":
        this.managePendingAttachments(command.action, command.index);
        break;
      case "plan":
        if (command.action === "arm") {
          this.nextPromptPlanMode = true;
          this.commitSystem("Plan mode armed for the next prompt. It will use read-only discovery tools and require review.");
          this.setStatus("Plan mode armed");
        } else if (command.action === "run") {
          const plan = this.resolveTaskRunId(this.currentSession, command.taskRunId!);
          if (!plan?.planMode?.enabled || plan.planReview?.status !== "approved" || !plan.plan)
            throw new Error("Approve a captured plan before running it.");
          this.nextPromptApprovedPlanTaskRunId = plan.id;
          this.nextPromptWorktreeMode = true;
          this.commitSystem(`Approved plan ${plan.id} armed for a new managed worktree. Send the implementation prompt next.`);
          this.setStatus("Approved plan worktree armed");
        } else {
          this.reviewPlan(command.action, command.taskRunId!);
        }
        break;
      case "loop":
        if (command.action === "arm") {
          this.nextPromptLoopMaxIterations = command.maxIterations;
          this.commitSystem(`Loop mode armed for the next prompt (${command.maxIterations} iterations maximum).`);
          this.setStatus("Loop mode armed");
        } else if (this.currentSession?.agentLoop?.status === "running") {
          this.currentSession.agentLoop.stopRequested = true;
          this.currentSession.updatedAt = new Date().toISOString();
          await this.store.save(this.currentSession);
          this.setStatus("Loop will stop after its current iteration", true);
        } else {
          this.commitError("There is no running loop to stop.");
          this.setStatus("Loop stop unavailable");
        }
        break;
      case "worktree":
        if (command.action === "arm") {
          this.nextPromptWorktreeMode = true;
          this.commitSystem("Task worktree mode armed for the next prompt.");
          this.setStatus("Worktree mode armed");
        } else if (command.action === "run" || command.action === "replay") {
          const run = this.resolveTaskRunId(this.currentSession, command.taskRunId!);
          if (!run?.worktree?.enabled || run.worktree.status !== "ready")
            throw new Error("Only a ready managed worktree can be continued.");
          let replayOfTaskRunId: string | undefined;
          if (command.action === "replay") {
            const replay = this.resolveTaskRunId(this.currentSession, command.replayOfTaskRunId!);
            if (
              !replay?.worktree?.enabled ||
              replay.worktree.path !== run.worktree.path ||
              replay.worktree.branch !== run.worktree.branch
            ) {
              throw new Error("Replay evidence must belong to the same managed worktree.");
            }
            replayOfTaskRunId = replay.id;
          }
          this.nextPromptWorktreeContinuation = { taskRunId: run.id, replayOfTaskRunId };
          this.commitSystem(`Worktree continuation armed for ${run.id}. Send the repair prompt next.`);
          this.setStatus("Worktree continuation armed");
        } else {
          await this.applyWorktreeAction(command.action, command.taskRunId!);
        }
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

  private async manageToolAvailability(action: "list" | "enable" | "disable", name?: string) {
    const runtime = this.activeRuntimeControl;
    const available = this.tuiToolNames();
    runtime?.setAvailableToolNames(available);
    if (action === "list") {
      const disabled = new Set(await (runtime?.disabledToolNames() ?? createDisabledToolsReader(this.config.disabledTools ?? [])()));
      this.commitSystem(
        [
          "Tools:",
          ...available.map((tool) => `  ${disabled.has(tool) ? "disabled" : "enabled "}  ${tool}`),
          "",
          "Use /tools disable <tool> or /tools enable <tool>. Changes are saved and refresh at every tool-call boundary.",
          "Control tools (ask_user and arivu_*) cannot be disabled."
        ].join("\n")
      );
      this.setStatus(`${available.length} tools available`);
      return;
    }
    const tool = name?.trim();
    if (!tool) throw new Error("A tool name is required.");
    if (!available.includes(tool)) throw new Error(`Unknown tool: ${tool}`);
    if (tool === "ask_user" || tool.startsWith("arivu_"))
      throw new Error(`${tool} is part of Arivu's control boundary and cannot be disabled.`);
    const saved = await loadConfig({ includeEnv: false });
    const disabled = new Set(normalizeDisabledTools(saved.disabledTools ?? []));
    if (action === "disable") disabled.add(tool);
    else disabled.delete(tool);
    await saveConfig({ ...saved, disabledTools: [...disabled] });
    this.config = { ...this.config, disabledTools: [...disabled] };
    this.commitSystem(
      `${tool} ${action === "disable" ? "disabled" : "enabled"} in saved tool settings. ${this.busy ? "The active run refreshes this at its next tool boundary." : "It applies to the next run."}`
    );
    this.setStatus(`Tool ${action}d`);
  }

  private tuiToolNames() {
    const registry = createToolRegistry({
      workspaceRoot: this.workspace.root,
      approvals: new ApprovalManager(
        this.config.trustMode,
        async () => false,
        workspacePolicyOverridesForRoot(this.config, this.workspace.root),
        undefined,
        workspaceScopeRulesForRoot(this.config, this.workspace.root),
        this.workspace.root
      ),
      webSearchProvider: resolveWebSearchProvider(this.config),
      mcpServers: this.config.mcpServers,
      scopePolicyRules: workspaceScopeRulesForRoot(this.config, this.workspace.root),
      browser: this.browserControllerForSession(),
      manualBrowserTools: true,
      directEditReview: true,
      runtimeControl: this.activeRuntimeControl
    });
    return registry.schemas.map((tool) => tool.name).sort();
  }

  private async manageMcpIntegrations(action: "list" | "install" | "enable" | "disable" | "reject" | "remove", id?: string) {
    const saved = await loadConfig({ includeEnv: false });
    if (action === "list") {
      const proposals = ((saved.toolProposals ?? []) as McpToolProposal[]).map(safeMcpProposalDisplay);
      const integrations = Object.entries(saved.mcpServers).map(([name, server]) => {
        const integration = server as { command: string; args: string[]; env?: Record<string, string>; disabled?: boolean };
        return {
          name,
          command: "configured executable",
          argCount: integration.args.length,
          envKeys: Object.keys(integration.env ?? {}),
          enabled: !integration.disabled
        };
      });
      this.commitSystem(
        [
          "MCP integrations (commands never display credential values):",
          ...(integrations.length
            ? integrations.map(
                (server) =>
                  `  ${server.enabled ? "enabled " : "disabled"}  ${server.name}: ${server.command} (${server.argCount} argument${server.argCount === 1 ? "" : "s"}) ${server.envKeys.length ? `[keys: ${server.envKeys.join(", ")}]` : ""}`
              )
            : ["  No installed MCP integrations."]),
          "",
          "Pending review proposals:",
          ...(proposals.length
            ? proposals.map(
                (proposal) =>
                  `  ${proposal.id}  ${proposal.name}: ${proposal.command} ${proposal.args.join(" ")} ${proposal.envKeys.length ? `[keys: ${proposal.envKeys.join(", ")}]` : ""}\n    ${proposal.reason}`
              )
            : ["  No pending proposals."]),
          "",
          "Install keeps a proposal disabled. Use /integrations enable <server-name> only after reviewing its command and credential keys."
        ].join("\n")
      );
      this.setStatus(`${proposals.length} MCP proposal${proposals.length === 1 ? "" : "s"} pending`);
      return;
    }
    if (!id?.trim())
      throw new Error(`Usage: /integrations ${action} <${action === "install" || action === "reject" ? "proposal-id" : "server-name"}>`);
    const result = await reviewMcpProposal(id.trim(), action);
    this.config = configForSession(await loadConfig(), this.currentSession);
    this.agent = this.createAgent(this.currentSession);
    if (result.action === "install")
      this.commitSystem(`${result.serverName} installed disabled. Add its requested credentials in saved settings before enabling it.`);
    else if (result.action === "reject") this.commitSystem(`Rejected MCP proposal ${result.name}.`);
    else if (result.action === "remove") this.commitSystem(`Removed MCP integration ${result.name}.`);
    else this.commitSystem(`${result.name} ${result.enabled ? "enabled" : "disabled"}.`);
    this.setStatus(`MCP integration ${result.action}d`);
  }

  private composePromptContent(value: string): ChatContent {
    const text = promptTextWithFileContext(value, this.pendingFileContexts);
    if (this.pendingAttachments.length === 0) return text;
    return [textPart(text), ...this.pendingAttachments];
  }

  private async attachWorkspaceContext(kind: "file" | "image", value: string) {
    const workspaceRoot = await realpath(this.workspace.root);
    const candidate = path.resolve(workspaceRoot, value);
    const candidateRelative = path.relative(workspaceRoot, candidate);
    if (candidateRelative.startsWith("..") || path.isAbsolute(candidateRelative)) {
      throw new Error("Attachments must stay inside the workspace root.");
    }
    const target = await realpath(candidate);
    const relative = path.relative(workspaceRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Attachments must stay inside the workspace root.");
    const targetStat = await stat(target);
    if (!targetStat.isFile()) throw new Error("Attachments must be regular files.");
    if (kind === "file") {
      if (this.pendingFileContexts.length >= MAX_CONTEXT_FILE_ATTACHMENTS)
        throw new Error(`At most ${MAX_CONTEXT_FILE_ATTACHMENTS} files can be attached.`);
      if (targetStat.size > MAX_CONTEXT_FILE_BYTES) throw new Error("Text attachments are limited to 256 KB.");
      const bytes = await readFile(target);
      const text = bytes.toString("utf8");
      if (text.includes("\0")) throw new Error("Only UTF-8 text files can be attached as context.");
      const truncated = text.length > MAX_CONTEXT_FILE_CHARS;
      this.pendingFileContexts.push({
        path: relative,
        lineCount: countAttachmentLines(truncated ? text.slice(0, MAX_CONTEXT_FILE_CHARS) : text),
        content: truncated ? text.slice(0, MAX_CONTEXT_FILE_CHARS) : text,
        truncated
      });
    } else {
      if (this.pendingAttachments.length >= MAX_IMAGE_ATTACHMENTS)
        throw new Error(`At most ${MAX_IMAGE_ATTACHMENTS} images can be attached.`);
      if (targetStat.size > MAX_IMAGE_BYTES) throw new Error("Images are limited to 10 MB.");
      const bytes = await readFile(target);
      const mimeType = imageMimeTypeForPath(target);
      if (!mimeType) throw new Error("Images must be PNG, JPEG, WebP, or GIF.");
      this.pendingAttachments.push({
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${bytes.toString("base64")}`, detail: "auto" },
        name: path.basename(target),
        mimeType,
        size: bytes.length
      });
    }
    this.commitSystem(`Attached ${kind} ${relative} to the next prompt.`);
    this.setStatus(`${this.pendingAttachmentCount()} attachment${this.pendingAttachmentCount() === 1 ? "" : "s"} ready`);
  }

  private managePendingAttachments(action: "list" | "clear" | "remove", index?: number) {
    if (action === "clear") {
      this.pendingAttachments.length = 0;
      this.pendingFileContexts.length = 0;
      this.commitSystem("Cleared pending attachments.");
    } else if (action === "remove") {
      if (!index || index > this.pendingAttachmentCount()) throw new Error("Attachment number was not found.");
      if (index <= this.pendingFileContexts.length) this.pendingFileContexts.splice(index - 1, 1);
      else this.pendingAttachments.splice(index - this.pendingFileContexts.length - 1, 1);
      this.commitSystem(`Removed attachment ${index}.`);
    } else {
      const files = this.pendingFileContexts.map(
        (file, index) => `${index + 1}. [File] ${file.path}${file.truncated ? " (truncated)" : ""}`
      );
      const images = this.pendingAttachments.map(
        (part, index) =>
          `${this.pendingFileContexts.length + index + 1}. [Image] ${part.type === "image_url" ? (part.name ?? "image") : "attachment"}`
      );
      this.commitSystem([...files, ...images].join("\n") || "No pending attachments.");
    }
    this.setStatus(`${this.pendingAttachmentCount()} attachment${this.pendingAttachmentCount() === 1 ? "" : "s"} ready`);
  }

  private pendingAttachmentCount() {
    return this.pendingFileContexts.length + this.pendingAttachments.length;
  }

  private async reviewPlan(action: "approve" | "revise" | "cancel", taskRunId: string) {
    const taskRun = this.resolveTaskRunId(this.currentSession, taskRunId);
    if (!taskRun?.planMode?.enabled || !taskRun.plan) throw new Error("This task run has no captured plan to review.");
    if (taskRun.status === "running") throw new Error("Wait for the plan run to finish before reviewing it.");
    const now = new Date().toISOString();
    taskRun.planReview = {
      status: action === "approve" ? "approved" : action === "revise" ? "revision_requested" : "cancelled",
      updatedAt: now
    };
    taskRun.updatedAt = now;
    if (this.currentSession) {
      this.currentSession.updatedAt = now;
      await this.store.save(this.currentSession);
    }
    this.commitSystem(`Plan ${taskRun.id} ${action === "revise" ? "marked for revision" : `${action}d`}.`);
    this.setStatus(`Plan ${action}d`);
  }

  private async applyWorktreeAction(action: Exclude<Extract<TuiSlashCommand, { kind: "worktree" }>["action"], "arm">, taskRunId: string) {
    const session = this.currentSession;
    const taskRun = this.resolveTaskRunId(session, taskRunId);
    if (!session || !taskRun?.worktree?.enabled) throw new Error("This task run does not have a managed worktree.");
    if (taskRun.status === "running") throw new Error("Wait for the task run to finish before changing its worktree.");
    const worktree = taskRun.worktree;
    try {
      if (action === "status") {
        worktree.diff = await summarizeTaskWorktree(worktree);
        worktree.patchPreview = undefined;
        worktree.error = undefined;
      } else if (action === "preview") {
        if (worktree.status !== "ready") throw new Error("Only ready task worktrees can be previewed.");
        if (worktree.conflict) throw new Error("Resolve or abort the task worktree conflict before previewing.");
        const result = await previewTaskWorktreePatch(worktree);
        worktree.diff = result.diff;
        worktree.patchPreview = result.patchPreview;
        worktree.error = undefined;
      } else if (action === "merge") {
        if (worktree.status !== "ready") throw new Error("Only ready task worktrees can be merged.");
        if (worktree.conflict) throw new Error("Resolve or abort the task worktree conflict before merging.");
        const result = await mergeTaskWorktree(worktree, { taskRunId: taskRun.id, verification: taskRun.verification });
        worktree.status = result.status;
        worktree.diff = result.diff;
        worktree.mergeCommit = result.mergeCommit;
        worktree.mergedAt = result.mergedAt;
        worktree.conflict = undefined;
        worktree.patchPreview = undefined;
        worktree.error = undefined;
      } else if (action === "sync") {
        if (worktree.status !== "ready") throw new Error("Only ready task worktrees can be synced.");
        const result = await syncTaskWorktreeWithOriginal(worktree, { taskRunId: taskRun.id });
        worktree.diff = result.diff;
        worktree.conflict = result.conflict;
        worktree.patchPreview = undefined;
        worktree.pullRequest = undefined;
        worktree.error = result.conflict?.message;
      } else if (action === "continue") {
        if (worktree.status !== "ready") throw new Error("Only ready task worktrees can continue conflict resolution.");
        const result = await continueTaskWorktreeConflict(worktree);
        worktree.diff = result.diff;
        worktree.conflict = undefined;
        worktree.patchPreview = undefined;
        worktree.pullRequest = undefined;
        worktree.error = undefined;
      } else if (action === "abort") {
        if (worktree.status !== "ready") throw new Error("Only ready task worktrees can abort conflict resolution.");
        const result = await abortTaskWorktreeConflict(worktree);
        worktree.diff = result.diff;
        worktree.conflict = undefined;
        worktree.patchPreview = undefined;
        worktree.pullRequest = undefined;
        worktree.error = undefined;
      } else if (action === "discard") {
        if (!["ready", "failed"].includes(worktree.status)) throw new Error("Only ready or failed task worktrees can be discarded.");
        const result = await discardTaskWorktree(worktree);
        Object.assign(worktree, result);
        worktree.error = undefined;
      } else if (action === "cleanup") {
        const result = await cleanupMergedTaskWorktree(worktree);
        Object.assign(worktree, result);
        worktree.error = undefined;
      } else if (action === "prepare_pr") {
        if (worktree.conflict) throw new Error("Resolve or abort the task worktree conflict before preparing a PR draft.");
        const result = await prepareTaskWorktreePullRequest(worktree, {
          taskRunId: taskRun.id,
          promptPreview: taskRun.promptPreview,
          verification: taskRun.verification
        });
        worktree.diff = result.diff;
        worktree.pullRequest = result.pullRequest;
        worktree.conflict = undefined;
        worktree.error = undefined;
      } else if (action === "create_pr") {
        if (worktree.conflict) throw new Error("Resolve or abort the task worktree conflict before creating a PR.");
        const result = await createTaskWorktreePullRequest(worktree, { verification: taskRun.verification });
        worktree.pullRequest = result.pullRequest;
        worktree.error = undefined;
      } else if (action === "refresh_pr") {
        const result = await refreshTaskWorktreePullRequest(worktree);
        worktree.pullRequest = result.pullRequest;
        worktree.error = undefined;
      } else if (action === "checks") {
        await fetchTaskWorktreePullRequestCheckLogs(taskRun, worktree);
        worktree.error = undefined;
      }
    } catch (error) {
      worktree.error = error instanceof Error ? error.message : String(error);
      taskRun.updatedAt = session.updatedAt = new Date().toISOString();
      await this.store.save(session);
      throw error;
    }
    taskRun.updatedAt = session.updatedAt = new Date().toISOString();
    await this.store.save(session);
    this.commitSystem(`Worktree ${taskRun.id}: ${action} complete.`);
    this.setStatus(`Worktree ${action} complete`);
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
        `Armed: plan=${this.nextPromptPlanMode ? "review" : this.nextPromptApprovedPlanTaskRunId ? `approved worktree ${shortId(this.nextPromptApprovedPlanTaskRunId)}` : "none"}; loop=${this.nextPromptLoopMaxIterations ?? "off"}; worktree=${this.nextPromptWorktreeMode ? "on" : "off"}`,
        `Composer: ${this.pendingAttachmentCount()} attachment(s); ${this.promptQueue.length} queued${this.queueStartupBlocked ? " (startup paused; /queue retry)" : ""}`,
        this.lastRunUsage
          ? `Last run tokens: ${this.lastRunUsage.totalTokens} total (${this.lastRunUsage.promptTokens} prompt / ${this.lastRunUsage.completionTokens} completion) over ${this.lastRunUsage.requestCount} request${this.lastRunUsage.requestCount === 1 ? "" : "s"}`
          : "Last run tokens: not reported"
      ].join("\n")
    );
    this.setStatus("Status");
  }

  private async startNewSession() {
    this.cancelModelOperation();
    this.currentSession = undefined;
    this.promptQueue.length = 0;
    this.pendingQueuedInput = undefined;
    this.queueStartupBlocked = false;
    this.pendingAttachments.length = 0;
    this.pendingFileContexts.length = 0;
    this.nextPromptPlanMode = false;
    this.nextPromptApprovedPlanTaskRunId = undefined;
    this.nextPromptLoopMaxIterations = undefined;
    this.nextPromptWorktreeMode = false;
    this.nextPromptWorktreeContinuation = undefined;
    try {
      this.config = configForSession(await loadConfig(), undefined);
    } catch {
      // Keep the last effective runtime rather than regressing to constructor-time settings.
    }
    this.resetBrowserController();
    this.agent = this.createAgent();
    this.currentContextTokens = undefined;
    this.send({ type: "reset", data: this.buildInitData() });
    this.setStatus("New session");
  }

  private async deleteCurrentSession() {
    if (!this.currentSession) {
      this.commitSystem("No saved session to delete.");
      this.setStatus("No session");
      return;
    }
    const id = this.currentSession.id;
    if (!(await this.confirm(`Delete saved session ${shortId(id)}? This cannot be undone.`))) {
      this.setStatus("Delete cancelled");
      return;
    }
    await this.store.delete(id);
    await this.startNewSession();
    this.commitSystem(`Deleted session ${shortId(id)}.`);
  }

  private async renameCurrentSession(title: string) {
    if (!this.currentSession) {
      this.commitError("Send a prompt before renaming this session.");
      this.setStatus("No session");
      return;
    }
    const normalized = title.trim().slice(0, 160);
    if (!normalized) {
      this.commitError("A session title is required.");
      this.setStatus("Rename failed");
      return;
    }
    this.currentSession.title = normalized;
    this.currentSession.updatedAt = new Date().toISOString();
    await this.store.save(this.currentSession);
    this.send({ type: "reset", data: this.buildInitData() });
    this.setStatus("Session renamed");
  }

  private async pinCurrentSession() {
    if (!this.currentSession) {
      this.commitError("Send a prompt before pinning this session.");
      this.setStatus("No session");
      return;
    }
    this.currentSession.pinnedAt = this.currentSession.pinnedAt ? undefined : new Date().toISOString();
    this.currentSession.updatedAt = new Date().toISOString();
    await this.store.save(this.currentSession);
    this.send({ type: "reset", data: this.buildInitData() });
    this.setStatus(this.currentSession.pinnedAt ? "Session pinned" : "Session unpinned");
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

  private showTaskRuns() {
    const runs = this.currentSession?.taskRuns ?? [];
    if (runs.length === 0) {
      this.commitSystem("No task runs have been recorded in this session yet.");
      this.setStatus("Task runs");
      return;
    }
    this.send({
      type: "modal",
      title: "Task-run evidence",
      body: [
        ...runs
          .slice(-20)
          .reverse()
          .map((run) => {
            const approvals = run.approvals?.length ?? 0;
            const checkpoint = run.checkpoint
              ? ` · checkpoint ${run.checkpoint.revertedAt ? "reverted" : `${run.checkpoint.changedPaths.length} paths`}`
              : "";
            return [
              `${run.id}  ${run.status}  ${run.promptPreview}`,
              `model: ${run.model ?? "unknown"}${run.modelSelectionReason ? ` (${run.modelSelectionReason})` : ""}`,
              `tools: ${run.tools.length} · artifacts: ${run.artifacts.length} · approvals: ${approvals}${checkpoint}`,
              run.loop
                ? `loop: ${run.loop.status} · iteration ${run.loop.iteration}/${run.loop.maxIterations}${run.loop.lastDecision ? ` · ${run.loop.lastDecision}` : ""}`
                : undefined,
              run.planMode ? `plan: ${run.planReview?.status ?? "awaiting review"}` : undefined,
              run.worktree ? `worktree: ${run.worktree.status}${run.worktree.branch ? ` · ${run.worktree.branch}` : ""}` : undefined,
              run.verification ? `verification: ${run.verification.status}` : undefined,
              run.error ? `error: ${run.error}` : undefined
            ]
              .filter(Boolean)
              .join("\n");
          }),
        ...(this.currentSession?.queuedPrompts?.length
          ? [
              "Queued prompts:",
              ...this.currentSession.queuedPrompts.map(
                (prompt) => `${prompt.id}  ${prompt.state}  ${chatContentToText(prompt.content).slice(0, 180)}`
              )
            ]
          : [])
      ].join("\n\n")
    });
    this.setStatus("Task runs");
  }

  private async steerQueuedPrompt(promptId: string) {
    if (!this.busy || !this.currentSession) {
      this.commitError("There is no active run to steer.");
      this.setStatus("Steering unavailable");
      return;
    }
    try {
      const prompt = markPromptForSteering(this.currentSession, promptId);
      // Retain the FIFO entry until the Agent reports that it actually consumed
      // the message. If the turn ends before a safe boundary, it will be run as
      // the next ordinary prompt; removing it here would strand a `steering`
      // durable record without any foreground handoff.
      this.currentSession.updatedAt = new Date().toISOString();
      await this.store.save(this.currentSession);
      this.commitSystem(`Queued prompt ${prompt.id} will steer the active run at its next safe model boundary.`);
      this.setStatus("Steering queued", true);
    } catch (error) {
      this.commitError(`Unable to steer queued prompt: ${error instanceof Error ? error.message : String(error)}`);
      this.setStatus("Steering failed", true);
    }
  }

  private dropConsumedQueuedInputs() {
    const pendingIds = new Set((this.currentSession?.queuedPrompts ?? []).map((prompt) => prompt.id));
    for (let index = this.promptQueue.length - 1; index >= 0; index -= 1) {
      const entry = this.promptQueue[index];
      if (entry?.kind === "prompt" && entry.queuedPromptId && !pendingIds.has(entry.queuedPromptId)) {
        this.promptQueue.splice(index, 1);
      }
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
      this.runAbortController = undefined;
      // Summary owns the same foreground slot as a prompt. Use the regular handoff so
      // messages submitted while it was running do not get stranded in the FIFO queue.
      this.finishForegroundRun();
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
    const previous = {
      session: this.currentSession,
      config: this.config,
      cwd: this.cwd,
      workspace: this.workspace,
      agent: this.agent,
      browserController: this.browserController,
      browserSessionKey: this.browserSessionKey
    };
    try {
      const session = await this.store.load(sessionId);
      const baseConfig = await loadConfig();
      this.currentSession = session;
      this.resetBrowserController(session.id);
      this.config = configForSession(baseConfig, session);
      this.cwd = session.cwd;
      this.workspace = await detectWorkspace(this.cwd);
      this.agent = this.createAgent(session);
      this.promptQueue.length = 0;
      this.pendingQueuedInput = undefined;
      this.queuedDispatchGeneration += 1;
      this.queueStartupBlocked = false;
      this.pendingAttachments.length = 0;
      this.pendingFileContexts.length = 0;
      this.nextPromptPlanMode = false;
      this.nextPromptApprovedPlanTaskRunId = undefined;
      this.nextPromptLoopMaxIterations = undefined;
      this.nextPromptWorktreeMode = false;
      this.nextPromptWorktreeContinuation = undefined;
      this.restoreDurablePromptQueue();
      this.currentContextTokens = undefined;
      this.send({ type: "reset", data: this.buildInitData() });
      this.setStatus(`Resumed session ${shortId(session.id)}`);
      if (this.promptQueue.length > 0) {
        this.finishForegroundRun();
      }
    } catch (error) {
      this.currentSession = previous.session;
      this.config = previous.config;
      this.cwd = previous.cwd;
      this.workspace = previous.workspace;
      this.agent = previous.agent;
      this.browserController = previous.browserController;
      this.browserSessionKey = previous.browserSessionKey;
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
        // The terminal renderer is intentionally compact, but the decision must still
        // include the structured evidence desktop shows instead of a raw prompt alone.
        message: request ? formatNativeApprovalEvidence(request, message) : message,
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

  private elicit(request: ElicitationRequest): Promise<ElicitationResponse> {
    return new Promise<ElicitationResponse>((resolve) => {
      const id = randomUUID();
      this.elicitationResolvers.set(id, resolve);
      this.elicitationRequests.set(id, request);
      this.send({
        type: "elicitation",
        id,
        title: request.title,
        reason: request.reason,
        questions: request.questions.map(nativeElicitationQuestion)
      });
    });
  }

  private resolveAllElicitations() {
    for (const resolve of this.elicitationResolvers.values()) {
      resolve({ status: "declined", note: "The terminal UI closed before the questions were answered." });
    }
    this.elicitationResolvers.clear();
    this.elicitationRequests.clear();
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
      this.resolveAllElicitations();
      this.resolveAllApprovals(false);
      this.runAbortController.abort(new AgentRunAbortedError());
      this.setStatus("Stopping", true);
      return;
    }
    if (this.pendingQueuedInput) {
      const pending = this.pendingQueuedInput;
      this.pendingQueuedInput = undefined;
      this.queuedDispatchGeneration += 1;
      if (pending.kind === "prompt" && pending.queuedPromptId && this.currentSession) {
        this.currentSession.queuedPrompts = (this.currentSession.queuedPrompts ?? []).filter(
          (prompt) => prompt.id !== pending.queuedPromptId
        );
        this.currentSession.updatedAt = new Date().toISOString();
        this.pendingQueueCancellation = this.store.save(this.currentSession);
      }
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
      if (label.startsWith("Unable to run queued") && this.busy && !this.runAbortController) {
        this.busy = false;
        this.finishForegroundRun();
      }
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
    this.resolveAllElicitations();
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
    command.kind === "delete" ||
    command.kind === "model" ||
    command.kind === "new" ||
    command.kind === "pin" ||
    command.kind === "rename" ||
    command.kind === "undo" ||
    command.kind === "continue" ||
    command.kind === "resume" ||
    command.kind === "summarize" ||
    command.kind === "plan" ||
    command.kind === "worktree" ||
    (command.kind === "integrations" && command.action !== "list") ||
    (command.kind === "sessions" && Boolean(command.pick))
  );
}

export function configForSession(config: AppConfig, session?: AgentSession): AppConfig {
  if (!session) {
    return config;
  }
  const baseUrl = session.baseUrl ?? config.baseUrl;
  const normalizedBaseUrl = normalizeCapabilityBaseUrl(baseUrl);
  const selected = session.selectedProviderId
    ? config.providers.find((candidate) => candidate.id === session.selectedProviderId)
    : undefined;
  const provider =
    selected && normalizeCapabilityBaseUrl(selected.baseUrl) === normalizedBaseUrl
      ? selected
      : config.providers.find(
          (candidate) =>
            normalizeCapabilityBaseUrl(candidate.baseUrl) === normalizedBaseUrl && (!session.model || candidate.model === session.model)
        );
  return {
    ...config,
    model: session.model ?? config.model,
    baseUrl,
    trustMode: session.trustMode,
    ...(provider
      ? {
          apiKey:
            provider.apiKey ??
            (normalizeCapabilityBaseUrl(provider.baseUrl) === normalizeCapabilityBaseUrl(config.baseUrl) ? config.apiKey : undefined),
          toolCalling: provider.toolCalling,
          imageInput: provider.imageInput,
          activeProviderId: provider.id
        }
      : session.baseUrl && normalizeCapabilityBaseUrl(session.baseUrl) !== normalizeCapabilityBaseUrl(config.baseUrl)
        ? { apiKey: undefined }
        : {})
  };
}

function taskRunStatusForLoop(loop: AgentSession["agentLoop"]): AgentTaskRun["status"] {
  switch (loop?.status) {
    case "stopped":
      return "stopped";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "max_iterations":
      return "max_iterations";
    default:
      return "completed";
  }
}

function shortId(id: string) {
  return id.slice(0, 8);
}

function nativeElicitationQuestion(question: ElicitationRequest["questions"][number]): NativeElicitationQuestion {
  return {
    id: question.id,
    type: question.type,
    label: question.label,
    description: question.description,
    required: question.required,
    options: question.options,
    allow_other: question.allowOther,
    placeholder: question.placeholder,
    min: question.min,
    max: question.max,
    min_count: question.minCount,
    max_count: question.maxCount
  };
}

function formatNativeApprovalEvidence(request: ApprovalPromptRequest, fallback: string) {
  const preview = request.changePreview;
  return [
    request.label || fallback,
    `Capability: ${request.capability}`,
    request.reason ? `Policy: ${request.reason}` : undefined,
    request.scope
      ? `Scope: ${request.scope.label}${request.scope.value ? ` — ${request.scope.value}` : ""}${request.scope.detail ? `\n${request.scope.detail}` : ""}`
      : undefined,
    preview
      ? [
          `Change preview: ${preview.title}${preview.summary ? ` — ${preview.summary}` : ""}`,
          preview.path ? `Path: ${preview.path}` : undefined,
          preview.diff ? preview.diff : undefined,
          preview.content ? preview.content : undefined,
          preview.original ? `Original:\n${preview.original}` : undefined
        ]
          .filter(Boolean)
          .join("\n")
      : undefined,
    request.risky ? "Risk: elevated" : undefined,
    "\nApprove? Enter/Y = approve · Esc/N = deny"
  ]
    .filter(Boolean)
    .join("\n\n");
}

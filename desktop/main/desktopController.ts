import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dialog, shell, type WebContents } from "electron";
import { execa } from "execa";
import { Agent } from "../../src/agent/Agent.js";
import { ChangeCheckpoint, type ChangeCheckpointEntry } from "../../src/tools/changeCheckpoint.js";
import {
  applyContextCompactionCheckpoint,
  clearContextCompactionCheckpoint,
  compactSessionMessages,
  contextMessagesForSession
} from "../../src/agent/contextCompaction.js";
import { chatContentHasRenderableContent, chatContentToText, trimChatContent } from "../../src/agent/content.js";
import { buildTaskRunReportRemediationInstruction } from "../../src/agent/reportRemediation.js";
import { createSkill, discoverSkills, globalSkillsDir, type CreateSkillInput, type SkillSummary } from "../../src/agent/skills.js";
import {
  OpenAICompatibleChatClient,
  type ApiRequestLogEntry,
  type ProviderCapabilityObservation
} from "../../src/agent/OpenAICompatibleChatClient.js";
import {
  MAX_PROMPT_IMAGE_ATTACHMENTS as MAX_IMAGE_ATTACHMENTS,
  normalizePromptLoopOptions,
  normalizePromptPayload,
  normalizePromptPlanOptions,
  normalizePromptRetryFromUserMessageIndex,
  normalizePromptReuseLastUserMessage,
  normalizePromptSkillNames,
  normalizePromptWorktreeOptions,
  type PromptImageAttachment as ImageAttachment,
  type PromptPayload
} from "../../src/agent/promptPayload.js";
import {
  isAutoModel,
  providerCandidatesFromConfig,
  resolveModelForPrompt,
  type ModelProviderCandidate,
  type ModelSelection
} from "../../src/agent/modelRouter.js";
import {
  enqueuePrompt,
  markPromptForSteering,
  restoreQueuedPrompt,
  takeNextQueuedPrompt,
  takeSteeringMessages
} from "../../src/agent/queuedPrompts.js";
import {
  beginAgentLoopIteration,
  createAgentTaskRun,
  finishAgentLoopIteration,
  finishTaskRun,
  markTaskRunRunning,
  recordTaskRunApproval,
  recordTaskRunAssistantCompletion,
  recordTaskRunAssistantPlan,
  recordTaskRunEvent,
  syncTaskRunLoopState,
  trimTaskRuns,
  upsertTaskRunCommandArtifact
} from "../../src/agent/taskRuns.js";
import {
  abortTaskWorktreeConflict,
  cleanupMergedTaskWorktree,
  continueTaskWorktreeConflict,
  createTaskWorktreePullRequest,
  createTaskWorktree,
  discardTaskWorktree,
  mergeTaskWorktree,
  prepareTaskWorktreePullRequest,
  previewTaskWorktreePatch,
  refreshTaskWorktreePullRequest,
  resolveTaskWorktreePath,
  summarizeTaskWorktree,
  syncTaskWorktreeWithOriginal,
  taskWorktreeInstruction
} from "../../src/agent/taskWorktree.js";
import type {
  AgentLoopState,
  AgentRunEvent,
  AgentRunOptions,
  AgentSession,
  AgentTaskRun,
  AgentTaskRunApprovalEvent,
  AgentTaskRunVerificationStatus,
  AgentTaskRunWorktreeStatus,
  ChatMessage,
  ChatUsage,
  QueuedPrompt
} from "../../src/agent/types.js";
import { AgentRunAbortedError } from "../../src/agent/types.js";
import {
  appDataDir,
  applyProviderCapabilityObservation,
  loadConfig,
  mergeRedactedMcpServers,
  resolveModelListEndpoint,
  resolveWebSearchProvider,
  saveConfig,
  workspacePolicyOverridesForRoot,
  workspaceScopeRulesForRoot,
  type AppConfig,
  type McpToolProposal
} from "../../src/config.js";
import { resolveBrowserTaskContextWindowTokens, resolveBrowserTaskModel } from "../../src/agent/browserTaskModel.js";
import { ModelCatalogStore } from "../../src/models/ModelCatalogStore.js";
import { resolveContextWindowTokens } from "../../src/models/contextResolver.js";
import { recordContextFromRuntime } from "../../src/models/syncModelCatalog.js";
import { runDoctor, type DoctorReport } from "../../src/diagnostics/doctor.js";
import { ApprovalManager } from "../../src/permissions/ApprovalManager.js";
import { describeCapabilityPolicies } from "../../src/permissions/capabilityPolicy.js";
import type { CapabilityPolicyOverrides } from "../../src/permissions/capabilityPolicy.js";
import { scopePolicyHasRules } from "../../src/permissions/scopePolicy.js";
import { SessionStore } from "../../src/sessions/SessionStore.js";
import {
  detachSessionFromProject,
  sessionBelongsToProject,
  sessionDisplayTitle,
  sessionProjectRoot
} from "../../src/sessions/sessionList.js";
import { resolveSafeWorkspacePath } from "../../src/tools/pathSafety.js";
import { createToolRegistry } from "../../src/tools/registry.js";
import type { RuntimeMcpServerProposalInput, RuntimeMcpServerProposalResult } from "../../src/tools/runtimeControl.js";
import type { BrowserState, BrowserTaskModelConfig } from "../../src/tools/browserControl.js";
import { detectWorkspace, type WorkspaceInfo } from "../../src/workspace.js";
import type { DesktopBrowserController } from "./browserController.js";
import {
  applyConfigPatch,
  createDisabledToolsReader,
  mergeBrowserTaskModelPatch,
  mergeBrowserVisualGroundingPatch,
  normalizeDisabledTools,
  normalizeMcpServerProposalInput,
  normalizeProviders,
  normalizeWebSearchProviders,
  preserveProviderKeys,
  sanitizeSettingsInt,
  toPublicConfig,
  updateProviderRuntime,
  type ConfigPatch,
  type PublicConfig
} from "./configBridge.js";
import {
  applyModelSelectionToSession,
  configForModelSelection,
  continuationAgentLoopInstruction,
  createAgentLoopState,
  createDesktopSession,
  desktopContextState,
  finishAgentLoop,
  initialAgentLoopInstruction,
  justChatsCwd,
  justChatsPath,
  lastAssistantMessage,
  lastAssistantMessageIndex,
  planningApprovalInstruction,
  planReviewStatusForAction,
  publicModelSelection,
  publicModelSelectionForSession,
  stripAgentLoopDecision,
  taskRunStatusForLoop,
  updateSessionRuntimeFromConfig,
  type DesktopContextState,
  type PublicModelSelection
} from "./desktopSessionRuntime.js";
import {
  isAllowedBrowserScreenshotPath,
  readContextFileAttachment,
  readImageAttachment,
  type ContextFileAttachment,
  type LocalImageResult
} from "./desktopAttachments.js";
import type { DesktopInteractionBroker } from "./desktopInteractionBroker.js";
import { readWorkspacePolicyBundleFromRoot, type WorkspacePolicyBundleResult } from "./workspacePolicyFile.js";
import { RuntimeControlService } from "./runtimeControlService.js";
import {
  parseSavedPullRequestCheckLogCommand,
  safeArtifactSegment,
  shortHash,
  taskRunArtifactIncludesEvidencePath,
  taskRunExecutionRoot,
  truncateInlineText
} from "./taskRunEvidence.js";
import { toolParameterNames, toolStatus, type ToolSummary } from "./toolPresentation.js";
import { normalizeScaffoldOptions, scaffoldWorkspace, type WorkspaceScaffoldOptions } from "./workspaceScaffold.js";

const PLAN_MODE_TOOL_NAMES = ["list", "read", "search", "git_status", "current_datetime", "current_location", "list_skills", "read_skill"];
const MAX_CONTEXT_FILE_ATTACHMENTS = 6;
const MODEL_LIST_CACHE_TTL_MS = 10 * 60 * 1000;
const AUTO_MODEL_LIST_TIMEOUT_MS = 4_000;
const MANUAL_MODEL_LIST_TIMEOUT_MS = 10_000;
const MODEL_LIST_BODY_LIMIT_BYTES = 256 * 1024;

export type DesktopState = {
  cwd: string;
  projectRoot: string | null;
  workspace: WorkspaceInfo;
  config: PublicConfig;
  browser: BrowserState;
  runningSessionIds: string[];
  modelSelection?: PublicModelSelection;
  agentLoop?: AgentLoopState;
  taskRuns?: AgentTaskRun[];
  sessionId?: string;
  context: DesktopContextState;
  queuedPrompts: QueuedPrompt[];
  messages: ChatMessage[];
};

export type CapabilityPolicyResult = {
  currentTrustMode: AppConfig["trustMode"];
  source: "built-in" | "workspace";
  workspaceRoot: string;
  workspaceOverrides: CapabilityPolicyOverrides;
  workspaceScopeRules: AppConfig["workspacePolicies"][string]["scopeRules"];
  policies: ReturnType<typeof describeCapabilityPolicies>;
};

export type SkillListResult = {
  skills: SkillSummary[];
  skillsRoot: string;
};

export type SkillCreateResult = SkillListResult & {
  skill: SkillSummary;
};

export type SessionSummary = {
  id: string;
  title: string;
  pinnedAt?: string;
  cwd: string;
  projectRoot: string | null;
  projectRootExists?: boolean;
  model?: string;
  modelMode?: "manual" | "auto";
  selectedModel?: string;
  selectedProviderName?: string;
  modelSelectionReason?: string;
  agentLoop?: AgentLoopState;
  taskRuns?: AgentTaskRun[];
  trustMode: AppConfig["trustMode"];
  messageCount: number;
  running: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TaskWorktreeActionInput = {
  sessionId?: string;
  taskRunId?: string;
  action?:
    | "open"
    | "refresh"
    | "preview"
    | "merge"
    | "discard"
    | "cleanup"
    | "prepare_pr"
    | "create_pr"
    | "refresh_pr"
    | "fetch_pr_check_logs"
    | "sync"
    | "continue_conflict"
    | "abort_conflict"
    | "open_conflict_file";
  conflictPath?: string;
};

export type SessionUpdateInput = {
  id?: string;
  title?: string;
  pinned?: boolean;
};

export type TaskRunPlanActionInput = {
  sessionId?: string;
  taskRunId?: string;
  action?: "approve" | "request_revision" | "cancel";
};

export type TaskWorktreeInventoryItem = {
  sessionId: string;
  sessionTitle: string;
  taskRunId: string;
  promptPreview: string;
  status: AgentTaskRun["status"];
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

export type OpenTaskRunEvidenceInput = {
  sessionId?: string;
  taskRunId?: string;
  artifactId?: string;
  path?: string;
  line?: number;
};

export type SessionLifecycleEvent = {
  type: "started" | "updated" | "completed" | "failed";
  sessionId: string;
  messages: ChatMessage[];
  sessions: SessionSummary[];
  runningSessionIds: string[];
  modelSelection?: PublicModelSelection;
  agentLoop?: AgentLoopState;
  taskRuns?: AgentTaskRun[];
  context: DesktopContextState;
  queuedPrompts: QueuedPrompt[];
  output?: string;
  error?: string;
};

export type CompactContextResult = {
  state: DesktopState;
  compacted: boolean;
  compactedMessageCount: number;
  remainingMessageCount: number;
};

export type ModelListResponse = {
  data?: Array<{
    id?: string;
  }>;
};

export type DesktopControllerDependencies = {
  browserController: DesktopBrowserController;
  interactionBroker: DesktopInteractionBroker;
  recordApiRequestLogEntry: (entry: ApiRequestLogEntry) => void;
  emitSessionLifecycleEvent: (event: SessionLifecycleEvent) => void;
};

export class DesktopController {
  private session: AgentSession | undefined;
  private readonly store = new SessionStore();
  private readonly runningSessionIds = new Set<string>();
  private readonly loopStopRequests = new Set<string>();
  private readonly runAbortControllers = new Map<string, AbortController>();
  /** Canonical in-memory session objects currently owned by running Agent instances. */
  private readonly activeRunSessions = new Map<string, AgentSession>();
  /** Lets the headless bench entry await a run that sendPrompt intentionally fire-and-forgets. */
  private readonly runCompletions = new Map<string, Promise<void>>();
  private readonly modelListCache = new Map<string, { models: string[]; fetchedAt: number }>();
  private readonly sessionDisabledTools = new Map<string, Set<string>>();
  private readonly sessionBrowserModelOverrides = new Map<string, BrowserTaskModelConfig>();
  private activeViewRevision = 0;
  private cwd: string;
  private projectRoot: string | null;

  private readonly modelCatalogStore = new ModelCatalogStore();

  constructor(private readonly dependencies: DesktopControllerDependencies) {
    this.cwd = justChatsPath();
    this.projectRoot = null;
  }

  async state(): Promise<DesktopState> {
    const config = await this.effectiveConfig();
    return {
      cwd: this.cwd,
      projectRoot: this.projectRoot,
      workspace: await detectWorkspace(this.cwd),
      config: toPublicConfig(config),
      browser: this.dependencies.browserController.getState(),
      runningSessionIds: Array.from(this.runningSessionIds),
      modelSelection: publicModelSelectionForSession(this.session),
      agentLoop: this.session?.agentLoop,
      taskRuns: this.session?.taskRuns,
      sessionId: this.session?.id,
      context: desktopContextState(this.session),
      queuedPrompts: this.session?.queuedPrompts ?? [],
      messages: this.session?.messages ?? []
    };
  }

  async chooseWorkspace() {
    const result = await dialog.showOpenDialog({
      title: "Open workspace",
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) {
      return this.state();
    }

    this.cwd = result.filePaths[0];
    this.projectRoot = result.filePaths[0];
    this.session = undefined;
    this.markActiveViewChanged();
    return this.state();
  }

  async openWorkspace(workspaceRoot: string) {
    if (typeof workspaceRoot !== "string" || workspaceRoot.trim().length === 0) {
      throw new Error("Workspace path is required.");
    }

    const nextRoot = path.resolve(workspaceRoot);
    if (!(await pathExistsAsDirectory(nextRoot))) {
      throw new Error(`Workspace is unavailable: ${nextRoot}`);
    }

    this.cwd = nextRoot;
    this.projectRoot = nextRoot;
    this.session = undefined;
    this.markActiveViewChanged();
    return this.state();
  }

  async chooseImages(): Promise<{ images: ImageAttachment[] }> {
    const result = await dialog.showOpenDialog({
      title: "Attach images",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "gif"]
        }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { images: [] };
    }

    const selected = result.filePaths.slice(0, MAX_IMAGE_ATTACHMENTS);
    const images = await Promise.all(selected.map(readImageAttachment));
    return { images };
  }

  async readLocalImage(filePath: string): Promise<LocalImageResult> {
    const target = path.resolve(filePath);
    if (!isAllowedBrowserScreenshotPath(target)) {
      throw new Error("This image path is not available for preview.");
    }
    const image = await readImageAttachment(target);
    return {
      mimeType: image.mimeType,
      size: image.size,
      dataUrl: image.dataUrl
    };
  }

  async chooseContextFiles(): Promise<{ files: ContextFileAttachment[] }> {
    if (!this.projectRoot) {
      throw new Error("Open a workspace before attaching file context.");
    }

    const result = await dialog.showOpenDialog({
      title: "Attach file context",
      defaultPath: this.projectRoot,
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Text and code",
          extensions: [
            "txt",
            "md",
            "markdown",
            "json",
            "jsonc",
            "yaml",
            "yml",
            "toml",
            "js",
            "jsx",
            "ts",
            "tsx",
            "css",
            "scss",
            "html",
            "xml",
            "py",
            "rb",
            "go",
            "rs",
            "java",
            "kt",
            "swift",
            "c",
            "h",
            "cpp",
            "hpp",
            "cs",
            "sh",
            "zsh",
            "bash"
          ]
        },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { files: [] };
    }

    const selected = result.filePaths.slice(0, MAX_CONTEXT_FILE_ATTACHMENTS);
    const files = await Promise.all(selected.map((filePath) => readContextFileAttachment(this.projectRoot!, filePath)));
    return { files };
  }

  async createWorkspace(options: WorkspaceScaffoldOptions = {}) {
    const result = await dialog.showSaveDialog({
      title: "Create workspace",
      buttonLabel: "Create workspace",
      defaultPath: path.join(os.homedir(), "arivu-workspace"),
      properties: ["createDirectory"]
    });
    if (result.canceled || !result.filePath) {
      return this.state();
    }

    await mkdir(result.filePath, { recursive: true });
    await scaffoldWorkspace(result.filePath, normalizeScaffoldOptions(options));
    this.cwd = result.filePath;
    this.projectRoot = result.filePath;
    this.session = undefined;
    this.markActiveViewChanged();
    return this.state();
  }

  async openJustChats() {
    this.cwd = await justChatsCwd();
    this.projectRoot = null;
    this.session = undefined;
    this.markActiveViewChanged();
    return this.state();
  }

  async newChat() {
    this.cwd = await justChatsCwd();
    this.projectRoot = null;
    this.session = undefined;
    this.markActiveViewChanged();
    return this.state();
  }

  async selectChatProject(projectRoot: string | null) {
    if (this.session?.messages.some((message) => message.role !== "system")) {
      throw new Error("Project selection is locked after a chat starts.");
    }

    this.session = undefined;
    if (projectRoot === null) {
      this.cwd = await justChatsCwd();
      this.projectRoot = null;
      this.markActiveViewChanged();
      return this.state();
    }

    const nextRoot = path.resolve(projectRoot);
    if (!(await pathExistsAsDirectory(nextRoot))) {
      throw new Error(`Project is unavailable: ${nextRoot}`);
    }

    this.cwd = nextRoot;
    this.projectRoot = nextRoot;
    this.markActiveViewChanged();
    return this.state();
  }

  async listSessions(): Promise<{ sessions: SessionSummary[] }> {
    return {
      sessions: await this.sessionSummaries()
    };
  }

  async forgetMissingProject(projectRoot: string) {
    const normalizedProjectRoot = path.resolve(projectRoot);
    if (await pathExistsAsDirectory(normalizedProjectRoot)) {
      throw new Error(`Workspace still exists: ${normalizedProjectRoot}`);
    }

    const sessions = await this.store.list();
    const matching = sessions.filter((session) => sessionBelongsToProject(session, normalizedProjectRoot, { legacyCwdAsProject: true }));
    if (matching.length === 0) {
      return this.state();
    }

    const running = matching.find((session) => this.runningSessionIds.has(session.id));
    if (running) {
      throw new Error(`Wait for "${sessionDisplayTitle(running)}" to finish before forgetting this workspace.`);
    }

    const fallbackCwd = await justChatsCwd();
    const detachedSessions = new Map<string, AgentSession>();
    for (const session of matching) {
      const detached = detachSessionFromProject(session, fallbackCwd);
      detachedSessions.set(detached.id, detached);
      await this.store.save(detached);
    }

    if (this.session && detachedSessions.has(this.session.id)) {
      this.session = detachedSessions.get(this.session.id);
      this.cwd = fallbackCwd;
      this.projectRoot = null;
      this.markActiveViewChanged();
    }

    return this.state();
  }

  async openSession(id: string) {
    this.session = this.activeRunSessions.get(id) ?? (await this.store.load(id));
    this.cwd = this.session.cwd;
    this.projectRoot = this.session.projectRoot === undefined ? this.session.cwd : this.session.projectRoot;
    this.markActiveViewChanged();
    const state = await this.state();
    if (!this.runningSessionIds.has(id) && this.session.queuedPrompts?.length) {
      void this.startNextQueuedPrompt(id);
    }
    return state;
  }

  async deleteSession(id: string) {
    if (this.runningSessionIds.has(id)) {
      throw new Error("Wait for this chat to finish before deleting it.");
    }
    await this.store.delete(id);
    await rm(path.join(appDataDir(), "checkpoints", id), { recursive: true, force: true });
    this.sessionDisabledTools.delete(id);
    this.sessionBrowserModelOverrides.delete(id);
    if (this.session?.id === id) {
      this.session = undefined;
      this.markActiveViewChanged();
    }
    return this.state();
  }

  async updateSession(input: SessionUpdateInput) {
    const id = typeof input.id === "string" ? input.id : "";
    if (!id) {
      throw new Error("Session id is required.");
    }
    if (this.runningSessionIds.has(id)) {
      throw new Error("Wait for this chat to finish before changing it.");
    }

    const current = await this.store.load(id);
    const next: AgentSession = { ...current };
    if (input.title !== undefined) {
      next.title = normalizeSessionTitle(input.title);
    }
    if (input.pinned !== undefined) {
      if (input.pinned) {
        next.pinnedAt = new Date().toISOString();
      } else {
        delete next.pinnedAt;
      }
    }

    await this.store.save(next);
    if (this.session?.id === id) {
      this.session = next;
    }
    return this.state();
  }

  async compactContext(): Promise<CompactContextResult> {
    if (this.session?.id && this.runningSessionIds.has(this.session.id)) {
      throw new Error("Agent is already running in this chat.");
    }
    if (!this.session) {
      throw new Error("No active chat to compact.");
    }

    const compactedAt = new Date();
    const result = compactSessionMessages(contextMessagesForSession(this.session), { now: compactedAt });
    if (result.compacted) {
      const compactedSession: AgentSession = {
        ...this.session,
        updatedAt: compactedAt.toISOString()
      };
      applyContextCompactionCheckpoint(compactedSession, result, "deterministic", compactedAt);
      this.session = compactedSession;
      await this.store.save(this.session);
    }

    return {
      state: await this.state(),
      compacted: result.compacted,
      compactedMessageCount: result.compactedMessageCount,
      remainingMessageCount: result.remainingMessageCount
    };
  }

  async summarizeContext(): Promise<CompactContextResult> {
    if (this.session?.id && this.runningSessionIds.has(this.session.id)) {
      throw new Error("Agent is already running in this chat.");
    }
    if (!this.session) {
      throw new Error("No active chat to summarize.");
    }

    const session = this.session;
    const config = await loadConfig();
    const policyWorkspace = await detectWorkspace(session.cwd);
    const approvals = new ApprovalManager(
      config.trustMode,
      (message, request) => this.dependencies.interactionBroker.requestApproval(message, request),
      workspacePolicyOverridesForRoot(config, policyWorkspace.root),
      undefined,
      workspaceScopeRulesForRoot(config, policyWorkspace.root),
      policyWorkspace.root
    );
    const contextWindowTokens = resolveContextWindowTokens(
      config,
      { model: config.model, baseUrl: config.baseUrl },
      await this.modelCatalogStore.load()
    );
    const agent = new Agent({
      client: new OpenAICompatibleChatClient({
        ...config,
        onRequestLog: this.dependencies.recordApiRequestLogEntry,
        captureRequestBodies: true
      }),
      approvals,
      cwd: session.cwd,
      projectRoot: session.projectRoot,
      model: config.model,
      baseUrl: config.baseUrl,
      webSearchProvider: resolveWebSearchProvider(config),
      mcpServers: config.mcpServers,
      customInstructions: config.customSystemPrompt,
      minStepIntervalMs: config.chatModelRequestDelayMs,
      contextWindowTokens,
      onContextWindowObserved: (tokens) =>
        recordContextFromRuntime(this.modelCatalogStore, { baseUrl: config.baseUrl, model: config.model }, tokens),
      session
    });

    const result = await agent.summarizeContext();
    if (result.compacted) {
      session.updatedAt = new Date().toISOString();
      await this.store.save(session);
      if (this.session?.id === session.id) {
        this.session = session;
      }
    }

    return {
      state: await this.state(),
      compacted: result.compacted,
      compactedMessageCount: result.compactedMessageCount,
      remainingMessageCount: result.remainingMessageCount
    };
  }

  async stopAgentLoop(sessionId = this.session?.id) {
    if (!sessionId) {
      throw new Error("No active loop to stop.");
    }

    this.loopStopRequests.add(sessionId);
    let target = this.session?.id === sessionId ? this.session : undefined;
    if (!target) {
      target = await this.store.load(sessionId);
    }
    if (!target.agentLoop || !["running", "stopping"].includes(target.agentLoop.status)) {
      return this.state();
    }

    target.agentLoop = {
      ...target.agentLoop,
      status: "stopping",
      stopRequested: true,
      updatedAt: new Date().toISOString()
    };
    target.updatedAt = target.agentLoop.updatedAt;
    await this.store.save(target);
    if (this.session?.id === target.id) {
      this.session = target;
    }
    await this.sendSessionLifecycleEvent("updated", target);
    return this.state();
  }

  async listTaskWorktrees(): Promise<{ worktrees: TaskWorktreeInventoryItem[] }> {
    const sessions = await this.store.list();
    const worktrees: TaskWorktreeInventoryItem[] = [];
    for (const session of sessions) {
      for (const run of session.taskRuns ?? []) {
        const worktree = run.worktree;
        if (!worktree?.enabled) {
          continue;
        }
        const folderExists = worktree.path ? await pathExistsAsDirectory(worktree.path) : false;
        const mutationLocked = ["queued", "running"].includes(run.status) || this.runningSessionIds.has(session.id);
        const verificationBlocked = run.verification?.status === "failed";
        const conflictBlocked = Boolean(worktree.conflict);
        const hasManagedIdentity = Boolean(worktree.originalRoot && worktree.path && worktree.branch);
        worktrees.push({
          sessionId: session.id,
          sessionTitle: sessionDisplayTitle(session),
          taskRunId: run.id,
          promptPreview: run.promptPreview,
          status: run.status,
          verificationStatus: run.verification?.status,
          verificationSummary: run.verification?.summary,
          worktreeStatus: worktree.status,
          branch: worktree.branch,
          path: worktree.path,
          folderExists,
          canOpen: folderExists && Boolean(worktree.path) && !["discarded", "cleaned"].includes(worktree.status),
          canPreparePullRequest:
            !verificationBlocked &&
            !conflictBlocked &&
            !mutationLocked &&
            folderExists &&
            hasManagedIdentity &&
            worktree.status === "ready" &&
            Boolean(worktree.patchPreview) &&
            !worktree.pullRequest?.url,
          canCreatePullRequest:
            !verificationBlocked &&
            !conflictBlocked &&
            !mutationLocked &&
            folderExists &&
            hasManagedIdentity &&
            worktree.status === "ready" &&
            Boolean(worktree.pullRequest?.remoteName && worktree.pullRequest.baseBranch && !worktree.pullRequest.url),
          canDiscard: !mutationLocked && hasManagedIdentity && ["ready", "failed"].includes(worktree.status),
          canCleanup: !mutationLocked && hasManagedIdentity && worktree.status === "merged",
          pullRequestTitle: worktree.pullRequest?.title,
          pullRequestPreparedAt: worktree.pullRequest?.preparedAt,
          pullRequestUrl: worktree.pullRequest?.url,
          changedFiles: worktree.diff?.files,
          updatedAt: run.updatedAt,
          createdAt: worktree.createdAt
        });
      }
    }
    return {
      worktrees: worktrees.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    };
  }

  async taskWorktreeAction(input: TaskWorktreeActionInput = {}) {
    const sessionId = typeof input.sessionId === "string" && input.sessionId.trim() ? input.sessionId.trim() : this.session?.id;
    const taskRunId = typeof input.taskRunId === "string" && input.taskRunId.trim() ? input.taskRunId.trim() : undefined;
    const action = input.action;
    if (!sessionId) {
      throw new Error("No active chat for task worktree action.");
    }
    if (!taskRunId) {
      throw new Error("Task run id is required.");
    }
    if (
      !action ||
      ![
        "open",
        "refresh",
        "preview",
        "merge",
        "discard",
        "cleanup",
        "prepare_pr",
        "create_pr",
        "refresh_pr",
        "fetch_pr_check_logs",
        "sync",
        "continue_conflict",
        "abort_conflict",
        "open_conflict_file"
      ].includes(action)
    ) {
      throw new Error("Unsupported task worktree action.");
    }

    const session = this.session?.id === sessionId ? this.session : await this.store.load(sessionId);
    const taskRun = this.findTaskRun(session, taskRunId);
    if (!taskRun?.worktree?.enabled) {
      throw new Error("This task run does not have a worktree.");
    }
    if (!["open", "refresh", "refresh_pr", "open_conflict_file"].includes(action) && this.runningSessionIds.has(session.id)) {
      throw new Error("Wait for the agent to finish before changing a task worktree.");
    }
    if (!["open", "refresh", "refresh_pr", "open_conflict_file"].includes(action) && ["queued", "running"].includes(taskRun.status)) {
      throw new Error("Wait for this task run to finish before changing its worktree.");
    }

    const worktree = taskRun.worktree;
    try {
      if (action === "open") {
        const target = await resolveTaskWorktreePath(worktree);
        const targetStat = await stat(target);
        if (!targetStat.isDirectory()) {
          throw new Error("Task worktree target is not a folder.");
        }
        const error = await shell.openPath(target);
        if (error) {
          throw new Error(error);
        }
        return this.state();
      } else if (action === "open_conflict_file") {
        if (!worktree.conflict) {
          throw new Error("No task worktree conflict is currently recorded.");
        }
        const conflictPath = typeof input.conflictPath === "string" ? input.conflictPath.trim() : "";
        if (!conflictPath) {
          throw new Error("Conflict file path is required.");
        }
        if (!worktree.conflict.files.includes(conflictPath)) {
          throw new Error("Conflict file is not recorded on this task worktree.");
        }
        const worktreeRoot = await resolveTaskWorktreePath(worktree);
        const target = await resolveSafeWorkspacePath(worktreeRoot, conflictPath);
        const targetStat = await stat(target);
        if (!targetStat.isFile()) {
          throw new Error("Conflict file target is not a file.");
        }
        const error = await shell.openPath(target);
        if (error) {
          throw new Error(error);
        }
        return this.state();
      } else if (action === "refresh") {
        worktree.diff = await summarizeTaskWorktree(worktree);
        worktree.patchPreview = undefined;
        worktree.error = undefined;
      } else if (action === "preview") {
        if (worktree.status !== "ready") {
          throw new Error("Only ready task worktrees can be previewed.");
        }
        if (worktree.conflict) {
          throw new Error("Resolve or abort the task worktree conflict before previewing.");
        }
        const result = await previewTaskWorktreePatch(worktree);
        worktree.diff = result.diff;
        worktree.patchPreview = result.patchPreview;
        worktree.error = undefined;
      } else if (action === "merge") {
        if (worktree.status !== "ready") {
          throw new Error("Only ready task worktrees can be merged.");
        }
        if (worktree.conflict) {
          throw new Error("Resolve or abort the task worktree conflict before merging.");
        }
        const result = await mergeTaskWorktree(worktree, { taskRunId: taskRun.id, verification: taskRun.verification });
        worktree.status = result.status;
        worktree.diff = result.diff;
        worktree.mergeCommit = result.mergeCommit;
        worktree.mergedAt = result.mergedAt;
        worktree.conflict = undefined;
        worktree.error = undefined;
      } else if (action === "prepare_pr") {
        if (worktree.conflict) {
          throw new Error("Resolve or abort the task worktree conflict before preparing a PR draft.");
        }
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
        if (worktree.conflict) {
          throw new Error("Resolve or abort the task worktree conflict before creating a PR.");
        }
        const result = await createTaskWorktreePullRequest(worktree, { verification: taskRun.verification });
        worktree.pullRequest = result.pullRequest;
        worktree.error = undefined;
      } else if (action === "refresh_pr") {
        const result = await refreshTaskWorktreePullRequest(worktree);
        worktree.pullRequest = result.pullRequest;
        worktree.error = undefined;
      } else if (action === "fetch_pr_check_logs") {
        await this.fetchPullRequestCheckLogs(taskRun, worktree);
        worktree.error = undefined;
      } else if (action === "sync") {
        if (worktree.status !== "ready") {
          throw new Error("Only ready task worktrees can be synced.");
        }
        const result = await syncTaskWorktreeWithOriginal(worktree, { taskRunId: taskRun.id });
        worktree.diff = result.diff;
        worktree.conflict = result.conflict;
        worktree.patchPreview = undefined;
        worktree.pullRequest = undefined;
        worktree.error = result.conflict?.message;
      } else if (action === "continue_conflict") {
        if (worktree.status !== "ready") {
          throw new Error("Only ready task worktrees can continue conflict resolution.");
        }
        const result = await continueTaskWorktreeConflict(worktree);
        worktree.diff = result.diff;
        worktree.conflict = undefined;
        worktree.patchPreview = undefined;
        worktree.pullRequest = undefined;
        worktree.error = undefined;
      } else if (action === "abort_conflict") {
        if (worktree.status !== "ready") {
          throw new Error("Only ready task worktrees can abort conflict resolution.");
        }
        const result = await abortTaskWorktreeConflict(worktree);
        worktree.diff = result.diff;
        worktree.conflict = undefined;
        worktree.patchPreview = undefined;
        worktree.pullRequest = undefined;
        worktree.error = undefined;
      } else if (action === "discard") {
        if (!["ready", "failed"].includes(worktree.status)) {
          throw new Error("Only ready or failed task worktrees can be discarded.");
        }
        const result = await discardTaskWorktree(worktree);
        worktree.status = result.status;
        worktree.discardedAt = result.discardedAt;
        worktree.error = undefined;
      } else {
        const result = await cleanupMergedTaskWorktree(worktree);
        worktree.status = result.status;
        worktree.cleanedAt = result.cleanedAt;
        worktree.error = undefined;
      }
    } catch (error) {
      worktree.error = formatError(error);
      taskRun.updatedAt = new Date().toISOString();
      session.updatedAt = taskRun.updatedAt;
      await this.store.save(session);
      if (this.session?.id === session.id) {
        this.session = session;
      }
      await this.sendSessionLifecycleEvent("updated", session);
      throw error;
    }

    taskRun.updatedAt = new Date().toISOString();
    session.updatedAt = taskRun.updatedAt;
    await this.store.save(session);
    if (this.session?.id === session.id) {
      this.session = session;
    }
    await this.sendSessionLifecycleEvent("updated", session);
    return this.state();
  }

  private async fetchPullRequestCheckLogs(taskRun: AgentTaskRun, worktree: NonNullable<AgentTaskRun["worktree"]>) {
    const pullRequest = worktree.pullRequest;
    const review = pullRequest?.review;
    if (!pullRequest?.url || !review?.checkItems?.length) {
      throw new Error("Refresh a created PR before fetching check evidence.");
    }
    const actionable = review.checkItems.filter(
      (item) => item.logCommand && (item.bucket === "failed" || item.bucket === "cancelled" || item.bucket === "unknown")
    );
    if (actionable.length === 0) {
      throw new Error("No failed, cancelled, or unknown PR check evidence commands are available.");
    }

    const cwd = await resolveTaskWorktreePath(worktree);
    for (const item of actionable) {
      const logCommand = item.logCommand;
      if (!logCommand) {
        continue;
      }
      const parsed = parseSavedPullRequestCheckLogCommand(logCommand);
      const artifactInputId =
        parsed.source === "github_actions"
          ? `pr-check-log:${safeArtifactSegment(item.name)}:${safeArtifactSegment(parsed.runId)}${
              parsed.jobId ? `:${safeArtifactSegment(parsed.jobId)}` : ""
            }`
          : `pr-check-details:${safeArtifactSegment(item.name)}:${shortHash(parsed.url)}`;
      const startedAt = Date.now();
      const now = new Date().toISOString();
      try {
        const result = await execa(parsed.file, parsed.args, { cwd, reject: false });
        const artifact = upsertTaskRunCommandArtifact(taskRun, {
          id: artifactInputId,
          title: parsed.source === "github_actions" ? `PR check log: ${item.name}` : `PR check details: ${item.name}`,
          command: logCommand,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs: Date.now() - startedAt,
          workingDirectory: cwd,
          executionProfile: "host",
          executionIsolation: "host",
          workspaceRoot: cwd,
          now
        });
        item.logArtifactId = artifact.id;
        item.logFetchedAt = now;
        item.logError =
          result.exitCode === 0 ? undefined : truncateInlineText(result.stderr || result.stdout || `Exit code ${result.exitCode}`, 240);
      } catch (error) {
        const message = formatError(error);
        const artifact = upsertTaskRunCommandArtifact(taskRun, {
          id: artifactInputId,
          title: parsed.source === "github_actions" ? `PR check log: ${item.name}` : `PR check details: ${item.name}`,
          command: logCommand,
          stderr: message,
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          workingDirectory: cwd,
          executionProfile: "host",
          executionIsolation: "host",
          workspaceRoot: cwd,
          now
        });
        item.logArtifactId = artifact.id;
        item.logFetchedAt = now;
        item.logError = truncateInlineText(message, 240);
      }
    }
  }

  async taskRunPlanAction(input: TaskRunPlanActionInput = {}) {
    const sessionId = typeof input.sessionId === "string" && input.sessionId.trim() ? input.sessionId.trim() : this.session?.id;
    const taskRunId = typeof input.taskRunId === "string" && input.taskRunId.trim() ? input.taskRunId.trim() : undefined;
    const action = input.action;
    if (!sessionId) {
      throw new Error("No active chat for plan action.");
    }
    if (!taskRunId) {
      throw new Error("Task run id is required.");
    }
    if (!action || !["approve", "request_revision", "cancel"].includes(action)) {
      throw new Error("Unsupported plan action.");
    }

    const session = this.session?.id === sessionId ? this.session : await this.store.load(sessionId);
    const taskRun = this.findTaskRun(session, taskRunId);
    if (!taskRun?.planMode?.enabled) {
      throw new Error("This task run is not a plan approval run.");
    }
    if (!taskRun.plan || (!taskRun.plan.summary && taskRun.plan.items.length === 0)) {
      throw new Error("This task run does not have a captured plan.");
    }
    if (this.runningSessionIds.has(session.id) || ["queued", "running"].includes(taskRun.status)) {
      throw new Error("Wait for the agent to finish before changing plan review state.");
    }

    const now = new Date().toISOString();
    taskRun.planReview = {
      status: planReviewStatusForAction(action),
      updatedAt: now
    };
    taskRun.updatedAt = now;
    session.updatedAt = now;
    await this.store.save(session);
    if (this.session?.id === session.id) {
      this.session = session;
    }
    await this.sendSessionLifecycleEvent("updated", session);
    return this.state();
  }

  async openTaskRunEvidence(input: OpenTaskRunEvidenceInput = {}) {
    const sessionId = typeof input.sessionId === "string" && input.sessionId.trim() ? input.sessionId.trim() : this.session?.id;
    const taskRunId = typeof input.taskRunId === "string" && input.taskRunId.trim() ? input.taskRunId.trim() : undefined;
    const artifactId = typeof input.artifactId === "string" && input.artifactId.trim() ? input.artifactId.trim() : undefined;
    const requestedPath = typeof input.path === "string" && input.path.trim() ? input.path.trim() : undefined;
    if (!sessionId) {
      throw new Error("No active chat for task-run evidence.");
    }
    if (!taskRunId || !artifactId || !requestedPath) {
      throw new Error("Task run id, artifact id, and evidence path are required.");
    }

    const session = this.session?.id === sessionId ? this.session : await this.store.load(sessionId);
    const taskRun = this.findTaskRun(session, taskRunId);
    const artifact = taskRun?.artifacts.find((candidate) => candidate.id === artifactId);
    if (!taskRun || !artifact) {
      throw new Error("Task-run evidence was not found.");
    }
    if (!taskRunArtifactIncludesEvidencePath(artifact, requestedPath)) {
      throw new Error("Evidence path is not attached to this task run.");
    }

    const workspaceRoot = taskRunExecutionRoot(session, taskRun);
    const target = await resolveSafeWorkspacePath(workspaceRoot, requestedPath);
    const targetStat = await stat(target);
    if (!targetStat.isFile() && !targetStat.isDirectory()) {
      throw new Error("Evidence target is not a file or folder.");
    }

    const error = await shell.openPath(target);
    if (error) {
      throw new Error(error);
    }
    return {
      path: target,
      line: typeof input.line === "number" && Number.isInteger(input.line) && input.line > 0 ? input.line : undefined
    };
  }

  async saveConfigPatch(patch: ConfigPatch) {
    const saved = await loadConfig({ includeEnv: false });
    const next: Partial<AppConfig> = {
      ...saved
    };
    let activeProviderId = patch.activeProviderId !== undefined ? patch.activeProviderId.trim() || undefined : next.activeProviderId;

    if (patch.providers) {
      next.providers = preserveProviderKeys(normalizeProviders(patch.providers, saved.providers), saved);
      if (activeProviderId && !next.providers.some((provider) => provider.id === activeProviderId)) {
        activeProviderId = next.providers[0]?.id;
      }
      if (!activeProviderId) {
        activeProviderId = next.providers[0]?.id;
      }
    }
    if (patch.activeProviderId !== undefined || patch.providers) {
      next.activeProviderId = activeProviderId;
    }
    let activeWebSearchProviderId =
      patch.activeWebSearchProviderId !== undefined ? patch.activeWebSearchProviderId.trim() || undefined : next.activeWebSearchProviderId;
    if (patch.webSearchProviders) {
      next.webSearchProviders = normalizeWebSearchProviders(patch.webSearchProviders, saved.webSearchProviders);
      if (activeWebSearchProviderId && !next.webSearchProviders.some((provider) => provider.id === activeWebSearchProviderId)) {
        activeWebSearchProviderId = next.webSearchProviders[0]?.id;
      }
      if (!activeWebSearchProviderId) {
        activeWebSearchProviderId = next.webSearchProviders[0]?.id;
      }
      // Once the provider manager writes canonical profiles, the legacy field must
      // stop shadowing a newly entered Tavily key on the next config load.
      next.tavilyApiKey = undefined;
    }
    if (patch.activeWebSearchProviderId !== undefined || patch.webSearchProviders) {
      next.activeWebSearchProviderId = activeWebSearchProviderId;
    }
    if (patch.baseUrl?.trim()) {
      next.baseUrl = patch.baseUrl.trim();
    }
    if (patch.model?.trim()) {
      next.model = patch.model.trim();
    }
    if (patch.toolCalling) {
      next.toolCalling = patch.toolCalling;
    }
    if (patch.imageInput) {
      next.imageInput = patch.imageInput;
    }
    if (patch.chatModelRequestDelayMs !== undefined) {
      next.chatModelRequestDelayMs = sanitizeSettingsInt(patch.chatModelRequestDelayMs, 0, 120_000);
    }
    if (patch.trustMode) {
      next.trustMode = patch.trustMode;
    }
    if (patch.apiKey?.trim()) {
      next.apiKey = patch.apiKey.trim();
    }
    if (patch.tavilyApiKey?.trim()) {
      next.tavilyApiKey = patch.tavilyApiKey.trim();
    }
    if (patch.mcpServers) {
      next.mcpServers = mergeRedactedMcpServers(patch.mcpServers, saved.mcpServers);
    }
    if (patch.workspacePolicies) {
      next.workspacePolicies = patch.workspacePolicies;
    }
    if (patch.workspacePolicyProfiles) {
      next.workspacePolicyProfiles = patch.workspacePolicyProfiles;
    }
    if (patch.browserTaskModel !== undefined) {
      next.browserTaskModel = mergeBrowserTaskModelPatch(saved.browserTaskModel, patch.browserTaskModel);
    }
    if (patch.browserVisualGrounding !== undefined) {
      next.browserVisualGrounding = mergeBrowserVisualGroundingPatch(saved.browserVisualGrounding, patch.browserVisualGrounding);
    }
    if (patch.disabledTools !== undefined) {
      next.disabledTools = normalizeDisabledTools(patch.disabledTools);
    }
    if (patch.toolProposals !== undefined) {
      next.toolProposals = patch.toolProposals;
    }
    if (activeProviderId && next.providers?.some((provider) => provider.id === activeProviderId)) {
      next.providers = updateProviderRuntime(next.providers, activeProviderId, patch);
      if (patch.activeProviderId !== undefined || patch.providers) {
        const activeProvider = next.providers.find((provider) => provider.id === activeProviderId);
        if (activeProvider) {
          next.baseUrl = activeProvider.baseUrl;
          next.model = activeProvider.model;
          next.toolCalling = activeProvider.toolCalling;
          next.imageInput = activeProvider.imageInput;
          next.contextWindowTokens = activeProvider.contextWindowTokens;
          next.apiKey = activeProvider.apiKey;
        }
      }
    }

    await saveConfig(next);
    this.session = this.session ? updateSessionRuntimeFromConfig(this.session, next) : undefined;
    if (this.session) {
      await this.store.save(this.session);
    }
    return this.state();
  }

  async listModels(patch: ConfigPatch = {}) {
    const config = await this.effectiveConfig();
    const { apiKey, baseUrl } = resolveModelListEndpoint(config, {
      providerId: patch.activeProviderId,
      baseUrl: patch.baseUrl,
      apiKey: patch.apiKey
    });
    if (!baseUrl) {
      throw new Error("Enter a provider base URL before loading models.");
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/models`, { headers }, MANUAL_MODEL_LIST_TIMEOUT_MS);
    const body = await readBoundedResponseText(response, MODEL_LIST_BODY_LIMIT_BYTES);

    if (!response.ok) {
      throw new Error(`Model list request failed (${response.status}): ${body}`);
    }

    const json = JSON.parse(body) as ModelListResponse;
    const models = (json.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => Boolean(id))
      .sort((left, right) => left.localeCompare(right));

    return { models };
  }

  async doctor(patch: ConfigPatch = {}): Promise<DoctorReport> {
    const config = applyConfigPatch(await this.effectiveConfig(), patch);
    const report = await runDoctor(config);
    await this.recordDoctorCapabilityObservations(report, {
      providerId: patch.activeProviderId,
      baseUrl: config.baseUrl
    });
    return report;
  }

  async listTools(): Promise<{ tools: ToolSummary[] }> {
    const config = await this.effectiveConfig();
    const workspace = await detectWorkspace(this.cwd);
    const policyOverrides = workspacePolicyOverridesForRoot(config, workspace.root);
    const scopePolicyRules = workspaceScopeRulesForRoot(config, workspace.root);
    const activeProvider = config.providers.find((provider) => provider.id === config.activeProviderId);
    const chatModel: ModelSelection = {
      mode: "manual",
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      toolCalling: config.toolCalling,
      imageInput: config.imageInput,
      providerId: config.activeProviderId,
      providerName: activeProvider?.name ?? "Active provider",
      task: "general",
      reason: "Current saved model"
    };
    const configuredBrowserTaskModel = resolveBrowserTaskModel(config, chatModel);
    const sessionId = this.session?.id;
    const sessionDisabledTools = sessionId ? (this.sessionDisabledTools.get(sessionId) ?? new Set<string>()) : new Set<string>();
    if (sessionId) {
      this.sessionDisabledTools.set(sessionId, sessionDisabledTools);
    }
    const runtimeControl = new RuntimeControlService({
      configuredBrowserTaskModel,
      activeBrowserTaskModel: (sessionId ? this.sessionBrowserModelOverrides.get(sessionId) : undefined) ?? configuredBrowserTaskModel,
      readSavedDisabledTools: createDisabledToolsReader(config.disabledTools ?? []),
      sessionDisabledTools,
      onSessionBrowserModelChange: (model) => {
        if (sessionId) {
          this.sessionBrowserModelOverrides.set(sessionId, model);
        }
      },
      onProposeMcpServer: (input) => this.proposeMcpServer(input)
    });
    const registry = createToolRegistry({
      workspaceRoot: workspace.root,
      approvals: new ApprovalManager(config.trustMode, async () => false, policyOverrides, undefined, scopePolicyRules, workspace.root),
      webSearchProvider: resolveWebSearchProvider(config),
      mcpServers: config.mcpServers,
      scopePolicyRules,
      browser: this.dependencies.browserController,
      browserTaskModel: configuredBrowserTaskModel,
      runtimeControl
    });
    runtimeControl.setAvailableToolNames(registry.schemas.map((schema) => schema.name));

    const disabledTools = new Set(await runtimeControl.disabledToolNames());
    return {
      tools: registry.schemas.map((schema) => ({
        name: schema.name,
        description: schema.description,
        parameters: toolParameterNames(schema),
        disabled: disabledTools.has(schema.name),
        ...toolStatus(schema.name, config, policyOverrides, scopePolicyRules)
      }))
    };
  }

  async listCapabilityPolicies(): Promise<CapabilityPolicyResult> {
    const config = await this.effectiveConfig();
    const workspace = await detectWorkspace(this.cwd);
    const workspaceOverrides = workspacePolicyOverridesForRoot(config, workspace.root);
    const workspaceScopeRules = workspaceScopeRulesForRoot(config, workspace.root);
    return {
      currentTrustMode: config.trustMode,
      source: Object.keys(workspaceOverrides).length > 0 || scopePolicyHasRules(workspaceScopeRules) ? "workspace" : "built-in",
      workspaceRoot: workspace.root,
      workspaceOverrides,
      workspaceScopeRules,
      policies: describeCapabilityPolicies(workspaceOverrides)
    };
  }

  async readWorkspacePolicyBundle(): Promise<WorkspacePolicyBundleResult> {
    const workspace = await detectWorkspace(this.cwd);
    return readWorkspacePolicyBundleFromRoot(workspace.root);
  }

  async listSkills(): Promise<SkillListResult> {
    return {
      skills: await discoverSkills(),
      skillsRoot: globalSkillsDir()
    };
  }

  async createSkill(input: CreateSkillInput): Promise<SkillCreateResult> {
    const skill = await createSkill(input);
    return {
      skill,
      skills: await discoverSkills(),
      skillsRoot: globalSkillsDir()
    };
  }

  async proposeMcpServer(input: RuntimeMcpServerProposalInput): Promise<RuntimeMcpServerProposalResult> {
    const saved = await loadConfig({ includeEnv: false });
    const normalized = normalizeMcpServerProposalInput(input);
    const existing = (saved.toolProposals ?? []).find(
      (proposal) =>
        proposal.name.toLowerCase() === normalized.name.toLowerCase() &&
        proposal.command === normalized.command &&
        JSON.stringify(proposal.args) === JSON.stringify(normalized.args)
    );
    if (existing) {
      return {
        id: existing.id,
        name: existing.name,
        status: "pending_review",
        reviewLocation: "Settings > Integrations"
      };
    }

    const proposal: McpToolProposal = {
      id: randomUUID(),
      kind: "mcp_server",
      ...normalized,
      createdAt: new Date().toISOString()
    };
    await saveConfig({
      ...saved,
      toolProposals: [proposal, ...(saved.toolProposals ?? [])].slice(0, 20)
    });
    return {
      id: proposal.id,
      name: proposal.name,
      status: "pending_review",
      reviewLocation: "Settings > Integrations"
    };
  }

  async sendPrompt(prompt: PromptPayload, eventTarget?: WebContents) {
    const content = normalizePromptPayload(prompt);
    const skillNames = normalizePromptSkillNames(prompt);
    const reuseLastUserMessage = normalizePromptReuseLastUserMessage(prompt);
    const retryFromUserMessageIndex = normalizePromptRetryFromUserMessageIndex(prompt);
    const planOptions = normalizePromptPlanOptions(prompt);
    const loopOptions = normalizePromptLoopOptions(prompt);
    const worktreeOptions = normalizePromptWorktreeOptions(prompt);
    const planModeEnabled = planOptions.enabled;
    if (!chatContentHasRenderableContent(content)) {
      throw new Error("Prompt is required.");
    }
    if (this.session?.id && this.runningSessionIds.has(this.session.id)) {
      throw new Error("Agent is already running in this chat.");
    }

    const originRevision = this.activeViewRevision;
    const originSession = this.session;
    const originProjectRoot = this.projectRoot;
    const originCwd = originProjectRoot === null ? await justChatsCwd() : this.cwd;
    const baseConfig = await this.effectiveConfig(originSession);
    const modelProviders = await this.modelProvidersForConfig(baseConfig);
    const modelSelection = resolveModelForPrompt(baseConfig, content, {
      session: originSession,
      providers: modelProviders
    });
    const browserTaskModel = resolveBrowserTaskModel(baseConfig, modelSelection);
    const config = configForModelSelection(baseConfig, modelSelection);
    const modelCatalog = await this.modelCatalogStore.load();
    // effectiveConfig resolved the window for the pre-selection model; auto routing may have just
    // picked a different one, so re-resolve for the model that will actually serve this run.
    config.contextWindowTokens = resolveContextWindowTokens(
      baseConfig,
      { model: modelSelection.model, baseUrl: modelSelection.baseUrl },
      modelCatalog
    );
    // browser_task can use a different provider/model from the chat turn. Resolve its native window
    // separately so it never inherits the base model's context cap (or the provider-wide fallback).
    browserTaskModel.contextWindowTokens = resolveBrowserTaskContextWindowTokens(
      baseConfig,
      modelSelection,
      browserTaskModel,
      modelCatalog
    );
    for (const fallbackModel of browserTaskModel.fallbacks ?? []) {
      fallbackModel.contextWindowTokens = resolveBrowserTaskContextWindowTokens(baseConfig, modelSelection, fallbackModel, modelCatalog);
    }
    const now = new Date().toISOString();
    const session = applyModelSelectionToSession(
      originSession
        ? {
            ...originSession,
            cwd: originCwd,
            projectRoot: originProjectRoot,
            trustMode: config.trustMode,
            messages: [...originSession.messages],
            updatedAt: now
          }
        : createDesktopSession(originCwd, originProjectRoot, config.trustMode),
      modelSelection
    );
    const trimmedContent = trimChatContent(content);
    if (retryFromUserMessageIndex !== undefined) {
      const retryMessage = session.messages[retryFromUserMessageIndex];
      if (retryMessage?.role !== "user") {
        throw new Error("Retry target user message was not found.");
      }
      if (JSON.stringify(trimChatContent(retryMessage.content)) !== JSON.stringify(trimmedContent)) {
        throw new Error("Retry target no longer matches the requested prompt.");
      }
      clearContextCompactionCheckpoint(session);
      session.messages = session.messages.slice(0, retryFromUserMessageIndex + 1);
      session.taskRuns = (session.taskRuns ?? []).filter((run) => run.userMessageIndex < retryFromUserMessageIndex);
    }
    const before = session.messages.length;
    const lastMessage = session.messages.at(-1);
    const loopState =
      !planModeEnabled && loopOptions.enabled ? createAgentLoopState(trimmedContent, loopOptions.maxIterations, now) : undefined;
    const canReuseLastUserMessage =
      (reuseLastUserMessage || retryFromUserMessageIndex !== undefined) &&
      lastMessage?.role === "user" &&
      JSON.stringify(trimChatContent(lastMessage.content)) === JSON.stringify(trimmedContent);
    if (loopState) {
      session.agentLoop = loopState;
      this.loopStopRequests.delete(session.id);
      const loopInstruction: ChatMessage = { role: "system", content: initialAgentLoopInstruction(loopState) };
      if (canReuseLastUserMessage) {
        session.messages.splice(Math.max(0, session.messages.length - 1), 0, loopInstruction);
      } else {
        session.messages.push(loopInstruction);
      }
    } else {
      session.agentLoop = undefined;
      this.loopStopRequests.delete(session.id);
    }
    if (planModeEnabled) {
      const planInstruction: ChatMessage = { role: "system", content: planningApprovalInstruction() };
      if (canReuseLastUserMessage) {
        session.messages.splice(Math.max(0, session.messages.length - 1), 0, planInstruction);
      } else {
        session.messages.push(planInstruction);
      }
    }
    let userMessageIndex: number;
    if (canReuseLastUserMessage) {
      lastMessage.content = trimmedContent;
      userMessageIndex = session.messages.indexOf(lastMessage);
    } else {
      userMessageIndex = session.messages.length;
      session.messages.push({ role: "user", content: trimmedContent, createdAt: now });
    }
    const taskRun = createAgentTaskRun({
      userMessageIndex: Math.max(0, userMessageIndex),
      prompt: trimmedContent,
      model: modelSelection.model,
      providerName: modelSelection.providerName,
      modelSelectionReason: modelSelection.reason,
      loop: loopState,
      planModeEnabled,
      worktreeEnabled: !planModeEnabled && worktreeOptions.enabled,
      now
    });
    let executionCwd = originCwd;
    if (!planModeEnabled && worktreeOptions.enabled) {
      const continuedRun = worktreeOptions.taskRunId ? this.findTaskRun(session, worktreeOptions.taskRunId) : undefined;
      const replayRun = worktreeOptions.replayOfTaskRunId ? this.findTaskRun(session, worktreeOptions.replayOfTaskRunId) : undefined;
      const plannedFromRun = worktreeOptions.plannedFromTaskRunId
        ? this.findTaskRun(session, worktreeOptions.plannedFromTaskRunId)
        : undefined;
      if (worktreeOptions.taskRunId && !continuedRun?.worktree?.enabled) {
        throw new Error("Task worktree to continue was not found.");
      }
      if (worktreeOptions.replayOfTaskRunId && !replayRun?.worktree?.enabled) {
        throw new Error("Task worktree replay evidence run was not found.");
      }
      if (worktreeOptions.plannedFromTaskRunId && !plannedFromRun?.planMode?.enabled) {
        throw new Error("Approved plan task run was not found.");
      }
      if (replayRun && !continuedRun?.worktree?.enabled) {
        throw new Error("Replay checks require an existing task worktree continuation.");
      }
      if (plannedFromRun && (continuedRun || replayRun)) {
        throw new Error("Approved plan worktree execution must start a new task worktree.");
      }
      if (plannedFromRun && plannedFromRun.planReview?.status !== "approved") {
        throw new Error("Approve the plan before starting task worktree execution.");
      }
      if (plannedFromRun && (!plannedFromRun.plan || (!plannedFromRun.plan.summary && plannedFromRun.plan.items.length === 0))) {
        throw new Error("Approved plan task run does not have a captured plan.");
      }
      if (continuedRun?.worktree?.enabled && continuedRun.worktree.status !== "ready") {
        throw new Error("Only ready task worktrees can be continued.");
      }
      const worktree = continuedRun?.worktree?.enabled
        ? {
            originalRoot: continuedRun.worktree.originalRoot ?? originCwd,
            path: await resolveTaskWorktreePath(continuedRun.worktree),
            branch: continuedRun.worktree.branch ?? "arivu/task-unknown",
            baseRef: continuedRun.worktree.baseRef ?? "unknown",
            createdAt: continuedRun.worktree.createdAt ?? now
          }
        : await createTaskWorktree({ cwd: originCwd, sessionId: session.id, taskRunId: taskRun.id });
      let replayOfTaskRunId: string | undefined;
      if (continuedRun?.worktree?.enabled && replayRun?.worktree?.enabled) {
        const replayPath = await resolveTaskWorktreePath(replayRun.worktree);
        if (path.resolve(replayPath) !== path.resolve(worktree.path) || replayRun.worktree.branch !== worktree.branch) {
          throw new Error("Replay evidence must belong to the same managed task worktree.");
        }
        replayOfTaskRunId = replayRun.id;
      }
      const worktreePathStat = await stat(worktree.path);
      if (!worktreePathStat.isDirectory()) {
        throw new Error("Task worktree target is not a folder.");
      }
      taskRun.worktree = continuedRun?.worktree?.enabled
        ? {
            enabled: true,
            status: "ready",
            originalRoot: worktree.originalRoot,
            path: worktree.path,
            branch: worktree.branch,
            baseRef: worktree.baseRef,
            createdAt: worktree.createdAt,
            continuedFromTaskRunId: continuedRun.id,
            replayOfTaskRunId
          }
        : {
            enabled: true,
            status: "ready",
            plannedFromTaskRunId: plannedFromRun?.id,
            ...worktree
          };
      executionCwd = worktree.path;
      const worktreeInstruction: ChatMessage = {
        role: "system",
        content: [
          taskWorktreeInstruction(worktree),
          plannedFromRun
            ? [
                `This prompt executes approved plan task run ${plannedFromRun.id} in a new task worktree. Keep changes scoped to that approved plan.`,
                "At the end of your final response, include a `Completion notes:` checklist with one bullet per approved plan item.",
                "Prefix each completion bullet with `Completed:`, `Needs evidence:`, or `Blocked:`.",
                "When possible, end each bullet with `[evidence: file=path; command=command; report=path; check=name]` using only labels that match actual work or verification evidence."
              ].join("\n")
            : undefined,
          continuedRun
            ? `This prompt continues existing task run ${continuedRun.id}. Keep the repair in the same task worktree.`
            : undefined,
          replayOfTaskRunId
            ? `This prompt replays verification evidence from task run ${replayOfTaskRunId}. Rerun the selected commands against the current task worktree and report the results.`
            : undefined
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n")
      };
      const instructionIndex = canReuseLastUserMessage ? session.messages.indexOf(lastMessage) : userMessageIndex;
      if (canReuseLastUserMessage) {
        session.messages.splice(
          instructionIndex >= 0 ? instructionIndex : Math.max(0, session.messages.length - 1),
          0,
          worktreeInstruction
        );
      } else {
        session.messages.splice(userMessageIndex, 0, worktreeInstruction);
      }
      taskRun.userMessageIndex += 1;
    }
    markTaskRunRunning(taskRun, now);
    session.taskRuns = trimTaskRuns([...(session.taskRuns ?? []), taskRun]);
    session.updatedAt = now;
    if (this.activeViewRevision === originRevision) {
      this.session = session;
      this.cwd = originCwd;
      this.projectRoot = originProjectRoot;
      this.markActiveViewChanged();
    }
    await this.store.save(session);
    this.runningSessionIds.add(session.id);
    this.activeRunSessions.set(session.id, session);
    await this.sendSessionLifecycleEvent("started", session);

    const runPromise = this.runPromptInBackground({
      session,
      content,
      skillNames,
      config,
      browserTaskModel,
      providerId: modelSelection.providerId,
      loopEnabled: Boolean(loopState),
      planModeEnabled,
      taskRunId: taskRun.id,
      executionCwd,
      eventTarget
    });
    this.runCompletions.set(session.id, runPromise);
    void runPromise.finally(() => {
      if (this.runCompletions.get(session.id) === runPromise) {
        this.runCompletions.delete(session.id);
      }
    });

    return {
      output: "",
      sessionId: session.id,
      messages: session.messages,
      newMessages: session.messages.slice(before),
      modelSelection: publicModelSelection(modelSelection),
      agentLoop: session.agentLoop,
      taskRuns: session.taskRuns,
      running: true
    };
  }

  async queuePrompt(prompt: PromptPayload) {
    const content = trimChatContent(normalizePromptPayload(prompt));
    if (!chatContentHasRenderableContent(content)) {
      throw new Error("Prompt is required.");
    }
    const sessionId = this.session?.id;
    if (!sessionId || !this.runningSessionIds.has(sessionId)) {
      throw new Error("Messages can only be queued while this chat is running.");
    }
    const session = this.activeRunSessions.get(sessionId) ?? this.session;
    if (!session) {
      throw new Error("The active chat could not be loaded.");
    }
    const now = new Date().toISOString();
    enqueuePrompt(session, {
      id: randomUUID(),
      content,
      skillNames: normalizePromptSkillNames(prompt),
      state: "queued",
      createdAt: now
    });
    session.updatedAt = now;
    this.session = session;
    await this.store.save(session);
    await this.sendSessionLifecycleEvent("updated", session);
    return this.state();
  }

  async steerQueuedPrompt(promptId: string) {
    const sessionId = this.session?.id;
    if (!sessionId || !this.runningSessionIds.has(sessionId)) {
      throw new Error("There is no active run to steer.");
    }
    const session = this.activeRunSessions.get(sessionId) ?? this.session;
    if (!session) {
      throw new Error("The active chat could not be loaded.");
    }
    markPromptForSteering(session, promptId);
    session.updatedAt = new Date().toISOString();
    this.session = session;
    await this.store.save(session);
    await this.sendSessionLifecycleEvent("updated", session);
    return this.state();
  }

  private async startNextQueuedPrompt(sessionId: string, eventTarget?: WebContents) {
    if (this.runningSessionIds.has(sessionId) || this.session?.id !== sessionId) {
      return;
    }
    const session = this.session;
    const prompt = takeNextQueuedPrompt(session);
    if (!prompt) {
      return;
    }
    session.updatedAt = new Date().toISOString();
    await this.store.save(session);
    await this.sendSessionLifecycleEvent("updated", session);
    try {
      await this.sendPrompt({ content: prompt.content, skills: prompt.skillNames ?? [] }, eventTarget);
    } catch (error) {
      restoreQueuedPrompt(session, { ...prompt, state: "queued" });
      session.updatedAt = new Date().toISOString();
      await this.store.save(session);
      await this.sendSessionLifecycleEvent("updated", session);
      console.error(`[Arivu] Could not start queued message ${prompt.id}: ${formatError(error)}`);
    }
  }

  /**
   * Headless bench entry (ARIVU_BENCH_TASK): the full sendPrompt path — model routing, task-run
   * bookkeeping, browser tools — awaited to completion. Runs under an isolated data home, so the
   * benchmark runner reads the one resulting session for metrics. Requires trustMode "trusted" in
   * the seeded config: there is no renderer to answer approval prompts.
   */
  async runBenchPrompt(text: string): Promise<{
    sessionId: string;
    success: boolean;
    output: string;
    stopReason?: string;
    error?: string;
  }> {
    const snapshot = await this.sendPrompt(text);
    const sessionId = snapshot.sessionId;
    await (this.runCompletions.get(sessionId) ?? Promise.resolve());
    const session = await this.store.load(sessionId);
    const lastRun = session.taskRuns?.[session.taskRuns.length - 1];
    const lastAssistant = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant" && typeof message.content === "string" && message.content.trim().length > 0);
    const browserTask = lastRun?.artifacts
      ?.map((artifact) => artifact.browserTask)
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .at(-1);
    return {
      sessionId,
      success: lastRun ? lastRun.status === "completed" : true,
      output: typeof lastAssistant?.content === "string" ? lastAssistant.content : "",
      stopReason: browserTask?.stopReason,
      error: lastRun?.error
    };
  }

  private async runPromptInBackground({
    session,
    content,
    skillNames,
    config,
    browserTaskModel,
    providerId,
    loopEnabled,
    planModeEnabled,
    taskRunId,
    executionCwd,
    eventTarget
  }: {
    session: AgentSession;
    content: ChatMessage["content"];
    skillNames: string[];
    config: AppConfig;
    browserTaskModel: BrowserTaskModelConfig;
    providerId?: string;
    loopEnabled: boolean;
    planModeEnabled: boolean;
    taskRunId?: string;
    executionCwd?: string;
    eventTarget?: WebContents;
  }) {
    const policyWorkspace = await detectWorkspace(session.cwd);
    const policyOverrides = workspacePolicyOverridesForRoot(config, policyWorkspace.root);
    const scopeRules = workspaceScopeRulesForRoot(config, policyWorkspace.root);
    const approvals = new ApprovalManager(
      config.trustMode,
      (message, request) => this.dependencies.interactionBroker.requestApproval(message, request),
      policyOverrides,
      (event) => this.recordApprovalEvent(session, taskRunId, event),
      scopeRules,
      policyWorkspace.root
    );
    // Only checkpoint direct workspace runs; worktree runs are isolated and reverted via git instead.
    const checkpoint = executionCwd === undefined ? new ChangeCheckpoint() : undefined;
    const savedDisabledTools = createDisabledToolsReader(config.disabledTools ?? []);
    const sessionDisabledTools = this.sessionDisabledTools.get(session.id) ?? new Set<string>();
    this.sessionDisabledTools.set(session.id, sessionDisabledTools);
    const activeBrowserTaskModel = this.sessionBrowserModelOverrides.get(session.id) ?? browserTaskModel;
    const runtimeControl = new RuntimeControlService({
      configuredBrowserTaskModel: browserTaskModel,
      activeBrowserTaskModel,
      readSavedDisabledTools: savedDisabledTools,
      sessionDisabledTools,
      onSessionBrowserModelChange: (model) => this.sessionBrowserModelOverrides.set(session.id, model),
      onProposeMcpServer: (input) => this.proposeMcpServer(input)
    });
    const agent = new Agent({
      client: new OpenAICompatibleChatClient({
        ...config,
        onRequestLog: this.dependencies.recordApiRequestLogEntry,
        captureRequestBodies: true,
        onCapabilityObservation: (observation) =>
          this.recordProviderCapabilityObservation({
            providerId,
            baseUrl: config.baseUrl,
            observation
          })
      }),
      approvals,
      cwd: executionCwd ?? session.cwd,
      projectRoot: session.projectRoot,
      model: config.model,
      baseUrl: config.baseUrl,
      webSearchProvider: resolveWebSearchProvider(config),
      mcpServers: config.mcpServers,
      customInstructions: config.customSystemPrompt,
      minStepIntervalMs: config.chatModelRequestDelayMs,
      scopePolicyRules: scopeRules,
      browser: this.dependencies.browserController,
      browserTaskModel: activeBrowserTaskModel,
      runtimeControl,
      elicit: (request) => this.dependencies.interactionBroker.requestElicitation(request),
      directEditReview: executionCwd === undefined,
      contextWindowTokens: config.contextWindowTokens,
      // Free, always-fresh coverage of the active model: the scheduled sync only sweeps it on
      // Mondays, but a live overflow tells us the real window at zero cost.
      onContextWindowObserved: (tokens) =>
        recordContextFromRuntime(this.modelCatalogStore, { baseUrl: config.baseUrl, model: config.model }, tokens),
      // Checkpoint direct workspace edits so they can be undone; worktree runs already isolate changes.
      checkpoint,
      session
    });

    const abortController = new AbortController();
    this.runAbortControllers.set(session.id, abortController);
    const onUsage = (usage: ChatUsage) => this.recordTaskRunUsage(session, taskRunId, usage);
    const disabledToolNames = () => runtimeControl.disabledToolNames();
    const takeSteeringMessagesForRun = () => takeSteeringMessages(session);
    const onSteeringMessagesApplied = async () => {
      session.updatedAt = new Date().toISOString();
      if (this.session?.id === session.id) {
        this.session = session;
      }
      await this.store.save(session);
      await this.sendSessionLifecycleEvent("updated", session);
    };
    try {
      this.markTaskRun(session, taskRunId, "running");
      const result = loopEnabled
        ? await this.runAgentLoop({
            agent,
            session,
            content,
            skillNames,
            taskRunId,
            executionCwd: executionCwd ?? session.cwd,
            eventTarget,
            signal: abortController.signal,
            onUsage,
            disabledToolNames,
            takeSteeringMessages: takeSteeringMessagesForRun,
            onSteeringMessagesApplied
          })
        : await agent.run(content, {
            skillNames,
            promptAlreadyInSession: true,
            allowedToolNames: planModeEnabled ? PLAN_MODE_TOOL_NAMES : undefined,
            disabledToolNames,
            onEvent: this.agentEventRecorder(session, taskRunId, eventTarget, executionCwd ?? session.cwd),
            signal: abortController.signal,
            onUsage,
            takeSteeringMessages: takeSteeringMessagesForRun,
            onSteeringMessagesApplied
          });
      await this.recordLatestAssistantTaskMetadata(result.session, taskRunId);
      await this.persistRunCheckpoint(result.session, taskRunId, checkpoint);
      this.finishSessionTaskRun(result.session, taskRunId, taskRunStatusForLoop(result.session.agentLoop));
      await this.store.save(result.session);
      if (this.session?.id === result.session.id) {
        this.session = result.session;
      }
      this.runningSessionIds.delete(result.session.id);
      await this.sendSessionLifecycleEvent("completed", result.session, { output: result.output });
    } catch (error) {
      this.runningSessionIds.delete(session.id);
      const stopped = error instanceof AgentRunAbortedError || abortController.signal.aborted;
      const errorText = formatError(error);
      session.updatedAt = new Date().toISOString();
      if (session.agentLoop && ["running", "stopping"].includes(session.agentLoop.status)) {
        session.agentLoop = finishAgentLoopIteration(session.agentLoop, {
          status: stopped ? "stopped" : "failed",
          error: stopped ? undefined : errorText,
          now: session.updatedAt
        });
        session.agentLoop = finishAgentLoop(session.agentLoop, stopped ? "stopped" : "failed");
        this.syncTaskRunLoopState(session, taskRunId);
        this.loopStopRequests.delete(session.id);
      }
      if (stopped) {
        await this.persistRunCheckpoint(session, taskRunId, checkpoint);
        this.finishSessionTaskRun(session, taskRunId, "stopped");
        await this.store.save(session);
        if (this.session?.id === session.id) {
          this.session = session;
        }
        await this.sendSessionLifecycleEvent("completed", session, { output: "Run stopped." });
      } else {
        this.finishSessionTaskRun(session, taskRunId, "failed", errorText);
        await this.store.save(session);
        if (this.session?.id === session.id) {
          this.session = session;
        }
        await this.sendSessionLifecycleEvent("failed", session, { error: errorText });
      }
    } finally {
      if (this.runAbortControllers.get(session.id) === abortController) {
        this.runAbortControllers.delete(session.id);
      }
      if (this.activeRunSessions.get(session.id) === session) {
        this.activeRunSessions.delete(session.id);
      }
      this.loopStopRequests.delete(session.id);
      void this.startNextQueuedPrompt(session.id, eventTarget);
    }
  }

  private recordTaskRunUsage(session: AgentSession, taskRunId: string | undefined, usage: ChatUsage) {
    const taskRun = this.findTaskRun(session, taskRunId);
    if (!taskRun) {
      return;
    }
    const previous = taskRun.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, requestCount: 0 };
    taskRun.usage = {
      promptTokens: previous.promptTokens + (usage.promptTokens ?? 0),
      completionTokens: previous.completionTokens + (usage.completionTokens ?? 0),
      totalTokens: previous.totalTokens + (usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)),
      requestCount: previous.requestCount + 1
    };
    taskRun.updatedAt = new Date().toISOString();
  }

  async stopAgentRun(sessionId = this.session?.id) {
    if (!sessionId) {
      throw new Error("No active run to stop.");
    }
    // Also flag any active loop so it does not queue another iteration after the abort unwinds.
    this.loopStopRequests.add(sessionId);

    const controller = this.runAbortControllers.get(sessionId);
    controller?.abort(new AgentRunAbortedError());
    return this.state();
  }

  private checkpointFile(sessionId: string, taskRunId: string) {
    return path.join(appDataDir(), "checkpoints", sessionId, `${taskRunId}.json`);
  }

  private async persistRunCheckpoint(session: AgentSession, taskRunId: string | undefined, checkpoint: ChangeCheckpoint | undefined) {
    if (!checkpoint || checkpoint.size === 0 || !taskRunId) {
      return;
    }
    const taskRun = this.findTaskRun(session, taskRunId);
    if (!taskRun) {
      return;
    }
    const file = this.checkpointFile(session.id, taskRunId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(checkpoint.toJSON()), { encoding: "utf8", mode: 0o600 });
    taskRun.checkpoint = { changedPaths: checkpoint.changedPaths(), capturedAt: new Date().toISOString() };
    taskRun.updatedAt = taskRun.checkpoint.capturedAt;
  }

  async undoTaskRun(input: { sessionId?: string; taskRunId: string }): Promise<{ state: DesktopState; revertedCount: number }> {
    const sessionId = input.sessionId ?? this.session?.id;
    if (!sessionId) {
      throw new Error("No session selected for undo.");
    }
    if (this.runningSessionIds.has(sessionId)) {
      throw new Error("Stop the run before undoing its changes.");
    }
    const session = this.session?.id === sessionId ? this.session : await this.store.load(sessionId);
    const taskRun = this.findTaskRun(session, input.taskRunId);
    if (!taskRun?.checkpoint) {
      throw new Error("No revertible changes were recorded for this run.");
    }
    if (taskRun.checkpoint.revertedAt) {
      throw new Error("This run's changes were already reverted.");
    }
    const file = this.checkpointFile(sessionId, input.taskRunId);
    const raw = await readFile(file, "utf8").catch(() => undefined);
    if (!raw) {
      throw new Error("Checkpoint data for this run is no longer available.");
    }
    const entries = JSON.parse(raw) as ChangeCheckpointEntry[];
    const reverted = await new ChangeCheckpoint(entries).revert();
    const now = new Date().toISOString();
    taskRun.checkpoint = { ...taskRun.checkpoint, revertedAt: now };
    taskRun.updatedAt = now;
    session.updatedAt = now;
    await this.store.save(session);
    await rm(file, { force: true });
    if (this.session?.id === session.id) {
      this.session = session;
    }
    await this.sendSessionLifecycleEvent("updated", session);
    return { state: await this.state(), revertedCount: reverted.length };
  }

  private markTaskRun(session: AgentSession, taskRunId: string | undefined, status: AgentTaskRun["status"]) {
    const taskRun = this.findTaskRun(session, taskRunId);
    if (!taskRun) {
      return;
    }
    const now = new Date().toISOString();
    if (status === "running") {
      markTaskRunRunning(taskRun, now);
    } else {
      taskRun.status = status;
      taskRun.updatedAt = now;
    }
    session.updatedAt = now;
  }

  private finishSessionTaskRun(session: AgentSession, taskRunId: string | undefined, status: AgentTaskRun["status"], error?: string) {
    const taskRun = this.findTaskRun(session, taskRunId);
    if (!taskRun) {
      return;
    }
    finishTaskRun(taskRun, status, error);
    session.updatedAt = taskRun.updatedAt;
  }

  private syncTaskRunLoopState(session: AgentSession, taskRunId: string | undefined) {
    const taskRun = this.findTaskRun(session, taskRunId);
    if (!taskRun || !session.agentLoop) {
      return;
    }
    syncTaskRunLoopState(taskRun, session.agentLoop);
    session.updatedAt = taskRun.updatedAt;
  }

  private agentEventRecorder(session: AgentSession, taskRunId: string | undefined, eventTarget?: WebContents, executionCwd?: string) {
    return (event: AgentRunEvent) => this.recordAgentEvent(session, taskRunId, eventTarget, event, executionCwd);
  }

  private async recordApprovalEvent(session: AgentSession, taskRunId: string | undefined, event: AgentTaskRunApprovalEvent) {
    const taskRun = this.findTaskRun(session, taskRunId);
    if (!taskRun) {
      return;
    }
    recordTaskRunApproval(taskRun, event, new Date().toISOString());
    session.updatedAt = taskRun.updatedAt;
    if (this.session?.id === session.id) {
      this.session = session;
    }
    await this.store.save(session);
    await this.sendSessionLifecycleEvent("updated", session);
  }

  private async recordAgentEvent(
    session: AgentSession,
    taskRunId: string | undefined,
    eventTarget: WebContents | undefined,
    event: AgentRunEvent,
    executionCwd?: string
  ) {
    sendAgentEvent(eventTarget, session.id, event);
    const taskRun = this.findTaskRun(session, taskRunId);
    if (!taskRun) {
      return;
    }
    const changed = recordTaskRunEvent(taskRun, event, new Date().toISOString(), { workspaceRoot: executionCwd ?? session.cwd });
    if (!changed) {
      return;
    }
    session.updatedAt = taskRun.updatedAt;
    if (this.session?.id === session.id) {
      this.session = session;
    }
    await this.store.save(session);
    await this.sendSessionLifecycleEvent("updated", session);
  }

  private async recordLatestAssistantTaskMetadata(session: AgentSession, taskRunId: string | undefined) {
    const taskRun = this.findTaskRun(session, taskRunId);
    if (!taskRun) {
      return;
    }
    for (let index = session.messages.length - 1; index > taskRun.userMessageIndex; index -= 1) {
      const message = session.messages[index];
      if (message?.role !== "assistant") {
        continue;
      }
      if (taskRun.plan?.sourceMessageIndex === index && taskRun.completion?.sourceMessageIndex === index) {
        return;
      }
      const now = new Date().toISOString();
      const changedPlan =
        taskRun.plan?.sourceMessageIndex === index ? false : recordTaskRunAssistantPlan(taskRun, message.content, now, index);
      const changedCompletion =
        taskRun.completion?.sourceMessageIndex === index ? false : recordTaskRunAssistantCompletion(taskRun, message.content, now, index);
      const changed = changedPlan || changedCompletion;
      if (!changed) {
        continue;
      }
      session.updatedAt = taskRun.updatedAt;
      if (this.session?.id === session.id) {
        this.session = session;
      }
      await this.store.save(session);
      await this.sendSessionLifecycleEvent("updated", session);
      return;
    }
  }

  private findTaskRun(session: AgentSession, taskRunId: string | undefined): AgentTaskRun | undefined {
    if (!session.taskRuns?.length) {
      return undefined;
    }
    if (taskRunId) {
      return session.taskRuns.find((run) => run.id === taskRunId);
    }
    return session.taskRuns.at(-1);
  }

  private async runAgentLoop({
    agent,
    session,
    content,
    skillNames,
    taskRunId,
    executionCwd,
    eventTarget,
    signal,
    onUsage,
    disabledToolNames,
    takeSteeringMessages,
    onSteeringMessagesApplied
  }: {
    agent: Agent;
    session: AgentSession;
    content: ChatMessage["content"];
    skillNames: string[];
    taskRunId?: string;
    executionCwd?: string;
    eventTarget?: WebContents;
    signal?: AbortSignal;
    onUsage?: (usage: ChatUsage) => void | Promise<void>;
    disabledToolNames?: AgentRunOptions["disabledToolNames"];
    takeSteeringMessages?: AgentRunOptions["takeSteeringMessages"];
    onSteeringMessagesApplied?: AgentRunOptions["onSteeringMessagesApplied"];
  }): Promise<{ output: string; session: AgentSession }> {
    let output = "";
    let currentSession = session;
    const onEvent = (event: AgentRunEvent) =>
      this.recordAgentEvent(currentSession, taskRunId, eventTarget, event, executionCwd ?? currentSession.cwd);

    while (currentSession.agentLoop) {
      const loop = currentSession.agentLoop;
      const iterationStartedAt = new Date().toISOString();
      currentSession.agentLoop = beginAgentLoopIteration(
        {
          ...loop,
          stopRequested: this.loopStopRequests.has(currentSession.id) || loop.stopRequested ? true : loop.stopRequested
        },
        iterationStartedAt
      );
      currentSession.updatedAt = iterationStartedAt;
      this.syncTaskRunLoopState(currentSession, taskRunId);
      await this.store.save(currentSession);
      await this.sendSessionLifecycleEvent("updated", currentSession);

      const beforeRun = this.findTaskRun(currentSession, taskRunId);
      const toolStartCount = beforeRun?.tools.length ?? 0;
      const artifactStartCount = beforeRun?.artifacts.length ?? 0;
      const result =
        currentSession.agentLoop.iteration === 1
          ? await agent.run(content, {
              skillNames,
              promptAlreadyInSession: true,
              disabledToolNames,
              onEvent,
              signal,
              onUsage,
              takeSteeringMessages,
              onSteeringMessagesApplied
            })
          : await agent.continue({
              disabledToolNames,
              onEvent,
              signal,
              onUsage,
              takeSteeringMessages,
              onSteeringMessagesApplied
            });

      currentSession = result.session;
      const decision = stripAgentLoopDecision(currentSession) ?? "done";
      output = chatContentToText(lastAssistantMessage(currentSession)?.content ?? result.output);
      await this.recordLatestAssistantTaskMetadata(currentSession, taskRunId);
      const afterRun = this.findTaskRun(currentSession, taskRunId);
      const toolCallCount = Math.max(0, (afterRun?.tools.length ?? 0) - toolStartCount);
      const artifactCount = Math.max(0, (afterRun?.artifacts.length ?? 0) - artifactStartCount);
      const assistantMessageIndex = lastAssistantMessageIndex(currentSession);

      const finishIteration = (status: NonNullable<AgentLoopState["iterations"]>[number]["status"]) => {
        const nextLoop = finishAgentLoopIteration(currentSession.agentLoop!, {
          decision,
          status,
          output,
          assistantMessageIndex,
          toolCallCount,
          artifactCount
        });
        currentSession.agentLoop = nextLoop;
        currentSession.updatedAt = nextLoop.updatedAt;
        this.syncTaskRunLoopState(currentSession, taskRunId);
      };

      if (this.loopStopRequests.has(currentSession.id) || currentSession.agentLoop!.stopRequested) {
        finishIteration("stopped");
        currentSession.agentLoop = finishAgentLoop(currentSession.agentLoop!, "stopped");
        this.syncTaskRunLoopState(currentSession, taskRunId);
        currentSession.messages.push({
          role: "assistant",
          content: "Loop stopped after the current iteration.",
          createdAt: new Date().toISOString()
        });
        output = "Loop stopped after the current iteration.";
        break;
      }

      if (decision === "blocked") {
        finishIteration("blocked");
        currentSession.agentLoop = finishAgentLoop(currentSession.agentLoop!, "blocked");
        this.syncTaskRunLoopState(currentSession, taskRunId);
        break;
      }

      if (decision !== "continue") {
        finishIteration("completed");
        currentSession.agentLoop = finishAgentLoop(currentSession.agentLoop!, "completed");
        this.syncTaskRunLoopState(currentSession, taskRunId);
        break;
      }

      const loopAfterDecision = currentSession.agentLoop!;
      if (loopAfterDecision.iteration >= loopAfterDecision.maxIterations) {
        finishIteration("max_iterations");
        const maxIterations = currentSession.agentLoop!.maxIterations;
        currentSession.agentLoop = finishAgentLoop(currentSession.agentLoop!, "max_iterations");
        this.syncTaskRunLoopState(currentSession, taskRunId);
        currentSession.messages.push({
          role: "assistant",
          content: `Loop stopped after reaching ${maxIterations} iterations. Review the latest result or continue manually.`,
          createdAt: new Date().toISOString()
        });
        output = `Loop stopped after reaching ${maxIterations} iterations.`;
        break;
      }

      finishIteration("continued");
      await this.store.save(currentSession);
      await this.sendSessionLifecycleEvent("updated", currentSession);

      const remediationInstruction = buildTaskRunReportRemediationInstruction(
        this.findTaskRun(currentSession, taskRunId),
        currentSession.messages
      );
      if (remediationInstruction) {
        currentSession.messages.push({
          role: "system",
          content: remediationInstruction
        });
      }
      const loopForContinuation = currentSession.agentLoop!;
      currentSession.messages.push({
        role: "system",
        content: continuationAgentLoopInstruction(loopForContinuation)
      });
      currentSession.agentLoop = {
        ...loopForContinuation,
        updatedAt: new Date().toISOString()
      };
      currentSession.updatedAt = currentSession.agentLoop.updatedAt;
      this.syncTaskRunLoopState(currentSession, taskRunId);
      await this.store.save(currentSession);
      await this.sendSessionLifecycleEvent("updated", currentSession);
    }

    const loopAfterRun = currentSession.agentLoop;
    if (loopAfterRun) {
      currentSession.agentLoop = {
        ...loopAfterRun,
        stopRequested: undefined,
        updatedAt: new Date().toISOString()
      };
      currentSession.updatedAt = currentSession.agentLoop.updatedAt;
      this.syncTaskRunLoopState(currentSession, taskRunId);
    }
    this.loopStopRequests.delete(currentSession.id);
    return { output, session: currentSession };
  }

  private async sessionSummaries(): Promise<SessionSummary[]> {
    const sessions = await this.store.list();
    const projectExistsCache = new Map<string, Promise<boolean>>();
    const projectRootExists = (projectRoot: string | null) => {
      if (projectRoot === null) {
        return undefined;
      }
      let cached = projectExistsCache.get(projectRoot);
      if (!cached) {
        cached = pathExistsAsDirectory(projectRoot);
        projectExistsCache.set(projectRoot, cached);
      }
      return cached;
    };

    return Promise.all(
      sessions.map(async (session) => {
        const projectRoot = sessionProjectRoot(session, { legacyCwdAsProject: true });
        return {
          id: session.id,
          title: sessionDisplayTitle(session),
          pinnedAt: session.pinnedAt,
          cwd: session.cwd,
          projectRoot,
          projectRootExists: await projectRootExists(projectRoot),
          model: session.model,
          modelMode: session.modelMode,
          selectedModel: session.selectedModel,
          selectedProviderName: session.selectedProviderName,
          modelSelectionReason: session.modelSelectionReason,
          agentLoop: session.agentLoop,
          taskRuns: session.taskRuns,
          trustMode: session.trustMode,
          messageCount: session.messages.filter((message) => message.role !== "system").length,
          running: this.runningSessionIds.has(session.id),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt
        };
      })
    );
  }

  private async sendSessionLifecycleEvent(
    type: SessionLifecycleEvent["type"],
    session: AgentSession,
    extra: Pick<SessionLifecycleEvent, "output" | "error"> = {}
  ) {
    this.dependencies.emitSessionLifecycleEvent({
      type,
      sessionId: session.id,
      messages: session.messages,
      sessions: await this.sessionSummaries(),
      runningSessionIds: Array.from(this.runningSessionIds),
      modelSelection: publicModelSelectionForSession(session),
      agentLoop: session.agentLoop,
      taskRuns: session.taskRuns,
      context: desktopContextState(session),
      queuedPrompts: session.queuedPrompts ?? [],
      ...extra
    } satisfies SessionLifecycleEvent);
  }

  private async effectiveConfig(session = this.session): Promise<AppConfig> {
    const config = await loadConfig();
    const sessionModel = session?.model;
    const shouldUseSessionModel = Boolean(sessionModel && !isAutoModel(sessionModel));
    const model = shouldUseSessionModel ? (sessionModel ?? config.model) : config.model;
    const baseUrl = shouldUseSessionModel ? (session?.baseUrl ?? config.baseUrl) : config.baseUrl;
    return {
      ...config,
      model,
      baseUrl,
      // Resolve the window for THIS model, not the active provider's. Config's contextWindowTokens is
      // provider-scoped, so a session pinned to a different model previously inherited the active
      // provider's window — wrong in both directions. Both Agent construction sites read this field.
      contextWindowTokens: resolveContextWindowTokens(config, { model, baseUrl }, await this.modelCatalogStore.load()),
      trustMode: session?.trustMode ?? config.trustMode
    };
  }

  private async modelProvidersForConfig(config: AppConfig): Promise<ModelProviderCandidate[]> {
    const providers = providerCandidatesFromConfig(config);
    if (!isAutoModel(config.model)) {
      return providers;
    }

    return Promise.all(
      providers.map(async (provider) => ({
        ...provider,
        models: await this.cachedProviderModels(provider)
      }))
    );
  }

  private async cachedProviderModels(provider: ModelProviderCandidate): Promise<string[] | undefined> {
    if (!provider.baseUrl.trim()) {
      return undefined;
    }
    const cacheKey = `${provider.id ?? "provider"}:${provider.baseUrl}`;
    const cached = this.modelListCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < MODEL_LIST_CACHE_TTL_MS) {
      return cached.models;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTO_MODEL_LIST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };
      if (provider.apiKey) {
        headers.Authorization = `Bearer ${provider.apiKey}`;
      }
      const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
        headers,
        signal: controller.signal
      });
      if (!response.ok) {
        return undefined;
      }
      const body = await readBoundedResponseText(response, MODEL_LIST_BODY_LIMIT_BYTES);
      const json = JSON.parse(body) as ModelListResponse;
      const models = (json.data ?? [])
        .map((model) => model.id)
        .filter((id): id is string => Boolean(id))
        .sort((left, right) => left.localeCompare(right));
      this.modelListCache.set(cacheKey, { models, fetchedAt: Date.now() });
      return models;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async recordProviderCapabilityObservation({
    providerId,
    baseUrl,
    observation
  }: {
    providerId?: string;
    baseUrl: string;
    observation: ProviderCapabilityObservation;
  }) {
    if (observation.value !== "disabled") {
      return;
    }

    const saved = await loadConfig({ includeEnv: false });
    const next = applyProviderCapabilityObservation(saved, {
      providerId,
      baseUrl,
      capability: observation.capability,
      value: observation.value
    });
    if (next !== saved) {
      await saveConfig(next);
    }
  }

  private async recordDoctorCapabilityObservations(report: DoctorReport, target: { providerId?: string; baseUrl: string }) {
    if (!report.capabilityObservations?.length) {
      return;
    }

    const saved = await loadConfig({ includeEnv: false });
    let next = saved;
    for (const observation of report.capabilityObservations) {
      next = applyProviderCapabilityObservation(next, {
        providerId: target.providerId,
        baseUrl: target.baseUrl,
        capability: observation.capability,
        value: observation.value
      });
    }
    if (next !== saved) {
      await saveConfig(next);
    }
  }

  private markActiveViewChanged() {
    this.activeViewRevision += 1;
  }
}

function sendAgentEvent(target: WebContents | undefined, sessionId: string, event: AgentRunEvent) {
  if (!target || target.isDestroyed()) {
    return;
  }
  target.send("agent:event", { ...event, sessionId });
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: init.signal ?? controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n[truncated]` : text;
  }

  const decoder = new TextDecoder();
  let output = "";
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const remaining = maxBytes - bytesRead;
    if (value.byteLength > remaining) {
      if (remaining > 0) {
        output += decoder.decode(value.slice(0, remaining), { stream: true });
      }
      await reader.cancel();
      output += decoder.decode();
      return `${output}\n[truncated]`;
    }
    bytesRead += value.byteLength;
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSessionTitle(title: string) {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new Error("Chat name cannot be empty.");
  }
  return normalized.slice(0, 120);
}

async function pathExistsAsDirectory(filePath: string) {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent, NativeImage, WebContents } from "electron";
import { execa } from "execa";
import { Agent } from "../../src/agent/Agent.js";
import { compactSessionMessages } from "../../src/agent/contextCompaction.js";
import {
  chatContentHasRenderableContent,
  chatContentToText,
  trimChatContent
} from "../../src/agent/content.js";
import { buildTaskRunReportRemediationInstruction } from "../../src/agent/reportRemediation.js";
import { createSkill, discoverSkills, globalSkillsDir, type CreateSkillInput, type SkillSummary } from "../../src/agent/skills.js";
import { OpenAICompatibleChatClient } from "../../src/agent/OpenAICompatibleChatClient.js";
import {
  MAX_PROMPT_IMAGE_ATTACHMENTS as MAX_IMAGE_ATTACHMENTS,
  MAX_PROMPT_IMAGE_BYTES as MAX_IMAGE_BYTES,
  normalizePromptLoopOptions,
  normalizePromptPayload,
  normalizePromptPlanOptions,
  normalizePromptReuseLastUserMessage,
  normalizePromptSkillNames,
  normalizePromptWorktreeOptions,
  type PromptImageAttachment as ImageAttachment,
  type PromptPayload
} from "../../src/agent/promptPayload.js";
import {
  AUTO_MODEL_ID,
  isAutoModel,
  providerCandidatesFromConfig,
  resolveModelForPrompt,
  type ModelProviderCandidate,
  type ModelSelection
} from "../../src/agent/modelRouter.js";
import {
  capabilityForToolName,
  createAgentTaskRun,
  finishTaskRun,
  markTaskRunRunning,
  recordTaskRunApproval,
  recordTaskRunAssistantCompletion,
  recordTaskRunAssistantPlan,
  recordTaskRunEvent,
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
  AgentSession,
  AgentTaskRun,
  AgentTaskRunApprovalEvent,
  AgentTaskRunArtifact,
  AgentTaskRunVerificationStatus,
  AgentTaskRunWorktreeStatus,
  ChatMessage,
  ToolSchema
} from "../../src/agent/types.js";
import {
  appDataDir,
  appEnv,
  loadConfig,
  mergeRedactedMcpServers,
  redactMcpServers,
  saveConfig,
  workspacePolicyOverridesForRoot,
  workspaceScopeRulesForRoot,
  type AppConfig,
  type LlmProviderProfile
} from "../../src/config.js";
import { runDoctor, type DoctorReport } from "../../src/diagnostics/doctor.js";
import { ApprovalManager } from "../../src/permissions/ApprovalManager.js";
import { describeCapabilityPolicies, evaluateCapabilityPolicy } from "../../src/permissions/capabilityPolicy.js";
import type { CapabilityPolicyOverrides } from "../../src/permissions/capabilityPolicy.js";
import { scopePolicyHasRules, scopePolicySummariesForTool } from "../../src/permissions/scopePolicy.js";
import {
  parseWorkspacePolicyBundle,
  WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH,
  type WorkspacePolicyBundle
} from "../../src/permissions/workspacePolicyBundles.js";
import { SessionStore } from "../../src/sessions/SessionStore.js";
import { relativeToWorkspace, resolveSafeWorkspacePath } from "../../src/tools/pathSafety.js";
import { createToolRegistry } from "../../src/tools/registry.js";
import type { BrowserBounds, BrowserMode, BrowserState } from "../../src/tools/browserControl.js";
import { detectWorkspace, type WorkspaceInfo } from "../../src/workspace.js";
import { DesktopBrowserController } from "./browserController.js";
import { isExternalHttpUrl, isTrustedAppNavigationUrl } from "./navigationSafety.js";

const PLAN_MODE_TOOL_NAMES = ["list", "read", "search", "git_status", "current_datetime", "current_location", "list_skills", "read_skill"];
const MAX_CONTEXT_FILE_ATTACHMENTS = 6;
const MAX_CONTEXT_FILE_BYTES = 256 * 1024;
const MAX_CONTEXT_FILE_CHARS = 24_000;

type PublicConfig = {
  baseUrl: string;
  model: string;
  activeProviderId?: string;
  providers: PublicLlmProviderProfile[];
  trustMode: AppConfig["trustMode"];
  apiKeyPresent: boolean;
  tavilyApiKeyPresent: boolean;
  mcpServers: AppConfig["mcpServers"];
  workspacePolicies: AppConfig["workspacePolicies"];
  workspacePolicyProfiles: AppConfig["workspacePolicyProfiles"];
};

type DesktopState = {
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
  messages: ChatMessage[];
};

type ToolStatus = "enabled" | "approval" | "blocked" | "network" | "privacy";

type ToolSummary = {
  name: string;
  description: string;
  parameters: string[];
  status: ToolStatus;
  statusLabel: string;
  scopeLabels: string[];
};

type WorkspacePolicyBundleResult = {
  path: string;
  exists: boolean;
  bundle: WorkspacePolicyBundle | null;
  error?: string;
};

type CapabilityPolicyResult = {
  currentTrustMode: AppConfig["trustMode"];
  source: "built-in" | "workspace";
  workspaceRoot: string;
  workspaceOverrides: CapabilityPolicyOverrides;
  workspaceScopeRules: AppConfig["workspacePolicies"][string]["scopeRules"];
  policies: ReturnType<typeof describeCapabilityPolicies>;
};

type SkillListResult = {
  skills: SkillSummary[];
  skillsRoot: string;
};

type SkillCreateResult = SkillListResult & {
  skill: SkillSummary;
};

type SessionSummary = {
  id: string;
  title: string;
  pinnedAt?: string;
  cwd: string;
  projectRoot: string | null;
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

type TaskWorktreeActionInput = {
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

type SessionUpdateInput = {
  id?: string;
  title?: string;
  pinned?: boolean;
};

type TaskRunPlanActionInput = {
  sessionId?: string;
  taskRunId?: string;
  action?: "approve" | "request_revision" | "cancel";
};

type TaskWorktreeInventoryItem = {
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

type OpenTaskRunEvidenceInput = {
  sessionId?: string;
  taskRunId?: string;
  artifactId?: string;
  path?: string;
  line?: number;
};

type PublicModelSelection = {
  mode: "manual" | "auto";
  model: string;
  providerName: string;
  reason: string;
};

type SessionLifecycleEvent = {
  type: "started" | "updated" | "completed" | "failed";
  sessionId: string;
  messages: ChatMessage[];
  sessions: SessionSummary[];
  runningSessionIds: string[];
  modelSelection?: PublicModelSelection;
  agentLoop?: AgentLoopState;
  taskRuns?: AgentTaskRun[];
  output?: string;
  error?: string;
};

type ConfigPatch = {
  apiKey?: string;
  tavilyApiKey?: string;
  baseUrl?: string;
  model?: string;
  activeProviderId?: string;
  providers?: LlmProviderPatch[];
  trustMode?: AppConfig["trustMode"];
  mcpServers?: AppConfig["mcpServers"];
  workspacePolicies?: AppConfig["workspacePolicies"];
  workspacePolicyProfiles?: AppConfig["workspacePolicyProfiles"];
};

type PublicLlmProviderProfile = Omit<LlmProviderProfile, "apiKey"> & {
  apiKeyPresent: boolean;
};

type LlmProviderPatch = Omit<LlmProviderProfile, "apiKey"> & {
  apiKey?: string;
};

type WorkspaceScaffoldOptions = {
  initGit?: boolean;
  npmPackage?: boolean;
  typescript?: boolean;
};

type LocalImageResult = {
  mimeType: string;
  size: number;
  dataUrl: string;
};

type ContextFileAttachment = {
  id: string;
  path: string;
  name: string;
  size: number;
  lineCount: number;
  content: string;
  truncated: boolean;
};

type CompactContextResult = {
  state: DesktopState;
  compacted: boolean;
  compactedMessageCount: number;
  remainingMessageCount: number;
};

type ApprovalPayload = {
  id: string;
  message: string;
};

type ModelListResponse = {
  data?: Array<{
    id?: string;
  }>;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.resolve(currentDir, "../preload/preload.cjs");
const rendererIndex = path.resolve(currentDir, "../renderer/index.html");
const devUrl = appEnv("DESKTOP_DEV_URL");
const MODEL_LIST_CACHE_TTL_MS = 10 * 60 * 1000;
const AUTO_MODEL_LIST_TIMEOUT_MS = 4_000;
const MANUAL_MODEL_LIST_TIMEOUT_MS = 10_000;
const MODEL_LIST_BODY_LIMIT_BYTES = 256 * 1024;
const WORKSPACE_POLICY_BUNDLE_MAX_BYTES = 64 * 1024;
let mainWindow: BrowserWindow | undefined;
const pendingApprovals = new Map<string, (approved: boolean) => void>();
const browserController = new DesktopBrowserController();

class DesktopController {
  private session: AgentSession | undefined;
  private readonly store = new SessionStore();
  private readonly runningSessionIds = new Set<string>();
  private readonly loopStopRequests = new Set<string>();
  private readonly modelListCache = new Map<string, { models: string[]; fetchedAt: number }>();
  private activeViewRevision = 0;
  private cwd: string;
  private projectRoot: string | null;

  constructor() {
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
      browser: browserController.getState(),
      runningSessionIds: Array.from(this.runningSessionIds),
      modelSelection: publicModelSelectionForSession(this.session),
      agentLoop: this.session?.agentLoop,
      taskRuns: this.session?.taskRuns,
      sessionId: this.session?.id,
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

  async openSession(id: string) {
    this.session = await this.store.load(id);
    this.cwd = this.session.cwd;
    this.projectRoot = this.session.projectRoot === undefined ? this.session.cwd : this.session.projectRoot;
    this.markActiveViewChanged();
    return this.state();
  }

  async deleteSession(id: string) {
    if (this.runningSessionIds.has(id)) {
      throw new Error("Wait for this chat to finish before deleting it.");
    }
    await this.store.delete(id);
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

    const result = compactSessionMessages(this.session.messages);
    if (result.compacted) {
      this.session = {
        ...this.session,
        messages: result.messages,
        updatedAt: new Date().toISOString()
      };
      await this.store.save(this.session);
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
          sessionTitle: sessionTitle(session),
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
        item.logError = result.exitCode === 0 ? undefined : truncateInlineText(result.stderr || result.stdout || `Exit code ${result.exitCode}`, 240);
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
    if (patch.baseUrl?.trim()) {
      next.baseUrl = patch.baseUrl.trim();
    }
    if (patch.model?.trim()) {
      next.model = patch.model.trim();
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
    if (activeProviderId && next.providers?.some((provider) => provider.id === activeProviderId)) {
      next.providers = updateProviderRuntime(next.providers, activeProviderId, patch);
      if (patch.activeProviderId !== undefined || patch.providers) {
        const activeProvider = next.providers.find((provider) => provider.id === activeProviderId);
        if (activeProvider) {
          next.baseUrl = activeProvider.baseUrl;
          next.model = activeProvider.model;
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
    const apiKey = patch.apiKey?.trim() || config.apiKey;
    const baseUrl = patch.baseUrl?.trim() || config.baseUrl;
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
    return runDoctor(config);
  }

  async listTools(): Promise<{ tools: ToolSummary[] }> {
    const config = await this.effectiveConfig();
    const workspace = await detectWorkspace(this.cwd);
    const policyOverrides = workspacePolicyOverridesForRoot(config, workspace.root);
    const scopePolicyRules = workspaceScopeRulesForRoot(config, workspace.root);
    const registry = createToolRegistry({
      workspaceRoot: workspace.root,
      approvals: new ApprovalManager(config.trustMode, async () => false, policyOverrides, undefined, scopePolicyRules),
      tavilyApiKey: config.tavilyApiKey,
      mcpServers: config.mcpServers,
      scopePolicyRules,
      browser: browserController
    });

    return {
      tools: registry.schemas.map((schema) => ({
        name: schema.name,
        description: schema.description,
        parameters: toolParameterNames(schema),
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

  async sendPrompt(prompt: PromptPayload, eventTarget?: WebContents) {
    const content = normalizePromptPayload(prompt);
    const skillNames = normalizePromptSkillNames(prompt);
    const reuseLastUserMessage = normalizePromptReuseLastUserMessage(prompt);
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
    const config = configForModelSelection(baseConfig, modelSelection);
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
    const before = session.messages.length;
    const lastMessage = session.messages.at(-1);
    const trimmedContent = trimChatContent(content);
    const loopState = !planModeEnabled && loopOptions.enabled ? createAgentLoopState(trimmedContent, loopOptions.maxIterations, now) : undefined;
    const canReuseLastUserMessage =
      reuseLastUserMessage &&
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
      session.messages.push({ role: "user", content: trimmedContent });
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
      const plannedFromRun = worktreeOptions.plannedFromTaskRunId ? this.findTaskRun(session, worktreeOptions.plannedFromTaskRunId) : undefined;
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
          continuedRun ? `This prompt continues existing task run ${continuedRun.id}. Keep the repair in the same task worktree.` : undefined,
          replayOfTaskRunId
            ? `This prompt replays verification evidence from task run ${replayOfTaskRunId}. Rerun the selected commands against the current task worktree and report the results.`
            : undefined
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n")
      };
      const instructionIndex = canReuseLastUserMessage ? session.messages.indexOf(lastMessage) : userMessageIndex;
      if (canReuseLastUserMessage) {
        session.messages.splice(instructionIndex >= 0 ? instructionIndex : Math.max(0, session.messages.length - 1), 0, worktreeInstruction);
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
    await this.sendSessionLifecycleEvent("started", session);

    void this.runPromptInBackground({
      session,
      content,
      skillNames,
      config,
      loopEnabled: Boolean(loopState),
      planModeEnabled,
      taskRunId: taskRun.id,
      executionCwd,
      eventTarget
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

  private async runPromptInBackground({
    session,
    content,
    skillNames,
    config,
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
      (message) => requestApproval(message),
      policyOverrides,
      (event) => this.recordApprovalEvent(session, taskRunId, event),
      scopeRules
    );
    const agent = new Agent({
      client: new OpenAICompatibleChatClient(config),
      approvals,
      cwd: executionCwd ?? session.cwd,
      projectRoot: session.projectRoot,
      model: config.model,
      baseUrl: config.baseUrl,
      tavilyApiKey: config.tavilyApiKey,
      mcpServers: config.mcpServers,
      scopePolicyRules: scopeRules,
      browser: browserController,
      directEditReview: executionCwd === undefined,
      session
    });

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
            eventTarget
          })
        : await agent.run(content, {
            skillNames,
            promptAlreadyInSession: true,
            allowedToolNames: planModeEnabled ? PLAN_MODE_TOOL_NAMES : undefined,
            onEvent: this.agentEventRecorder(session, taskRunId, eventTarget, executionCwd ?? session.cwd)
          });
      await this.recordLatestAssistantTaskMetadata(result.session, taskRunId);
      this.finishSessionTaskRun(result.session, taskRunId, taskRunStatusForLoop(result.session.agentLoop));
      await this.store.save(result.session);
      if (this.session?.id === result.session.id) {
        this.session = result.session;
      }
      this.runningSessionIds.delete(result.session.id);
      await this.sendSessionLifecycleEvent("completed", result.session, { output: result.output });
    } catch (error) {
      this.runningSessionIds.delete(session.id);
      session.updatedAt = new Date().toISOString();
      if (session.agentLoop && ["running", "stopping"].includes(session.agentLoop.status)) {
        session.agentLoop = {
          ...session.agentLoop,
          status: "failed",
          updatedAt: session.updatedAt,
          stopRequested: undefined
        };
        this.loopStopRequests.delete(session.id);
      }
      this.finishSessionTaskRun(session, taskRunId, "failed", formatError(error));
      await this.store.save(session);
      if (this.session?.id === session.id) {
        this.session = session;
      }
      await this.sendSessionLifecycleEvent("failed", session, { error: formatError(error) });
    }
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
      const changedPlan = taskRun.plan?.sourceMessageIndex === index ? false : recordTaskRunAssistantPlan(taskRun, message.content, now, index);
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
    eventTarget
  }: {
    agent: Agent;
    session: AgentSession;
    content: ChatMessage["content"];
    skillNames: string[];
    taskRunId?: string;
    executionCwd?: string;
    eventTarget?: WebContents;
  }): Promise<{ output: string; session: AgentSession }> {
    let output = "";
    let currentSession = session;
    const onEvent = (event: AgentRunEvent) =>
      this.recordAgentEvent(currentSession, taskRunId, eventTarget, event, executionCwd ?? currentSession.cwd);

    while (currentSession.agentLoop) {
      const loop = currentSession.agentLoop;
      const iterationStartedAt = new Date().toISOString();
      currentSession.agentLoop = {
        ...loop,
        status: this.loopStopRequests.has(currentSession.id) || loop.stopRequested ? "stopping" : "running",
        iteration: loop.iteration + 1,
        updatedAt: iterationStartedAt
      };
      currentSession.updatedAt = iterationStartedAt;
      await this.store.save(currentSession);
      await this.sendSessionLifecycleEvent("updated", currentSession);

      const result =
        currentSession.agentLoop.iteration === 1
          ? await agent.run(content, {
              skillNames,
              promptAlreadyInSession: true,
              onEvent
            })
          : await agent.continue({ onEvent });

      currentSession = result.session;
      const decision = stripAgentLoopDecision(currentSession) ?? "done";
      output = chatContentToText(lastAssistantMessage(currentSession)?.content ?? result.output);
      await this.recordLatestAssistantTaskMetadata(currentSession, taskRunId);
      currentSession.agentLoop = {
        ...currentSession.agentLoop!,
        lastDecision: decision,
        updatedAt: new Date().toISOString()
      };
      currentSession.updatedAt = currentSession.agentLoop.updatedAt;
      await this.store.save(currentSession);
      await this.sendSessionLifecycleEvent("updated", currentSession);

      if (this.loopStopRequests.has(currentSession.id) || currentSession.agentLoop.stopRequested) {
        currentSession.agentLoop = finishAgentLoop(currentSession.agentLoop, "stopped");
        currentSession.messages.push({ role: "assistant", content: "Loop stopped after the current iteration." });
        output = "Loop stopped after the current iteration.";
        break;
      }

      if (decision === "blocked") {
        currentSession.agentLoop = finishAgentLoop(currentSession.agentLoop, "blocked");
        break;
      }

      if (decision !== "continue") {
        currentSession.agentLoop = finishAgentLoop(currentSession.agentLoop, "completed");
        break;
      }

      if (currentSession.agentLoop.iteration >= currentSession.agentLoop.maxIterations) {
        currentSession.agentLoop = finishAgentLoop(currentSession.agentLoop, "max_iterations");
        currentSession.messages.push({
          role: "assistant",
          content: `Loop stopped after reaching ${currentSession.agentLoop.maxIterations} iterations. Review the latest result or continue manually.`
        });
        output = `Loop stopped after reaching ${currentSession.agentLoop.maxIterations} iterations.`;
        break;
      }

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
      currentSession.messages.push({
        role: "system",
        content: continuationAgentLoopInstruction(currentSession.agentLoop)
      });
      currentSession.agentLoop = {
        ...currentSession.agentLoop,
        updatedAt: new Date().toISOString()
      };
      currentSession.updatedAt = currentSession.agentLoop.updatedAt;
      await this.store.save(currentSession);
      await this.sendSessionLifecycleEvent("updated", currentSession);
    }

    if (currentSession.agentLoop) {
      currentSession.agentLoop = {
        ...currentSession.agentLoop,
        stopRequested: undefined,
        updatedAt: new Date().toISOString()
      };
      currentSession.updatedAt = currentSession.agentLoop.updatedAt;
    }
    this.loopStopRequests.delete(currentSession.id);
    return { output, session: currentSession };
  }

  private async sessionSummaries(): Promise<SessionSummary[]> {
    const sessions = await this.store.list();
    return sessions.map((session) => ({
      id: session.id,
      title: sessionTitle(session),
      pinnedAt: session.pinnedAt,
      cwd: session.cwd,
      projectRoot: session.projectRoot === undefined ? session.cwd : session.projectRoot,
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
    }));
  }

  private async sendSessionLifecycleEvent(type: SessionLifecycleEvent["type"], session: AgentSession, extra: Pick<SessionLifecycleEvent, "output" | "error"> = {}) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send("session:event", {
      type,
      sessionId: session.id,
      messages: session.messages,
      sessions: await this.sessionSummaries(),
      runningSessionIds: Array.from(this.runningSessionIds),
      modelSelection: publicModelSelectionForSession(session),
      agentLoop: session.agentLoop,
      taskRuns: session.taskRuns,
      ...extra
    } satisfies SessionLifecycleEvent);
  }

  private async effectiveConfig(session = this.session): Promise<AppConfig> {
    const config = await loadConfig();
    const sessionModel = session?.model;
    const shouldUseSessionModel = Boolean(sessionModel && !isAutoModel(sessionModel));
    return {
      ...config,
      model: shouldUseSessionModel ? sessionModel ?? config.model : config.model,
      baseUrl: shouldUseSessionModel ? session?.baseUrl ?? config.baseUrl : config.baseUrl,
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

function taskRunStatusForLoop(loop: AgentLoopState | undefined): AgentTaskRun["status"] {
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

const controller = new DesktopController();
browserController.onState(sendBrowserState);

function sendBrowserState(state: BrowserState) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("browser:state", state);
}

function justChatsPath() {
  return path.join(appDataDir(), "just-chats");
}

async function justChatsCwd() {
  const cwd = justChatsPath();
  await mkdir(cwd, { recursive: true });
  return cwd;
}

function createDesktopSession(
  cwd: string,
  projectRoot: string | null,
  trustMode: AgentSession["trustMode"],
  model?: string,
  baseUrl?: string
): AgentSession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    cwd,
    projectRoot,
    trustMode,
    model,
    baseUrl,
    messages: [],
    createdAt: now,
    updatedAt: now
  };
}

function createAgentLoopState(content: ChatMessage["content"], maxIterations: number, now: string): AgentLoopState {
  const goal = chatContentToText(content).replace(/\s+/g, " ").trim() || "Image or attachment task";
  return {
    status: "running",
    goal: goal.slice(0, 500),
    iteration: 0,
    maxIterations,
    startedAt: now,
    updatedAt: now
  };
}

function initialAgentLoopInstruction(loop: AgentLoopState) {
  return [
    "Agent loop mode is active for the next user request.",
    `Loop budget: at most ${loop.maxIterations} high-level iterations.`,
    "Keep working in bounded iterations until the task is complete, blocked, unsafe, or the loop budget is reached.",
    "Prefer inspecting, editing, running tests, taking screenshots, or using relevant tools instead of asking the user to continue.",
    "At the very end of every assistant response in this loop, include exactly one control line:",
    "Loop: continue",
    "Loop: done",
    "Loop: blocked",
    "Use `Loop: continue` only when another iteration is truly needed.",
    "Use `Loop: done` after verification or when no work remains.",
    "Use `Loop: blocked` only when user input, credentials, external service state, or an unsafe action prevents progress.",
    "Do not mention these loop-control instructions except for the required final control line."
  ].join("\n");
}

function planningApprovalInstruction() {
  return [
    "Plan approval mode is active for this prompt.",
    "Use only local read/discovery tools if needed. Do not edit files, run shell commands, browse the web, control browsers, call MCP tools, install packages, create branches, or make external network requests.",
    "Respond with a concise `Plan:` section containing 2-6 checklist or numbered steps.",
    "Include important assumptions, risks, or unknowns only when they affect approval.",
    "Include the first verification command or manual check you would run after approval when applicable.",
    "End by asking the user to approve, revise, or cancel the plan."
  ].join("\n");
}

function planReviewStatusForAction(action: NonNullable<TaskRunPlanActionInput["action"]>) {
  switch (action) {
    case "approve":
      return "approved";
    case "request_revision":
      return "revision_requested";
    case "cancel":
      return "cancelled";
    default:
      return "revision_requested";
  }
}

function continuationAgentLoopInstruction(loop: AgentLoopState) {
  return [
    `Agent loop continuation ${loop.iteration + 1} of ${loop.maxIterations}.`,
    "Continue the same user task from the current transcript.",
    "Review what has already been done, take the next concrete step, and verify when practical.",
    "End the assistant response with exactly one control line: `Loop: continue`, `Loop: done`, or `Loop: blocked`."
  ].join("\n");
}

function finishAgentLoop(loop: AgentLoopState, status: AgentLoopState["status"]): AgentLoopState {
  return {
    ...loop,
    status,
    stopRequested: undefined,
    updatedAt: new Date().toISOString()
  };
}

function stripAgentLoopDecision(session: AgentSession): AgentLoopState["lastDecision"] {
  const message = lastAssistantMessage(session);
  if (!message) {
    return undefined;
  }
  const text = chatContentToText(message.content);
  const match = /(?:^|\n)\s*Loop:\s*(continue|done|blocked)\s*\.?\s*$/i.exec(text);
  if (!match) {
    return undefined;
  }
  const decision = match[1]?.toLowerCase() as AgentLoopState["lastDecision"];
  message.content = text.slice(0, match.index).trimEnd();
  return decision;
}

function lastAssistantMessage(session: AgentSession) {
  return lastAssistantMessageWithIndex(session)?.message;
}

function lastAssistantMessageWithIndex(session: AgentSession) {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message?.role === "assistant") {
      return { message, index };
    }
  }
  return undefined;
}

function applyModelSelectionToSession(session: AgentSession, selection: ModelSelection): AgentSession {
  return {
    ...session,
    model: selection.mode === "auto" ? AUTO_MODEL_ID : selection.model,
    baseUrl: selection.baseUrl,
    modelMode: selection.mode,
    selectedModel: selection.mode === "auto" ? selection.model : undefined,
    selectedProviderId: selection.providerId,
    selectedProviderName: selection.providerName,
    modelSelectionReason: selection.mode === "auto" ? selection.reason : undefined
  };
}

function configForModelSelection(config: AppConfig, selection: ModelSelection): AppConfig {
  return {
    ...config,
    model: selection.model,
    baseUrl: selection.baseUrl,
    apiKey: selection.apiKey ?? (selection.baseUrl === config.baseUrl ? config.apiKey : undefined)
  };
}

function publicModelSelection(selection: ModelSelection): PublicModelSelection {
  return {
    mode: selection.mode,
    model: selection.model,
    providerName: selection.providerName,
    reason: selection.reason
  };
}

function publicModelSelectionForSession(session: AgentSession | undefined): PublicModelSelection | undefined {
  if (!session?.model) {
    return undefined;
  }
  if (session.modelMode === "auto" || isAutoModel(session.model)) {
    return {
      mode: "auto",
      model: session.selectedModel ?? AUTO_MODEL_ID,
      providerName: session.selectedProviderName ?? "Auto",
      reason: session.modelSelectionReason ?? "Auto selects a model from the current prompt."
    };
  }
  return {
    mode: "manual",
    model: session.model,
    providerName: session.selectedProviderName ?? "OpenAI-compatible",
    reason: "manual model selected"
  };
}

function updateSessionRuntimeFromConfig(session: AgentSession, config: Partial<AppConfig>): AgentSession {
  const model = config.model ?? session.model;
  const auto = isAutoModel(model);
  return {
    ...session,
    model,
    baseUrl: config.baseUrl ?? session.baseUrl,
    trustMode: config.trustMode ?? session.trustMode,
    modelMode: auto ? "auto" : "manual",
    selectedModel: undefined,
    selectedProviderId: undefined,
    selectedProviderName: undefined,
    modelSelectionReason: undefined,
    updatedAt: new Date().toISOString()
  };
}

function toPublicConfig(config: AppConfig): PublicConfig {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    activeProviderId: config.activeProviderId,
    providers: config.providers.map(toPublicProvider),
    trustMode: config.trustMode,
    apiKeyPresent: Boolean(config.apiKey),
    tavilyApiKeyPresent: Boolean(config.tavilyApiKey),
    mcpServers: redactMcpServers(config.mcpServers),
    workspacePolicies: config.workspacePolicies,
    workspacePolicyProfiles: config.workspacePolicyProfiles
  };
}

function toPublicProvider(provider: LlmProviderProfile): PublicLlmProviderProfile {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiKeyPresent: Boolean(provider.apiKey)
  };
}

async function readWorkspacePolicyBundleFromRoot(workspaceRoot: string): Promise<WorkspacePolicyBundleResult> {
  const fallbackPath = path.join(workspaceRoot, WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH);
  let bundlePath = fallbackPath;
  try {
    bundlePath = await resolveSafeWorkspacePath(workspaceRoot, WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { path: fallbackPath, exists: false, bundle: null };
    }
    return { path: fallbackPath, exists: true, bundle: null, error: formatError(error) };
  }

  try {
    const bundleStat = await stat(bundlePath);
    if (!bundleStat.isFile()) {
      return {
        path: bundlePath,
        exists: true,
        bundle: null,
        error: "Workspace policy bundle path exists but is not a file."
      };
    }
    if (bundleStat.size > WORKSPACE_POLICY_BUNDLE_MAX_BYTES) {
      return {
        path: bundlePath,
        exists: true,
        bundle: null,
        error: `Workspace policy bundle is larger than ${formatBytes(WORKSPACE_POLICY_BUNDLE_MAX_BYTES)}.`
      };
    }
    const bundleText = await readFile(bundlePath, "utf8");
    return {
      path: bundlePath,
      exists: true,
      bundle: parseWorkspacePolicyBundle(bundleText, relativeToWorkspace(workspaceRoot, bundlePath))
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return { path: bundlePath, exists: false, bundle: null };
    }
    return { path: bundlePath, exists: true, bundle: null, error: formatError(error) };
  }
}

async function readImageAttachment(filePath: string): Promise<ImageAttachment> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`${path.basename(filePath)} is not a file.`);
  }
  if (fileStat.size > MAX_IMAGE_BYTES) {
    throw new Error(`${path.basename(filePath)} is larger than ${formatBytes(MAX_IMAGE_BYTES)}.`);
  }

  const mimeType = mimeTypeForPath(filePath);
  if (!mimeType) {
    throw new Error(`${path.basename(filePath)} is not a supported image type.`);
  }

  const data = await readFile(filePath);
  return {
    id: randomUUID(),
    name: path.basename(filePath),
    mimeType,
    size: fileStat.size,
    dataUrl: `data:${mimeType};base64,${data.toString("base64")}`,
    detail: "auto"
  };
}

async function readContextFileAttachment(workspaceRoot: string, filePath: string): Promise<ContextFileAttachment> {
  const target = await resolveSafeWorkspacePath(workspaceRoot, filePath);
  const fileStat = await stat(target);
  if (!fileStat.isFile()) {
    throw new Error(`${path.basename(target)} is not a file.`);
  }
  if (fileStat.size > MAX_CONTEXT_FILE_BYTES) {
    throw new Error(`${path.basename(target)} is larger than ${formatBytes(MAX_CONTEXT_FILE_BYTES)}.`);
  }

  const data = await readFile(target);
  if (data.includes(0)) {
    throw new Error(`${path.basename(target)} looks like a binary file.`);
  }

  const fullContent = data.toString("utf8");
  const truncated = fullContent.length > MAX_CONTEXT_FILE_CHARS;
  const content = truncated ? fullContent.slice(0, MAX_CONTEXT_FILE_CHARS) : fullContent;
  return {
    id: randomUUID(),
    path: relativeToWorkspace(workspaceRoot, target),
    name: path.basename(target),
    size: fileStat.size,
    lineCount: countLines(content),
    content,
    truncated
  };
}

function mimeTypeForPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  return undefined;
}

function isAllowedBrowserScreenshotPath(filePath: string) {
  if (!path.basename(filePath).startsWith("arivu-browser-")) {
    return false;
  }
  if (!mimeTypeForPath(filePath)) {
    return false;
  }

  return isInsideDirectory(path.join(appDataDir(), "browser-screenshots"), filePath) || path.dirname(filePath) === path.resolve(os.tmpdir());
}

function isInsideDirectory(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function countLines(text: string) {
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
}

function parseSavedPullRequestCheckLogCommand(command: string | undefined) {
  const ghMatch = /^gh run view '([^']+)' --repo '([^']+)'(?: --job '([^']+)')? (--log(?:-failed)?)$/.exec(command ?? "");
  if (ghMatch) {
    const [, runId, repo, jobId, logFlag] = ghMatch;
    if (!runId || !/^\d+$/.test(runId) || !repo || !logFlag || (jobId !== undefined && !/^\d+$/.test(jobId))) {
      throw new Error("Unsupported PR check evidence command.");
    }
    return {
      source: "github_actions" as const,
      file: "gh",
      runId,
      jobId,
      args: ["run", "view", runId, "--repo", repo, ...(jobId ? ["--job", jobId] : []), logFlag]
    };
  }
  const curlMatch = /^curl -L --max-time 30 --silent --show-error '([^']+)'$/.exec(command ?? "");
  if (!curlMatch?.[1]) {
    throw new Error("Unsupported PR check evidence command.");
  }
  const url = curlMatch[1];
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Unsupported PR check evidence command.");
  }
  return {
    source: "details_url" as const,
    file: "curl",
    url,
    args: ["-L", "--max-time", "30", "--silent", "--show-error", url]
  };
}

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function safeArtifactSegment(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "check";
}

function truncateInlineText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function sessionTitle(session: AgentSession) {
  if (session.title?.trim()) {
    return session.title.trim();
  }
  const content = session.messages.find((message) => message.role === "user")?.content;
  return content ? chatContentToText(content).trim().split(/\s+/).slice(0, 12).join(" ") || "Untitled session" : "Untitled session";
}

function normalizeSessionTitle(title: string) {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new Error("Chat name cannot be empty.");
  }
  return normalized.slice(0, 120);
}

function toolParameterNames(schema: ToolSchema) {
  const properties = schema.parameters.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return [];
  }
  return Object.keys(properties).sort((left, right) => left.localeCompare(right));
}

function toolStatus(
  name: string,
  config: AppConfig,
  policyOverrides: CapabilityPolicyOverrides = {},
  scopePolicyRules: AppConfig["workspacePolicies"][string]["scopeRules"] = {}
): Pick<ToolSummary, "status" | "statusLabel" | "scopeLabels"> {
  const scopeLabels = scopePolicySummariesForTool(name, scopePolicyRules);
  if (name === "current_location") {
    return {
      status: "privacy",
      statusLabel: "Timezone only",
      scopeLabels
    };
  }
  if (name.startsWith("mcp_")) {
    if (name === "mcp_list_tools" && Object.keys(config.mcpServers).length === 0) {
      return {
        status: "network",
        statusLabel: "No servers",
        scopeLabels
      };
    }
  }
  if (name.startsWith("browser_") && !["browser_open", "browser_click", "browser_click_at", "browser_type"].includes(name)) {
    return {
      status: "privacy",
      statusLabel: "Hidden browser",
      scopeLabels
    };
  }

  const decision = evaluateCapabilityPolicy(config.trustMode, capabilityForToolName(name), {
    risky: toolMayRequireApproval(name),
    overrides: policyOverrides
  });
  if (name === "web_search") {
    return {
      status: decision.effect === "deny" ? "blocked" : "approval",
      statusLabel: config.tavilyApiKey ? "Network approval" : "Network fallback approval",
      scopeLabels
    };
  }
  return {
    status: decision.effect === "deny" ? "blocked" : decision.effect === "prompt" ? "approval" : "enabled",
    statusLabel: decision.label,
    scopeLabels
  };
}

function toolMayRequireApproval(name: string) {
  return ["apply_patch", "write_file", "browser_open", "browser_click", "browser_click_at", "browser_type"].includes(name);
}

function normalizeProviders(providers: LlmProviderPatch[], existingProviders: LlmProviderProfile[] = []): LlmProviderProfile[] {
  const existingById = new Map(existingProviders.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const normalized: LlmProviderProfile[] = [];

  for (const provider of providers) {
    const id = provider.id.trim();
    const name = provider.name.trim();
    const baseUrl = provider.baseUrl.trim();
    const model = provider.model.trim();
    if (!id || !name || !baseUrl || !model || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const apiKey = provider.apiKey?.trim() || existingById.get(id)?.apiKey;
    normalized.push({
      id,
      name,
      baseUrl,
      model,
      ...(apiKey ? { apiKey } : {})
    });
  }

  return normalized;
}

function updateProviderRuntime(providers: LlmProviderProfile[], activeProviderId: string, patch: ConfigPatch): LlmProviderProfile[] {
  if (!patch.baseUrl?.trim() && !patch.model?.trim() && !patch.apiKey?.trim()) {
    return providers;
  }

  return providers.map((provider) => {
    if (provider.id !== activeProviderId) {
      return provider;
    }
    const apiKey = patch.apiKey?.trim() || provider.apiKey;
    return {
      ...provider,
      baseUrl: patch.baseUrl?.trim() || provider.baseUrl,
      model: patch.model?.trim() || provider.model,
      ...(apiKey ? { apiKey } : {})
    };
  });
}

function preserveProviderKeys(providers: LlmProviderProfile[], saved: AppConfig): LlmProviderProfile[] {
  return providers.map((provider) => {
    if (provider.apiKey) {
      return provider;
    }
    const savedProviderKey = saved.providers.find((savedProvider) => savedProvider.id === provider.id)?.apiKey;
    const runtimeKeyBelongsToProvider = saved.activeProviderId
      ? saved.activeProviderId === provider.id
      : provider.baseUrl === saved.baseUrl;
    const apiKey = savedProviderKey || (runtimeKeyBelongsToProvider ? saved.apiKey : undefined);
    return {
      ...provider,
      ...(apiKey ? { apiKey } : {})
    };
  });
}

function requestApproval(message: string): Promise<boolean> {
  if (!mainWindow) {
    return Promise.resolve(false);
  }

  const id = randomUUID();
  const payload: ApprovalPayload = { id, message };
  mainWindow.webContents.send("approval:request", payload);

  return new Promise((resolve) => {
    pendingApprovals.set(id, resolve);
  });
}

function normalizeScaffoldOptions(options: WorkspaceScaffoldOptions): Required<WorkspaceScaffoldOptions> {
  return {
    initGit: Boolean(options.initGit),
    npmPackage: Boolean(options.npmPackage),
    typescript: Boolean(options.typescript)
  };
}

async function scaffoldWorkspace(workspacePath: string, options: Required<WorkspaceScaffoldOptions>) {
  if (options.initGit) {
    const result = await execa("git", ["init"], {
      cwd: workspacePath,
      reject: false
    });
    if (result.exitCode !== 0) {
      throw new Error(`git init failed: ${result.stderr || result.stdout || "unknown error"}`);
    }
  }

  if (options.npmPackage) {
    await writeFileIfMissing(path.join(workspacePath, "package.json"), `${JSON.stringify(packageJson(workspacePath, options.typescript), null, 2)}\n`);
  }

  if (options.typescript) {
    await writeFileIfMissing(
      path.join(workspacePath, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            outDir: "dist"
          },
          include: ["src"]
        },
        null,
        2
      )}\n`
    );
    await mkdir(path.join(workspacePath, "src"), { recursive: true });
    await writeFileIfMissing(path.join(workspacePath, "src", "index.ts"), 'export function main() {\n  console.log("Hello from Arivu.");\n}\n\nmain();\n');
  }

  if (options.npmPackage || options.typescript) {
    await writeFileIfMissing(path.join(workspacePath, ".gitignore"), "node_modules\ndist\n.env\n");
  }
}

function packageJson(workspacePath: string, typescript: boolean) {
  return {
    name: packageNameFromPath(workspacePath),
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: typescript
      ? {
          dev: "tsx src/index.ts",
          build: "tsc -p tsconfig.json"
        }
      : {
          test: 'echo "No tests configured."'
        },
    ...(typescript
      ? {
          devDependencies: {
            tsx: "^4.19.2",
            typescript: "^5.7.2"
          }
        }
      : {})
  };
}

function packageNameFromPath(workspacePath: string) {
  return path
    .basename(workspacePath)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "arivu-workspace";
}

async function writeFileIfMissing(filePath: string, content: string) {
  try {
    await access(filePath);
    return;
  } catch {
    await writeFile(filePath, content, "utf8");
  }
}

function applyConfigPatch(config: AppConfig, patch: ConfigPatch): AppConfig {
  return {
    ...config,
    apiKey: patch.apiKey?.trim() || config.apiKey,
    tavilyApiKey: patch.tavilyApiKey?.trim() || config.tavilyApiKey,
    baseUrl: patch.baseUrl?.trim() || config.baseUrl,
    model: patch.model?.trim() || config.model,
    trustMode: patch.trustMode ?? config.trustMode,
    mcpServers: patch.mcpServers ? mergeRedactedMcpServers(patch.mcpServers, config.mcpServers) : config.mcpServers,
    workspacePolicies: patch.workspacePolicies ?? config.workspacePolicies,
    workspacePolicyProfiles: patch.workspacePolicyProfiles ?? config.workspacePolicyProfiles
  };
}

async function pathExistsAsDirectory(filePath: string) {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

function taskRunExecutionRoot(session: AgentSession, taskRun: AgentTaskRun) {
  const worktree = taskRun.worktree;
  if (worktree?.enabled && worktree.path && !["discarded", "cleaned"].includes(worktree.status)) {
    return worktree.path;
  }
  return session.cwd;
}

function taskRunArtifactIncludesEvidencePath(artifact: AgentTaskRunArtifact, requestedPath: string) {
  if (artifact.kind !== "command_output") {
    return false;
  }

  const paths = new Set<string>();
  for (const reportPath of artifact.reportPaths ?? []) {
    paths.add(reportPath);
  }
  for (const report of artifact.testReports ?? []) {
    paths.add(report.path);
    for (const failure of report.failedTests ?? []) {
      if (failure.file) {
        paths.add(failure.file);
      }
    }
    for (const finding of report.findingDetails ?? []) {
      if (finding.path) {
        paths.add(finding.path);
      }
    }
  }

  return paths.has(requestedPath);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 720,
    title: "Arivu",
    backgroundColor: "#11100f",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow = window;
  browserController.attach(window);
  configureMainWindowNavigation(window);

  if (devUrl) {
    void window.loadURL(devUrl);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadFile(rendererIndex);
  }

  if (appEnv("DESKTOP_SMOKE") === "1" || appEnv("BROWSER_SMOKE") === "1") {
    window.webContents.once("did-finish-load", () => {
      console.log("desktop smoke: renderer loaded");
      setTimeout(() => {
        const smoke = appEnv("BROWSER_SMOKE") === "1" ? captureBrowserSmoke(window) : captureSmokeScreenshot(window);
        void smoke
          .then(() => app.quit())
          .catch((error) => {
            console.error(`desktop smoke failed: ${error instanceof Error ? error.message : String(error)}`);
            app.exit(1);
          });
      }, 500);
    });
  }

  window.on("closed", () => {
    browserController.detach(window);
    mainWindow = undefined;
  });
}

function configureMainWindowNavigation(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalIfSafe(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isTrustedAppNavigationUrl(url, { devUrl, rendererIndex })) {
      return;
    }

    event.preventDefault();
    void openExternalIfSafe(url);
  });
}

async function openExternalIfSafe(url: string) {
  if (isExternalHttpUrl(url)) {
    await shell.openExternal(url);
  }
}

async function captureSmokeScreenshot(window: BrowserWindow | undefined) {
  if (!window) {
    return;
  }
  await waitForDesktopSmokeContent(window);
  await prepareDesktopSmokeView(window);
  const image = await captureNonBlankPage(window);
  const smokeView = appEnv("DESKTOP_SMOKE_VIEW");
  const screenshotPath = path.join(os.tmpdir(), smokeView === "settings" ? "arivu-desktop-smoke-settings.png" : "arivu-desktop-smoke.png");
  await writeFile(screenshotPath, image.toPNG());
  console.log(`desktop smoke screenshot: ${screenshotPath}`);
}

async function prepareDesktopSmokeView(window: BrowserWindow) {
  const smokeView = appEnv("DESKTOP_SMOKE_VIEW");
  if (smokeView !== "settings") {
    return;
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('button[aria-label="Settings"]')?.click()`,
    true
  );
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const ready = await window.webContents
      .executeJavaScript(`Boolean(document.querySelector(".settings-panel .policy-table"))`, true)
      .catch(() => false);
    if (ready) {
      await window.webContents.executeJavaScript(
        `document.querySelector(".policy-settings-section")?.scrollIntoView({ block: "start" })`,
        true
      );
      await new Promise((resolve) => setTimeout(resolve, 350));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function captureBrowserSmoke(window: BrowserWindow | undefined) {
  if (!window) {
    return;
  }
  await waitForDesktopSmokeContent(window);
  const firstUrl = await writeBrowserSmokePage("one", "Arivu browser smoke tab one");
  const secondUrl = await writeBrowserSmokePage("two", "Arivu browser smoke tab two");
  const first = await browserController.open({ url: firstUrl, mode: "visible" });
  const second = await browserController.open({ url: secondUrl, mode: "visible", newTab: true });
  const firstTabId = typeof first.tabId === "string" ? first.tabId : undefined;
  const secondTabId = typeof second.tabId === "string" ? second.tabId : undefined;
  if (!firstTabId || !secondTabId) {
    throw new Error("browser smoke: visible tab ids were not returned");
  }
  browserController.selectVisibleTab(firstTabId);
  const firstScreenshot = await browserController.screenshot({ mode: "visible", tabId: firstTabId });
  browserController.selectVisibleTab(secondTabId);
  const secondScreenshot = await browserController.screenshot({ mode: "visible", tabId: secondTabId });
  const browserWindow = BrowserWindow.getAllWindows().find((candidate) => candidate !== window && candidate.getTitle() === "Arivu Browser");
  let chromeScreenshotPath: string | undefined;
  if (browserWindow && !browserWindow.isDestroyed()) {
    const image = await browserWindow.webContents.capturePage();
    chromeScreenshotPath = path.join(os.tmpdir(), "arivu-browser-smoke-window.png");
    await writeFile(chromeScreenshotPath, image.toPNG());
  }
  console.log(
    JSON.stringify(
      {
        browserSmoke: true,
        tabs: browserController.getState().visible.tabs?.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url })),
        activeTabId: browserController.getState().visible.activeTabId,
        firstScreenshotPath: firstScreenshot.screenshotPath,
        secondScreenshotPath: secondScreenshot.screenshotPath,
        chromeScreenshotPath
      },
      null,
      2
    )
  );
  browserController.detach(window);
}

async function writeBrowserSmokePage(name: string, heading: string) {
  const filePath = path.join(os.tmpdir(), `arivu-browser-smoke-${name}.html`);
  await writeFile(
    filePath,
    `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title><style>body{margin:32px;background:#ffffff;color:#111111;font-family:system-ui,sans-serif}main{display:grid;gap:12px}</style></head><body><main><h1>${heading}</h1><p>${new Date().toISOString()}</p></main></body></html>`,
    "utf8"
  );
  return pathToFileURL(filePath).toString();
}

async function waitForDesktopSmokeContent(window: BrowserWindow) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const ready = await window.webContents
      .executeJavaScript(
        `Boolean(document.querySelector(".app-shell")) && document.body.innerText.trim().length > 0`,
        true
      )
      .catch(() => false);
    if (ready) {
      await waitForRendererPaint(window);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function waitForRendererPaint(window: BrowserWindow) {
  await window.webContents
    .executeJavaScript(
      `document.body?.getBoundingClientRect().width ?? 0`,
      true
    )
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 750));
}

async function captureNonBlankPage(window: BrowserWindow) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    window.show();
    window.focus();
    await waitForRendererPaint(window);
    const image = await window.webContents.capturePage();
    if (nativeImageHasVisibleContent(image)) {
      return image;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("desktop smoke screenshot appears blank.");
}

function nativeImageHasVisibleContent(image: NativeImage) {
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) {
    return false;
  }
  const bitmap = image.toBitmap();
  const strideX = Math.max(1, Math.floor(size.width / 96));
  const strideY = Math.max(1, Math.floor(size.height / 54));
  let visibleSamples = 0;
  for (let y = 0; y < size.height; y += strideY) {
    for (let x = 0; x < size.width; x += strideX) {
      const index = (y * size.width + x) * 4;
      const blue = bitmap[index] ?? 0;
      const green = bitmap[index + 1] ?? 0;
      const red = bitmap[index + 2] ?? 0;
      if (red > 70 || green > 70 || blue > 70) {
        visibleSamples += 1;
        if (visibleSamples > 20) {
          return true;
        }
      }
    }
  }
  return false;
}

handleFromMain("app:getState", () => controller.state());
handleFromMain("workspace:choose", () => controller.chooseWorkspace());
handleFromMain("workspace:open", (_event, workspaceRoot: string) => controller.openWorkspace(workspaceRoot));
handleFromMain("images:choose", () => controller.chooseImages());
handleFromMain("images:readLocal", (_event, filePath: string) => controller.readLocalImage(filePath));
handleFromMain("files:chooseContext", () => controller.chooseContextFiles());
handleFromMain("workspace:create", (_event, options: WorkspaceScaffoldOptions) => controller.createWorkspace(options));
handleFromMain("project:justChats", () => controller.openJustChats());
handleFromMain("project:selectForChat", (_event, projectRoot: string | null) => controller.selectChatProject(projectRoot));
handleFromMain("sessions:list", () => controller.listSessions());
handleFromMain("sessions:open", (_event, id: string) => controller.openSession(id));
handleFromMain("sessions:new", () => controller.newChat());
handleFromMain("sessions:update", (_event, input: SessionUpdateInput) => controller.updateSession(input));
handleFromMain("sessions:delete", (_event, id: string) => controller.deleteSession(id));
handleFromMain("context:compact", () => controller.compactContext());
handleFromMain("config:save", (_event, patch: ConfigPatch) => controller.saveConfigPatch(patch));
handleFromMain("models:list", (_event, patch: ConfigPatch) => controller.listModels(patch));
handleFromMain("doctor:run", (_event, patch: ConfigPatch) => controller.doctor(patch));
handleFromMain("tools:list", () => controller.listTools());
handleFromMain("policy:list", () => controller.listCapabilityPolicies());
handleFromMain("policy:readWorkspaceBundle", () => controller.readWorkspacePolicyBundle());
handleFromMain("skills:list", () => controller.listSkills());
handleFromMain("skills:create", (_event, input: CreateSkillInput) => controller.createSkill(input));
handleFromMain("agent:listTaskWorktrees", () => controller.listTaskWorktrees());
handleFromMain("agent:sendPrompt", (event, prompt: PromptPayload) => controller.sendPrompt(prompt, event.sender));
handleFromMain("agent:stopLoop", (_event, sessionId?: string) => controller.stopAgentLoop(sessionId));
handleFromMain("agent:taskWorktreeAction", (_event, input: TaskWorktreeActionInput) => controller.taskWorktreeAction(input));
handleFromMain("agent:taskRunPlanAction", (_event, input: TaskRunPlanActionInput) => controller.taskRunPlanAction(input));
handleFromMain("agent:openTaskRunEvidence", (_event, input: OpenTaskRunEvidenceInput) => controller.openTaskRunEvidence(input));
handleFromMain("browser:getState", () => browserController.getState());
handleFromMain("browser:setPaneOpen", (_event, open: boolean) => browserController.setPaneOpen(Boolean(open)));
handleFromMain("browser:setDefaultMode", (_event, mode: BrowserMode) => browserController.setDefaultMode(mode));
handleFromMain("browser:setBounds", (_event, bounds: BrowserBounds) => browserController.setVisibleBounds(bounds));
handleFromMain("browser:setVisibleSuppressed", (_event, suppressed: boolean) => browserController.setVisibleSuppressed(Boolean(suppressed)));
handleFromMain("browser:open", (_event, args: { url: string; mode?: BrowserMode; tabId?: string; newTab?: boolean }) => browserController.open(args));
handleFromMain("browser:newTab", (_event, args?: { url?: string }) => browserController.newVisibleTab(args ?? {}));
handleFromMain("browser:selectTab", (_event, tabId: string) => browserController.selectVisibleTab(tabId));
handleFromMain("browser:closeTab", (_event, tabId: string) => browserController.closeVisibleTab(tabId));
handleFromMain("browser:goBack", (_event, args?: BrowserMode | { mode?: BrowserMode; tabId?: string }) =>
  typeof args === "object" ? browserController.goBack(args.mode, args.tabId) : browserController.goBack(args)
);
handleFromMain("browser:goForward", (_event, args?: BrowserMode | { mode?: BrowserMode; tabId?: string }) =>
  typeof args === "object" ? browserController.goForward(args.mode, args.tabId) : browserController.goForward(args)
);
handleFromMain("browser:reload", (_event, args?: BrowserMode | { mode?: BrowserMode; tabId?: string }) =>
  typeof args === "object" ? browserController.reload(args.mode, args.tabId) : browserController.reload(args)
);
handleFromMain("browser:stop", (_event, args?: BrowserMode | { mode?: BrowserMode; tabId?: string }) =>
  typeof args === "object" ? browserController.stop(args.mode, args.tabId) : browserController.stop(args)
);
handleFromMain("browser:screenshot", (_event, args: { mode?: BrowserMode; tabId?: string }) => browserController.screenshot(args ?? {}));
handleFromMain("approval:respond", (_event, response: { id: string; approved: boolean }) => {
  const resolve = pendingApprovals.get(response.id);
  if (!resolve) {
    return;
  }
  pendingApprovals.delete(response.id);
  resolve(response.approved);
});

function handleFromMain<T extends unknown[]>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: T) => unknown | Promise<unknown>
) {
  ipcMain.handle(channel, (event, ...args: T) => {
    assertTrustedIpcSender(event);
    return listener(event, ...args);
  });
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Refused IPC request from an untrusted sender.");
  }
  if (!event.senderFrame || !isTrustedAppNavigationUrl(event.senderFrame.url, { devUrl, rendererIndex })) {
    throw new Error("Refused IPC request from an untrusted frame.");
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

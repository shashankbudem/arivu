import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type { WebContents } from "electron";
import { execa } from "execa";
import { Agent } from "../../src/agent/Agent.js";
import { compactSessionMessages } from "../../src/agent/contextCompaction.js";
import {
  chatContentHasRenderableContent,
  chatContentToText,
  trimChatContent
} from "../../src/agent/content.js";
import { createSkill, discoverSkills, globalSkillsDir, type CreateSkillInput, type SkillSummary } from "../../src/agent/skills.js";
import { OpenAICompatibleChatClient } from "../../src/agent/OpenAICompatibleChatClient.js";
import {
  MAX_PROMPT_IMAGE_ATTACHMENTS as MAX_IMAGE_ATTACHMENTS,
  MAX_PROMPT_IMAGE_BYTES as MAX_IMAGE_BYTES,
  normalizePromptPayload,
  normalizePromptSkillNames,
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
import type { AgentRunEvent, AgentSession, ChatMessage, ToolSchema } from "../../src/agent/types.js";
import { appDataDir, appEnv, loadConfig, saveConfig, type AppConfig, type LlmProviderProfile } from "../../src/config.js";
import { runDoctor, type DoctorReport } from "../../src/diagnostics/doctor.js";
import { ApprovalManager } from "../../src/permissions/ApprovalManager.js";
import { SessionStore } from "../../src/sessions/SessionStore.js";
import { createToolRegistry } from "../../src/tools/registry.js";
import type { BrowserBounds, BrowserMode, BrowserState } from "../../src/tools/browserControl.js";
import { detectWorkspace, type WorkspaceInfo } from "../../src/workspace.js";
import { DesktopBrowserController } from "./browserController.js";

type PublicConfig = {
  baseUrl: string;
  model: string;
  activeProviderId?: string;
  providers: PublicLlmProviderProfile[];
  trustMode: AppConfig["trustMode"];
  apiKeyPresent: boolean;
  tavilyApiKeyPresent: boolean;
  mcpServers: AppConfig["mcpServers"];
};

type DesktopState = {
  cwd: string;
  projectRoot: string | null;
  workspace: WorkspaceInfo;
  config: PublicConfig;
  browser: BrowserState;
  runningSessionIds: string[];
  modelSelection?: PublicModelSelection;
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
  cwd: string;
  projectRoot: string | null;
  model?: string;
  modelMode?: "manual" | "auto";
  selectedModel?: string;
  selectedProviderName?: string;
  modelSelectionReason?: string;
  trustMode: AppConfig["trustMode"];
  messageCount: number;
  running: boolean;
  createdAt: string;
  updatedAt: string;
};

type PublicModelSelection = {
  mode: "manual" | "auto";
  model: string;
  providerName: string;
  reason: string;
};

type SessionLifecycleEvent = {
  type: "started" | "completed" | "failed";
  sessionId: string;
  messages: ChatMessage[];
  sessions: SessionSummary[];
  runningSessionIds: string[];
  modelSelection?: PublicModelSelection;
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
let mainWindow: BrowserWindow | undefined;
const pendingApprovals = new Map<string, (approved: boolean) => void>();
const browserController = new DesktopBrowserController();

class DesktopController {
  private session: AgentSession | undefined;
  private readonly store = new SessionStore();
  private readonly runningSessionIds = new Set<string>();
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
      next.mcpServers = patch.mcpServers;
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

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Model list request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as ModelListResponse;
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
    const registry = createToolRegistry({
      workspaceRoot: workspace.root,
      approvals: new ApprovalManager(config.trustMode, async () => false),
      tavilyApiKey: config.tavilyApiKey,
      mcpServers: config.mcpServers,
      browser: browserController
    });

    return {
      tools: registry.schemas.map((schema) => ({
        name: schema.name,
        description: schema.description,
        parameters: toolParameterNames(schema),
        ...toolStatus(schema.name, config)
      }))
    };
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
    session.messages.push({ role: "user", content: trimChatContent(content) });
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
      eventTarget
    });

    return {
      output: "",
      sessionId: session.id,
      messages: session.messages,
      newMessages: session.messages.slice(before),
      modelSelection: publicModelSelection(modelSelection),
      running: true
    };
  }

  private async runPromptInBackground({
    session,
    content,
    skillNames,
    config,
    eventTarget
  }: {
    session: AgentSession;
    content: ChatMessage["content"];
    skillNames: string[];
    config: AppConfig;
    eventTarget?: WebContents;
  }) {
    const approvals = new ApprovalManager(config.trustMode, (message) => requestApproval(message));
    const agent = new Agent({
      client: new OpenAICompatibleChatClient(config),
      approvals,
      cwd: session.cwd,
      projectRoot: session.projectRoot,
      model: config.model,
      baseUrl: config.baseUrl,
      tavilyApiKey: config.tavilyApiKey,
      mcpServers: config.mcpServers,
      browser: browserController,
      session
    });

    try {
      const result = await agent.run(content, {
        skillNames,
        promptAlreadyInSession: true,
        onEvent: (event) => sendAgentEvent(eventTarget, session.id, event)
      });
      await this.store.save(result.session);
      if (this.session?.id === result.session.id) {
        this.session = result.session;
      }
      this.runningSessionIds.delete(result.session.id);
      await this.sendSessionLifecycleEvent("completed", result.session, { output: result.output });
    } catch (error) {
      this.runningSessionIds.delete(session.id);
      session.updatedAt = new Date().toISOString();
      await this.store.save(session);
      if (this.session?.id === session.id) {
        this.session = session;
      }
      await this.sendSessionLifecycleEvent("failed", session, { error: formatError(error) });
    }
  }

  private async sessionSummaries(): Promise<SessionSummary[]> {
    const sessions = await this.store.list();
    return sessions.map((session) => ({
      id: session.id,
      title: sessionTitle(session),
      cwd: session.cwd,
      projectRoot: session.projectRoot === undefined ? session.cwd : session.projectRoot,
      model: session.model,
      modelMode: session.modelMode,
      selectedModel: session.selectedModel,
      selectedProviderName: session.selectedProviderName,
      modelSelectionReason: session.modelSelectionReason,
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
      const json = (await response.json()) as ModelListResponse;
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
    mcpServers: config.mcpServers
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

function formatBytes(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sessionTitle(session: AgentSession) {
  const content = session.messages.find((message) => message.role === "user")?.content;
  return content ? chatContentToText(content).trim().split(/\s+/).slice(0, 12).join(" ") || "Untitled session" : "Untitled session";
}

function toolParameterNames(schema: ToolSchema) {
  const properties = schema.parameters.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return [];
  }
  return Object.keys(properties).sort((left, right) => left.localeCompare(right));
}

function toolStatus(name: string, config: AppConfig): Pick<ToolSummary, "status" | "statusLabel"> {
  if (name === "web_search") {
    return {
      status: "network",
      statusLabel: config.tavilyApiKey ? "Network" : "Network fallback"
    };
  }
  if (name === "current_location") {
    return {
      status: "privacy",
      statusLabel: "Timezone only"
    };
  }
  if (name.startsWith("mcp_")) {
    if (name === "mcp_call_tool") {
      if (config.trustMode === "readonly") {
        return {
          status: "blocked",
          statusLabel: "Blocked in readonly"
        };
      }
      return {
        status: "approval",
        statusLabel: "Requires approval"
      };
    }
    return {
      status: "network",
      statusLabel: Object.keys(config.mcpServers).length > 0 ? "MCP" : "No servers"
    };
  }
  if (name.startsWith("browser_")) {
    return {
      status: "privacy",
      statusLabel: "Hidden browser"
    };
  }
  if (["apply_patch", "write_file", "run"].includes(name)) {
    if (config.trustMode === "readonly") {
      return {
        status: "blocked",
        statusLabel: "Blocked in readonly"
      };
    }
    return {
      status: "approval",
      statusLabel: config.trustMode === "trusted" ? "Approval for risky" : "Requires approval"
    };
  }
  return {
    status: "enabled",
    statusLabel: "Read-only"
  };
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
    mcpServers: patch.mcpServers ?? config.mcpServers
  };
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

  if (devUrl) {
    void window.loadURL(devUrl);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadFile(rendererIndex);
  }

  if (appEnv("DESKTOP_SMOKE") === "1") {
    window.webContents.once("did-finish-load", () => {
      console.log("desktop smoke: renderer loaded");
      setTimeout(() => {
        void captureSmokeScreenshot(window).finally(() => app.quit());
      }, 500);
    });
  }

  window.on("closed", () => {
    browserController.detach(window);
    mainWindow = undefined;
  });
}

async function captureSmokeScreenshot(window: BrowserWindow | undefined) {
  if (!window) {
    return;
  }
  const image = await window.webContents.capturePage();
  const screenshotPath = path.join(os.tmpdir(), "arivu-desktop-smoke.png");
  await writeFile(screenshotPath, image.toPNG());
  console.log(`desktop smoke screenshot: ${screenshotPath}`);
}

ipcMain.handle("app:getState", () => controller.state());
ipcMain.handle("workspace:choose", () => controller.chooseWorkspace());
ipcMain.handle("images:choose", () => controller.chooseImages());
ipcMain.handle("workspace:create", (_event, options: WorkspaceScaffoldOptions) => controller.createWorkspace(options));
ipcMain.handle("project:justChats", () => controller.openJustChats());
ipcMain.handle("project:selectForChat", (_event, projectRoot: string | null) => controller.selectChatProject(projectRoot));
ipcMain.handle("sessions:list", () => controller.listSessions());
ipcMain.handle("sessions:open", (_event, id: string) => controller.openSession(id));
ipcMain.handle("sessions:new", () => controller.newChat());
ipcMain.handle("sessions:delete", (_event, id: string) => controller.deleteSession(id));
ipcMain.handle("context:compact", () => controller.compactContext());
ipcMain.handle("config:save", (_event, patch: ConfigPatch) => controller.saveConfigPatch(patch));
ipcMain.handle("models:list", (_event, patch: ConfigPatch) => controller.listModels(patch));
ipcMain.handle("doctor:run", (_event, patch: ConfigPatch) => controller.doctor(patch));
ipcMain.handle("tools:list", () => controller.listTools());
ipcMain.handle("skills:list", () => controller.listSkills());
ipcMain.handle("skills:create", (_event, input: CreateSkillInput) => controller.createSkill(input));
ipcMain.handle("agent:sendPrompt", (event, prompt: PromptPayload) => controller.sendPrompt(prompt, event.sender));
ipcMain.handle("browser:getState", () => browserController.getState());
ipcMain.handle("browser:setPaneOpen", (_event, open: boolean) => browserController.setPaneOpen(Boolean(open)));
ipcMain.handle("browser:setDefaultMode", (_event, mode: BrowserMode) => browserController.setDefaultMode(mode));
ipcMain.handle("browser:setBounds", (_event, bounds: BrowserBounds) => browserController.setVisibleBounds(bounds));
ipcMain.handle("browser:setVisibleSuppressed", (_event, suppressed: boolean) => browserController.setVisibleSuppressed(Boolean(suppressed)));
ipcMain.handle("browser:open", (_event, args: { url: string; mode?: BrowserMode }) => browserController.open(args));
ipcMain.handle("browser:goBack", (_event, mode?: BrowserMode) => browserController.goBack(mode));
ipcMain.handle("browser:goForward", (_event, mode?: BrowserMode) => browserController.goForward(mode));
ipcMain.handle("browser:reload", (_event, mode?: BrowserMode) => browserController.reload(mode));
ipcMain.handle("browser:stop", (_event, mode?: BrowserMode) => browserController.stop(mode));
ipcMain.handle("browser:screenshot", (_event, args: { mode?: BrowserMode }) => browserController.screenshot(args ?? {}));
ipcMain.handle("approval:respond", (_event, response: { id: string; approved: boolean }) => {
  const resolve = pendingApprovals.get(response.id);
  if (!resolve) {
    return;
  }
  pendingApprovals.delete(response.id);
  resolve(response.approved);
});

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

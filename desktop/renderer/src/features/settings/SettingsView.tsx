import { useEffect, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Cpu,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Globe,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Scissors,
  Search,
  Server,
  Shield,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import { formatDateTime, formatError } from "../../format";
import { randomId } from "../../shared/id";
import {
  CapabilityPolicyPanel,
  updateWorkspacePoliciesForRoot,
  updateWorkspacePolicyOverride,
  workspacePolicyOverridesFromConfig,
  workspaceScopeRulesFromConfig
} from "./CapabilityPolicyPanel";
import { DoctorReportView } from "./DoctorReportView";
import { parseMcpServersText, uniqueMcpServerName } from "./mcpConfig";
import {
  generatedWebSearchProviderName,
  parseBoundedSettingsInt,
  parseOptionalInt,
  providerFormsFromConfig,
  uniqueProviderId,
  uniqueProviderName,
  uniqueWebSearchProviderId,
  uniqueWebSearchProviderName,
  validateProviderForms,
  validateWebSearchProviderForms,
  webSearchProviderFormsFromConfig,
  type ProviderFormState,
  type WebSearchProviderFormState
} from "./settingsForms";
import { ModelPickerDialog } from "../models/ModelPickerDialog";
import { isAutoModelId, modelDisplayName } from "../models/providerCatalog";
import {
  confirmInventoryWorktreeAction,
  taskWorktreeActionStatus,
  taskWorktreeInventorySummary,
  verificationStatusLabel,
  worktreeInventoryStatusLabel,
  type TaskWorktreeAction
} from "../worktrees/worktreePresentation";
import { normalizedWorkspacePolicyPreset } from "../../../../../src/permissions/workspacePolicyPresets";
import { normalizeWorkspacePolicyProfiles } from "../../../../../src/permissions/workspacePolicyProfiles";
import {
  WEB_SEARCH_PROVIDER_KINDS,
  WEB_SEARCH_PROVIDER_PRESETS,
  webSearchProviderRequiresApiKey
} from "../../../../../src/tools/webSearchProvider";

const SETTINGS_SECTIONS = [
  { id: "models", label: "Models", description: "Providers, model defaults, and input capabilities", icon: Cpu },
  { id: "browser", label: "Browser agent", description: "Model and pacing for browser tasks", icon: Globe },
  { id: "integrations", label: "Integrations", description: "Web search and MCP servers", icon: Server },
  { id: "permissions", label: "Permissions", description: "Trust mode and workspace policy", icon: Shield },
  { id: "skills", label: "Skills", description: "Installed instructions and new skills", icon: Wrench },
  { id: "worktrees", label: "Worktrees", description: "Task branches and pull requests", icon: GitBranch },
  { id: "diagnostics", label: "Diagnostics", description: "Provider and tool health checks", icon: Activity }
] as const;

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export type SettingsFocus = Extract<SettingsSectionId, "skills"> | null;

type BrowserFallbackFormState = {
  id: string;
  providerId: string;
  model: string;
};

const NEW_PROVIDER_NAME = "New provider";

const NEW_WEB_SEARCH_PROVIDER_KIND: WebSearchProviderKind = "tavily";

const MAX_BROWSER_TASK_FALLBACKS = 5;

export function SettingsView({
  state,
  skills,
  skillsRoot,
  focusSection,
  onFocusSettled,
  onSkillsChanged,
  onSaved,
  onStateUpdated
}: {
  state: DesktopState;
  skills: SkillSummary[];
  skillsRoot: string;
  focusSection: SettingsFocus;
  onFocusSettled: () => void;
  onSkillsChanged: (skills: SkillSummary[], skillsRoot: string) => void;
  onSaved: (state: DesktopState) => void;
  onStateUpdated: (state: DesktopState) => void;
}) {
  const initialProviders = providerFormsFromConfig(state.config);
  const [providers, setProviders] = useState<ProviderFormState[]>(initialProviders);
  const [activeProviderId, setActiveProviderId] = useState(
    state.config.activeProviderId && initialProviders.some((provider) => provider.id === state.config.activeProviderId)
      ? state.config.activeProviderId
      : (initialProviders[0]?.id ?? "current")
  );
  const initialWebSearchProviders = webSearchProviderFormsFromConfig(state.config);
  const [webSearchProviders, setWebSearchProviders] = useState<WebSearchProviderFormState[]>(initialWebSearchProviders);
  const [activeWebSearchProviderId, setActiveWebSearchProviderId] = useState(
    state.config.activeWebSearchProviderId &&
      initialWebSearchProviders.some((provider) => provider.id === state.config.activeWebSearchProviderId)
      ? state.config.activeWebSearchProviderId
      : (initialWebSearchProviders[0]?.id ?? "bing")
  );
  const [browserTaskProviderId, setBrowserTaskProviderId] = useState(state.config.browserTaskModel?.providerId ?? "");
  const [browserTaskModelId, setBrowserTaskModelId] = useState(state.config.browserTaskModel?.model ?? "");
  const [browserTaskMaxSteps, setBrowserTaskMaxSteps] = useState(
    state.config.browserTaskModel?.maxSteps !== undefined ? String(state.config.browserTaskModel.maxSteps) : ""
  );
  const [browserTaskStepDelayMs, setBrowserTaskStepDelayMs] = useState(
    state.config.browserTaskModel?.stepDelayMs !== undefined ? String(state.config.browserTaskModel.stepDelayMs) : ""
  );
  const [chatModelRequestDelayMs, setChatModelRequestDelayMs] = useState(String(state.config.chatModelRequestDelayMs));
  const [browserVisualGroundingProviderId, setBrowserVisualGroundingProviderId] = useState(
    state.config.browserVisualGrounding?.providerId ?? (state.config.browserVisualGrounding?.baseUrl ? "__custom__" : "")
  );
  const [browserVisualGroundingModel, setBrowserVisualGroundingModel] = useState(
    state.config.browserVisualGrounding?.model ?? "nvidia/LocateAnything-3B"
  );
  const [browserTaskFallbacks, setBrowserTaskFallbacks] = useState<BrowserFallbackFormState[]>(() =>
    (state.config.browserTaskModel?.fallbackModels ?? []).map((fallback) => ({
      id: randomId(),
      providerId: fallback.providerId ?? "",
      model: fallback.model ?? ""
    }))
  );
  const [browserFallbackModelDialogId, setBrowserFallbackModelDialogId] = useState<string | null>(null);
  const [trustMode, setTrustMode] = useState<TrustMode>(state.config.trustMode);
  const [customSystemPrompt, setCustomSystemPrompt] = useState(state.config.customSystemPrompt ?? "");
  const [mcpServersText, setMcpServersText] = useState(() => JSON.stringify(state.config.mcpServers ?? {}, null, 2));
  const [toolProposals, setToolProposals] = useState<McpToolProposal[]>(state.config.toolProposals ?? []);
  const [integrationStatus, setIntegrationStatus] = useState<string | null>(null);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [browserTaskModelDialogOpen, setBrowserTaskModelDialogOpen] = useState(false);
  const [browserVisualGroundingModelDialogOpen, setBrowserVisualGroundingModelDialogOpen] = useState(false);
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
  const [worktreeInventory, setWorktreeInventory] = useState<TaskWorktreeInventoryItem[]>([]);
  const [worktreeInventoryLoading, setWorktreeInventoryLoading] = useState(false);
  const [worktreeInventoryBusy, setWorktreeInventoryBusy] = useState<string | null>(null);
  const [worktreeInventoryError, setWorktreeInventoryError] = useState<string | null>(null);
  const [worktreeInventoryStatus, setWorktreeInventoryStatus] = useState<string | null>(null);
  const [capabilityPolicies, setCapabilityPolicies] = useState<CapabilityPolicySummary[]>([]);
  const [capabilityPolicyLoading, setCapabilityPolicyLoading] = useState(false);
  const [capabilityPolicyError, setCapabilityPolicyError] = useState<string | null>(null);
  const [capabilityPolicySource, setCapabilityPolicySource] = useState<CapabilityPolicyResult["source"]>("built-in");
  const [workspacePolicyOverrides, setWorkspacePolicyOverrides] = useState<WorkspaceCapabilityPolicyOverrides>(() =>
    workspacePolicyOverridesFromConfig(state.config.workspacePolicies, state.workspace.root)
  );
  const [workspaceScopeRules, setWorkspaceScopeRules] = useState<WorkspaceScopePolicyRules>(() =>
    workspaceScopeRulesFromConfig(state.config.workspacePolicies, state.workspace.root)
  );
  const [workspacePolicyProfiles, setWorkspacePolicyProfiles] = useState<WorkspacePolicyProfiles>(() =>
    normalizeWorkspacePolicyProfiles(state.config.workspacePolicyProfiles)
  );
  const [workspacePolicyBundle, setWorkspacePolicyBundle] = useState<WorkspacePolicyBundleResult | null>(null);
  const [workspacePolicyBundleLoading, setWorkspacePolicyBundleLoading] = useState(false);
  const [workspacePolicyBundleError, setWorkspacePolicyBundleError] = useState<string | null>(null);
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSectionId>(focusSection ?? "models");
  const activeSettingsSectionItem = SETTINGS_SECTIONS.find((section) => section.id === activeSettingsSection) ?? SETTINGS_SECTIONS[0];
  const formSettingsSection = ["models", "browser", "integrations", "permissions"].includes(activeSettingsSection);
  const selectedProvider = providers.find((provider) => provider.id === activeProviderId) ?? providers[0];
  const selectedWebSearchProvider =
    webSearchProviders.find((provider) => provider.id === activeWebSearchProviderId) ?? webSearchProviders[0];
  const selectedWebSearchProviderRequiresKey = selectedWebSearchProvider
    ? webSearchProviderRequiresApiKey(selectedWebSearchProvider.kind)
    : false;
  const selectedWebSearchProviderApiKeyPresent = Boolean(
    selectedWebSearchProvider?.apiKeyPresent || selectedWebSearchProvider?.apiKey?.trim()
  );
  const baseUrl = selectedProvider?.baseUrl ?? state.config.baseUrl;
  const model = selectedProvider?.model ?? state.config.model;
  const apiKey = selectedProvider?.apiKey ?? "";
  const selectedProviderApiKeyPresent = Boolean(selectedProvider?.apiKeyPresent || apiKey.trim());
  const browserTaskProvider =
    (browserTaskProviderId ? providers.find((provider) => provider.id === browserTaskProviderId) : selectedProvider) ?? selectedProvider;
  const browserTaskBaseUrl = browserTaskProvider?.baseUrl ?? baseUrl;
  const browserTaskProviderModel = browserTaskProvider?.model ?? model;
  const browserTaskEffectiveModel = browserTaskModelId.trim() || browserTaskProviderModel;
  const browserTaskApiKey = browserTaskProvider?.apiKey ?? "";
  const browserVisualGroundingProvider =
    browserVisualGroundingProviderId && browserVisualGroundingProviderId !== "__custom__"
      ? providers.find((provider) => provider.id === browserVisualGroundingProviderId)
      : undefined;
  const browserVisualGroundingBaseUrl =
    browserVisualGroundingProvider?.baseUrl ??
    (browserVisualGroundingProviderId === "__custom__" ? state.config.browserVisualGrounding?.baseUrl : undefined) ??
    "";
  const browserVisualGroundingEffectiveModel =
    browserVisualGroundingModel.trim() || browserVisualGroundingProvider?.model || "nvidia/LocateAnything-3B";
  const browserFallbackModelPicker = browserTaskFallbacks.find((fallback) => fallback.id === browserFallbackModelDialogId);
  const browserFallbackProvider =
    providers.find((provider) => provider.id === browserFallbackModelPicker?.providerId) ?? browserTaskProvider;

  useEffect(() => {
    if (!focusSection) {
      return;
    }
    setActiveSettingsSection(focusSection);
    onFocusSettled();
  }, [focusSection, onFocusSettled]);

  useEffect(() => {
    setToolProposals(state.config.toolProposals ?? []);
  }, [state.config.toolProposals]);

  useEffect(() => {
    void refreshTaskWorktrees();
    void refreshCapabilityPolicies();
    void refreshWorkspacePolicyBundle();
  }, [state.workspace.root]);

  function updateSelectedProvider(patch: Partial<ProviderFormState>) {
    setProviders((current) => current.map((provider) => (provider.id === activeProviderId ? { ...provider, ...patch } : provider)));
  }

  function addProvider() {
    const name = uniqueProviderName(NEW_PROVIDER_NAME, providers);
    const nextProvider: ProviderFormState = {
      id: uniqueProviderId(name, providers),
      name,
      baseUrl: "",
      model: "",
      toolCalling: "auto",
      imageInput: "auto",
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
    if (browserTaskProviderId === selectedProvider.id) {
      setBrowserTaskProviderId("");
      setBrowserTaskModelId("");
    }
    setBrowserTaskFallbacks((current) =>
      current.map((fallback) => (fallback.providerId === selectedProvider.id ? { ...fallback, providerId: "" } : fallback))
    );
  }

  function updateSelectedWebSearchProvider(patch: Partial<WebSearchProviderFormState>) {
    setWebSearchProviders((current) =>
      current.map((provider) => (provider.id === activeWebSearchProviderId ? { ...provider, ...patch } : provider))
    );
  }

  function addWebSearchProvider() {
    const preset = WEB_SEARCH_PROVIDER_PRESETS[NEW_WEB_SEARCH_PROVIDER_KIND];
    const name = uniqueWebSearchProviderName(preset.name, webSearchProviders);
    const nextProvider: WebSearchProviderFormState = {
      id: uniqueWebSearchProviderId(NEW_WEB_SEARCH_PROVIDER_KIND, webSearchProviders),
      name,
      kind: NEW_WEB_SEARCH_PROVIDER_KIND,
      baseUrl: preset.baseUrl,
      apiKey: ""
    };
    setWebSearchProviders((current) => [...current, nextProvider]);
    setActiveWebSearchProviderId(nextProvider.id);
  }

  function removeSelectedWebSearchProvider() {
    if (webSearchProviders.length <= 1 || !selectedWebSearchProvider) {
      return;
    }
    const nextProviders = webSearchProviders.filter((provider) => provider.id !== selectedWebSearchProvider.id);
    setWebSearchProviders(nextProviders);
    setActiveWebSearchProviderId(nextProviders[0]?.id ?? "bing");
  }

  function changeSelectedWebSearchProviderKind(kind: WebSearchProviderKind) {
    if (!selectedWebSearchProvider) {
      return;
    }
    const currentPreset = WEB_SEARCH_PROVIDER_PRESETS[selectedWebSearchProvider.kind];
    const nextPreset = WEB_SEARCH_PROVIDER_PRESETS[kind];
    const usePresetName =
      !selectedWebSearchProvider.name.trim() || generatedWebSearchProviderName(selectedWebSearchProvider.name, currentPreset.name);
    updateSelectedWebSearchProvider({
      kind,
      baseUrl: nextPreset.baseUrl,
      ...(usePresetName ? { name: uniqueWebSearchProviderName(nextPreset.name, webSearchProviders, selectedWebSearchProvider.id) } : {}),
      apiKey: "",
      apiKeyPresent: false
    });
  }

  function addBrowserTaskFallback() {
    if (browserTaskFallbacks.length >= MAX_BROWSER_TASK_FALLBACKS) {
      return;
    }
    const fallbackProvider =
      providers.find((provider) => provider.id !== browserTaskProviderId) ??
      providers.find((provider) => provider.id === browserTaskProviderId);
    setBrowserTaskFallbacks((current) => [
      ...current,
      {
        id: randomId(),
        providerId: fallbackProvider?.id ?? "",
        model: ""
      }
    ]);
  }

  function updateBrowserTaskFallback(id: string, patch: Partial<Omit<BrowserFallbackFormState, "id">>) {
    setBrowserTaskFallbacks((current) => current.map((fallback) => (fallback.id === id ? { ...fallback, ...patch } : fallback)));
  }

  function moveBrowserTaskFallback(id: string, direction: -1 | 1) {
    setBrowserTaskFallbacks((current) => {
      const index = current.findIndex((fallback) => fallback.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
      return next;
    });
  }

  function addReviewedToolProposal(proposal: McpToolProposal) {
    setError(null);
    try {
      const servers = parseMcpServersText(mcpServersText);
      const serverName = uniqueMcpServerName(proposal.name, servers);
      const env = Object.fromEntries(proposal.envKeys.map((key) => [key, ""]));
      const nextServers = {
        ...servers,
        [serverName]: {
          command: proposal.command,
          args: proposal.args,
          env,
          disabled: true
        }
      };
      setMcpServersText(JSON.stringify(nextServers, null, 2));
      setToolProposals((current) => current.filter((item) => item.id !== proposal.id));
      setIntegrationStatus(`${serverName} added as disabled. Review credentials and enable it in the MCP JSON before saving.`);
    } catch (err) {
      setError(formatError(err));
    }
  }

  function dismissToolProposal(id: string) {
    setToolProposals((current) => current.filter((proposal) => proposal.id !== id));
    setIntegrationStatus("Tool proposal dismissed. Save settings to confirm.");
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const mcpServers = parseMcpServersText(mcpServersText);
      const providerPatch = validateProviderForms(providers, activeProviderId);
      const webSearchProviderPatch = validateWebSearchProviderForms(webSearchProviders, activeWebSearchProviderId);
      const fallbackModels = browserTaskFallbacks
        .map((fallback) => ({
          providerId: fallback.providerId.trim() || undefined,
          model: fallback.model.trim() || undefined
        }))
        .filter((fallback) => fallback.providerId || fallback.model);
      const patch: ConfigPatch = {
        activeProviderId: providerPatch.activeProviderId,
        providers: providerPatch.providers,
        activeWebSearchProviderId: webSearchProviderPatch.activeProviderId,
        webSearchProviders: webSearchProviderPatch.providers,
        baseUrl: providerPatch.activeProvider.baseUrl,
        model: providerPatch.activeProvider.model,
        toolCalling: providerPatch.activeProvider.toolCalling,
        imageInput: providerPatch.activeProvider.imageInput,
        chatModelRequestDelayMs: parseBoundedSettingsInt(chatModelRequestDelayMs, 0, 120_000) ?? 10_000,
        trustMode,
        customSystemPrompt,
        mcpServers,
        workspacePolicies: updateWorkspacePoliciesForRoot(
          state.config.workspacePolicies,
          state.workspace.root,
          workspacePolicyOverrides,
          workspaceScopeRules
        ),
        workspacePolicyProfiles,
        toolProposals,
        browserTaskModel:
          browserTaskProviderId.trim() ||
          browserTaskModelId.trim() ||
          fallbackModels.length > 0 ||
          parseOptionalInt(browserTaskMaxSteps) !== undefined ||
          parseOptionalInt(browserTaskStepDelayMs) !== undefined
            ? {
                providerId: browserTaskProviderId.trim() || undefined,
                model: browserTaskModelId.trim() || undefined,
                maxSteps: parseOptionalInt(browserTaskMaxSteps),
                stepDelayMs: parseOptionalInt(browserTaskStepDelayMs),
                fallbackModels
              }
            : null,
        browserVisualGrounding: browserVisualGroundingProviderId
          ? {
              providerId: browserVisualGroundingProviderId === "__custom__" ? undefined : browserVisualGroundingProviderId,
              model: browserVisualGroundingModel.trim() || "nvidia/LocateAnything-3B"
            }
          : null
      };
      if (providerPatch.activeProvider.apiKey?.trim()) {
        patch.apiKey = providerPatch.activeProvider.apiKey.trim();
      }
      const next = await window.arivu.saveConfig(patch);
      onSaved(next);
      const savedWebSearchProviders = webSearchProviderFormsFromConfig(next.config);
      setWebSearchProviders(savedWebSearchProviders);
      setActiveWebSearchProviderId(
        next.config.activeWebSearchProviderId &&
          savedWebSearchProviders.some((provider) => provider.id === next.config.activeWebSearchProviderId)
          ? next.config.activeWebSearchProviderId
          : (savedWebSearchProviders[0]?.id ?? "bing")
      );
      const policyResult = await window.arivu.listCapabilityPolicies();
      setCapabilityPolicies(policyResult.policies);
      setCapabilityPolicySource(policyResult.source);
      setWorkspacePolicyOverrides(policyResult.workspaceOverrides);
      setWorkspaceScopeRules(policyResult.workspaceScopeRules);
      setWorkspacePolicyProfiles(normalizeWorkspacePolicyProfiles(next.config.workspacePolicyProfiles));
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
        activeProviderId: selectedProvider?.id,
        baseUrl,
        model,
        apiKey: apiKey.trim() || undefined,
        activeWebSearchProviderId,
        webSearchProviders: validateWebSearchProviderForms(webSearchProviders, activeWebSearchProviderId).providers,
        toolCalling: selectedProvider?.toolCalling ?? "auto",
        imageInput: selectedProvider?.imageInput ?? "auto",
        trustMode
      });
      setDoctorReport(report);
      applyDoctorCapabilityObservations(report);
      if (report.capabilityObservations?.length) {
        onStateUpdated(await window.arivu.getState());
      }
    } catch (err) {
      setDoctorError(formatError(err));
    } finally {
      setDoctorRunning(false);
    }
  }

  function applyDoctorCapabilityObservations(report: DoctorReport) {
    if (!selectedProvider || !report.capabilityObservations?.length) {
      return;
    }

    const patch: Partial<ProviderFormState> = {};
    for (const observation of report.capabilityObservations) {
      if (observation.value !== "disabled") {
        continue;
      }
      if (observation.capability === "toolCalling" && selectedProvider.toolCalling === "auto") {
        patch.toolCalling = "disabled";
      }
      if (observation.capability === "imageInput" && selectedProvider.imageInput === "auto") {
        patch.imageInput = "disabled";
      }
    }
    if (Object.keys(patch).length > 0) {
      updateSelectedProvider(patch);
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

  async function refreshTaskWorktrees(showStatus = false) {
    setWorktreeInventoryLoading(true);
    setWorktreeInventoryError(null);
    try {
      const result = await window.arivu.listTaskWorktrees();
      setWorktreeInventory(result.worktrees);
      if (showStatus) {
        setWorktreeInventoryStatus("Task worktrees refreshed");
      }
    } catch (err) {
      setWorktreeInventoryError(formatError(err));
    } finally {
      setWorktreeInventoryLoading(false);
    }
  }

  async function refreshCapabilityPolicies() {
    setCapabilityPolicyLoading(true);
    setCapabilityPolicyError(null);
    try {
      const result = await window.arivu.listCapabilityPolicies();
      setCapabilityPolicies(result.policies);
      setCapabilityPolicySource(result.source);
      setWorkspacePolicyOverrides(result.workspaceOverrides);
      setWorkspaceScopeRules(result.workspaceScopeRules);
    } catch (err) {
      setCapabilityPolicyError(formatError(err));
    } finally {
      setCapabilityPolicyLoading(false);
    }
  }

  async function refreshWorkspacePolicyBundle() {
    setWorkspacePolicyBundleLoading(true);
    setWorkspacePolicyBundleError(null);
    try {
      setWorkspacePolicyBundle(await window.arivu.readWorkspacePolicyBundle());
    } catch (err) {
      setWorkspacePolicyBundle(null);
      setWorkspacePolicyBundleError(formatError(err));
    } finally {
      setWorkspacePolicyBundleLoading(false);
    }
  }

  async function openInventoryWorktree(item: TaskWorktreeInventoryItem) {
    await runInventoryWorktreeAction(item, "open");
  }

  async function runInventoryWorktreeAction(item: TaskWorktreeInventoryItem, action: TaskWorktreeAction) {
    if (!["open", "discard", "cleanup", "prepare_pr", "create_pr"].includes(action)) {
      return;
    }
    if (action !== "open" && !confirmInventoryWorktreeAction(item, action)) {
      return;
    }
    const busyKey = `${item.sessionId}:${item.taskRunId}:${action}`;
    setWorktreeInventoryBusy(busyKey);
    setWorktreeInventoryError(null);
    setWorktreeInventoryStatus(null);
    try {
      const next = await window.arivu.taskWorktreeAction({
        sessionId: item.sessionId,
        taskRunId: item.taskRunId,
        action
      });
      if (action !== "open") {
        onStateUpdated(next);
        await refreshTaskWorktrees();
      }
      setWorktreeInventoryStatus(taskWorktreeActionStatus(action));
    } catch (err) {
      setWorktreeInventoryError(formatError(err));
    } finally {
      setWorktreeInventoryBusy((current) => (current === busyKey ? null : current));
    }
  }

  return (
    <section className="settings-panel">
      <header className="settings-header">
        <div className="settings-header-copy">
          <span>Settings</span>
          <h2 id="settings-section-title">{activeSettingsSectionItem.label}</h2>
          <p>{activeSettingsSectionItem.description}</p>
        </div>
        <button className="save-button" type="button" onClick={() => void save()} disabled={saving}>
          <Save size={17} />
          {saving ? "Saving" : "Save settings"}
        </button>
      </header>

      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((section) => {
            const SectionIcon = section.icon;
            const active = section.id === activeSettingsSection;
            return (
              <button
                key={section.id}
                className={active ? "settings-navigation-item active" : "settings-navigation-item"}
                type="button"
                onClick={() => setActiveSettingsSection(section.id)}
                aria-current={active ? "page" : undefined}
                data-settings-section={section.id}
              >
                <span className="settings-navigation-icon">
                  <SectionIcon size={16} />
                </span>
                <span className="settings-navigation-copy">
                  <strong>{section.label}</strong>
                </span>
                <ChevronRight className="settings-navigation-chevron" size={14} />
              </button>
            );
          })}
        </nav>

        <div className="settings-content" aria-labelledby="settings-section-title">
          {error ? <div className="error-strip settings-save-error">{error}</div> : null}

          <div
            className="settings-grid"
            hidden={!formSettingsSection}
            data-settings-panel={formSettingsSection ? activeSettingsSection : undefined}
          >
            <label className="provider-field" hidden={activeSettingsSection !== "models"}>
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
                <button
                  className="icon-button compact-icon-button"
                  type="button"
                  onClick={removeSelectedProvider}
                  disabled={providers.length <= 1}
                  title="Remove provider"
                  aria-label="Remove provider"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <small className="field-note">Save multiple OpenAI-compatible providers and switch the active runtime here.</small>
            </label>
            <label hidden={activeSettingsSection !== "models"}>
              <span>Provider name</span>
              <input value={selectedProvider?.name ?? ""} onChange={(event) => updateSelectedProvider({ name: event.target.value })} />
            </label>
            <label className="base-url-field" hidden={activeSettingsSection !== "models"}>
              <span>Base URL</span>
              <input value={baseUrl} onChange={(event) => updateSelectedProvider({ baseUrl: event.target.value })} />
            </label>
            <label className="model-field" hidden={activeSettingsSection !== "models"}>
              <span>Model</span>
              <div className="model-picker">
                <button className="model-dialog-trigger settings-model-trigger" type="button" onClick={() => setModelDialogOpen(true)}>
                  <Cpu size={15} />
                  <span>{modelDisplayName(model)}</span>
                  <Search size={13} />
                </button>
              </div>
              <input
                value={model}
                onChange={(event) => updateSelectedProvider({ model: event.target.value })}
                placeholder="Enter model id"
              />
              <small className="field-note">Choose Auto, use search, or enter a model id manually.</small>
            </label>
            <label className="api-key-field" hidden={activeSettingsSection !== "models"}>
              <span>API key</span>
              <input
                value={apiKey}
                onChange={(event) => updateSelectedProvider({ apiKey: event.target.value })}
                type="password"
                placeholder={selectedProviderApiKeyPresent ? "Saved. Enter a new key to replace it." : "No key saved for this provider."}
              />
            </label>
            <label hidden={activeSettingsSection !== "models"}>
              <span>Tool calling</span>
              <select
                value={selectedProvider?.toolCalling ?? "auto"}
                onChange={(event) => updateSelectedProvider({ toolCalling: event.target.value as ProviderToolCallingMode })}
              >
                <option value="auto">Auto fallback</option>
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
              <small className="field-note">Disable for plain-chat endpoints that reject OpenAI tool schemas.</small>
            </label>
            <label hidden={activeSettingsSection !== "models"}>
              <span>Image input</span>
              <select
                value={selectedProvider?.imageInput ?? "auto"}
                onChange={(event) => updateSelectedProvider({ imageInput: event.target.value as ProviderImageInputMode })}
              >
                <option value="auto">Auto</option>
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
              <small className="field-note">Disable for text-only endpoints; enable for models that accept OpenAI image parts.</small>
            </label>
            <label hidden={activeSettingsSection !== "models"}>
              <span>Context window (tokens)</span>
              <input
                value={selectedProvider?.contextWindowTokens ?? ""}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  updateSelectedProvider({ contextWindowTokens: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined });
                }}
                type="number"
                min={1000}
                step={1000}
                placeholder="Auto (uses conservative default)"
              />
              <small className="field-note">
                This model's context window. Sets when Arivu compacts requests; leave blank for the default.
              </small>
            </label>
            <label hidden={activeSettingsSection !== "models"}>
              <span>Main chat-model request delay (ms)</span>
              <input
                type="number"
                min={0}
                max={120000}
                step={500}
                value={chatModelRequestDelayMs}
                onChange={(event) => setChatModelRequestDelayMs(event.target.value)}
              />
              <small className="field-note">
                Pause between successive main chat-model provider calls in one run. 0 disables it. Does not control browser_task loop
                pacing.
              </small>
            </label>
            <section
              className="search-provider-manager"
              hidden={activeSettingsSection !== "integrations"}
              aria-labelledby="search-provider-manager-title"
              data-search-provider-manager
            >
              <div className="search-provider-manager-header">
                <div>
                  <span className="settings-eyebrow">Web search</span>
                  <h3 id="search-provider-manager-title">Search providers</h3>
                  <p>Choose the service used by both chat and browser-agent searches.</p>
                </div>
                <span className="search-provider-status">
                  {selectedWebSearchProviderRequiresKey
                    ? selectedWebSearchProviderApiKeyPresent
                      ? "Key saved"
                      : "Key missing"
                    : "No key required"}
                </span>
              </div>

              <label className="search-provider-picker-field">
                <span>Active provider</span>
                <div className="provider-picker">
                  <select
                    value={activeWebSearchProviderId}
                    onChange={(event) => setActiveWebSearchProviderId(event.target.value)}
                    data-search-provider-select
                  >
                    {webSearchProviders.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name.trim() || "Unnamed provider"}
                      </option>
                    ))}
                  </select>
                  <button className="secondary-command" type="button" onClick={addWebSearchProvider}>
                    <Plus size={15} />
                    Add provider
                  </button>
                  <button
                    className="icon-button compact-icon-button"
                    type="button"
                    onClick={removeSelectedWebSearchProvider}
                    disabled={webSearchProviders.length <= 1}
                    title="Remove search provider"
                    aria-label="Remove search provider"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </label>

              <div className="search-provider-fields">
                <label>
                  <span>Display name</span>
                  <input
                    value={selectedWebSearchProvider?.name ?? ""}
                    onChange={(event) => updateSelectedWebSearchProvider({ name: event.target.value })}
                  />
                </label>
                <label>
                  <span>Provider type</span>
                  <select
                    value={selectedWebSearchProvider?.kind ?? NEW_WEB_SEARCH_PROVIDER_KIND}
                    onChange={(event) => changeSelectedWebSearchProviderKind(event.target.value as WebSearchProviderKind)}
                  >
                    {WEB_SEARCH_PROVIDER_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {WEB_SEARCH_PROVIDER_PRESETS[kind].name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="search-provider-endpoint-field">
                  <span>Search endpoint</span>
                  <input
                    value={selectedWebSearchProvider?.baseUrl ?? ""}
                    onChange={(event) => updateSelectedWebSearchProvider({ baseUrl: event.target.value })}
                    inputMode="url"
                  />
                  <small className="field-note">Edit only when using a compatible gateway or proxy.</small>
                </label>
                {selectedWebSearchProviderRequiresKey ? (
                  <label className="search-provider-key-field">
                    <span>API key</span>
                    <input
                      value={selectedWebSearchProvider?.apiKey ?? ""}
                      onChange={(event) => updateSelectedWebSearchProvider({ apiKey: event.target.value })}
                      type="password"
                      autoComplete="off"
                      placeholder={
                        selectedWebSearchProviderApiKeyPresent
                          ? "Saved. Enter a new key to replace it."
                          : `Enter a ${selectedWebSearchProvider?.name || "provider"} API key.`
                      }
                    />
                  </label>
                ) : (
                  <div className="search-provider-keyless-note">
                    Bing RSS works without an account. Search requests still use the normal network approval.
                  </div>
                )}
              </div>
            </section>
            <label hidden={activeSettingsSection !== "permissions"}>
              <span>Trust mode</span>
              <select value={trustMode} onChange={(event) => setTrustMode(event.target.value as TrustMode)}>
                <option value="ask">ask</option>
                <option value="readonly">readonly</option>
                <option value="trusted">trusted</option>
              </select>
            </label>
            <label className="custom-system-prompt-field" hidden={activeSettingsSection !== "permissions"}>
              <span>Custom system prompt</span>
              <textarea
                value={customSystemPrompt}
                onChange={(event) => setCustomSystemPrompt(event.target.value)}
                rows={6}
                placeholder="Appended to the end of Arivu's built-in system prompt on every run, in every chat. Use for standing instructions the built-in prompt doesn't know about, e.g. routing browser actions through a specific MCP server instead of the disabled native tools."
              />
              <small className="field-note">
                Persists across new chats, unlike a one-off pasted instruction. Leave blank to use only the built-in prompt.
              </small>
            </label>
            <label hidden={activeSettingsSection !== "browser"}>
              <span>Browser task LLM</span>
              <select
                value={browserTaskProviderId}
                onChange={(event) => {
                  setBrowserTaskProviderId(event.target.value);
                  setBrowserTaskModelId("");
                }}
              >
                <option value="">Same as chat model</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name.trim() || "Unnamed provider"}
                  </option>
                ))}
              </select>
              <small className="field-note">
                Provider the in-page browser_task agent uses for its own model calls. Defaults to the active chat model.
              </small>
            </label>
            <label className="browser-task-model-field" hidden={activeSettingsSection !== "browser"}>
              <span>Browser task model</span>
              <div className="browser-task-model-picker">
                <button
                  className="model-dialog-trigger settings-model-trigger"
                  type="button"
                  onClick={() => setBrowserTaskModelDialogOpen(true)}
                  aria-label={`Choose browser task model. Current model: ${modelDisplayName(browserTaskEffectiveModel)}`}
                >
                  <Cpu size={15} />
                  <span>
                    {browserTaskModelId.trim()
                      ? modelDisplayName(browserTaskModelId)
                      : `Provider default: ${modelDisplayName(browserTaskProviderModel)}`}
                  </span>
                  <Search size={13} />
                </button>
                {browserTaskModelId.trim() ? (
                  <button
                    className="icon-button compact-icon-button"
                    type="button"
                    onClick={() => setBrowserTaskModelId("")}
                    title="Use provider default model"
                    aria-label="Use provider default browser task model"
                  >
                    <RotateCcw size={14} />
                  </button>
                ) : null}
              </div>
              <input
                value={browserTaskModelId}
                onChange={(event) => setBrowserTaskModelId(event.target.value)}
                placeholder="Or enter a model ID manually"
              />
              <small className="field-note">
                Choose from the provider's models or enter an ID manually. Use a model with strong native tool calling.
              </small>
            </label>
            <label hidden={activeSettingsSection !== "browser"}>
              <span>Browser task max loops</span>
              <input
                type="number"
                min={1}
                max={200}
                value={browserTaskMaxSteps}
                onChange={(event) => setBrowserTaskMaxSteps(event.target.value)}
                placeholder="100 (default)"
              />
              <small className="field-note">Maximum observe/act loops per browser_task call, from 1 to 200.</small>
            </label>
            <label hidden={activeSettingsSection !== "browser"}>
              <span>Browser task loop delay (ms)</span>
              <input
                type="number"
                min={0}
                max={120000}
                step={500}
                value={browserTaskStepDelayMs}
                onChange={(event) => setBrowserTaskStepDelayMs(event.target.value)}
                placeholder="35000 (default)"
              />
              <small className="field-note">
                Pause between agent loops, from 0 to 120000 ms. Defaults to 35000 ms; provider rate-limit responses are also retried with
                backoff automatically.
              </small>
            </label>
            <label hidden={activeSettingsSection !== "browser"}>
              <span>Visual grounding</span>
              <select
                value={browserVisualGroundingProviderId}
                onChange={(event) => {
                  setBrowserVisualGroundingProviderId(event.target.value);
                  setBrowserVisualGroundingModelDialogOpen(false);
                }}
              >
                <option value="">Off — DOM actions only</option>
                {state.config.browserVisualGrounding?.baseUrl && !state.config.browserVisualGrounding.providerId ? (
                  <option value="__custom__">Custom endpoint from config</option>
                ) : null}
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name.trim() || "Unnamed provider"}
                  </option>
                ))}
              </select>
              <small className="field-note">
                Optional fallback for pixel-only controls. Choose a saved provider running LocateAnything through an OpenAI-compatible
                endpoint.
              </small>
            </label>
            <label className="visual-grounding-model-field" hidden={activeSettingsSection !== "browser"}>
              <span>LocateAnything model</span>
              <div className="browser-task-model-picker">
                <button
                  className="model-dialog-trigger settings-model-trigger"
                  type="button"
                  onClick={() => setBrowserVisualGroundingModelDialogOpen(true)}
                  disabled={!browserVisualGroundingProviderId || !browserVisualGroundingBaseUrl}
                  aria-label={`Choose visual grounding model. Current model: ${modelDisplayName(browserVisualGroundingEffectiveModel)}`}
                >
                  <Cpu size={15} />
                  <span>{modelDisplayName(browserVisualGroundingEffectiveModel)}</span>
                  <Search size={13} />
                </button>
              </div>
              <input
                value={browserVisualGroundingModel}
                onChange={(event) => setBrowserVisualGroundingModel(event.target.value)}
                disabled={!browserVisualGroundingProviderId}
                placeholder="Or enter a model ID manually"
              />
              <small className="field-note">
                Choose from the visual provider&apos;s models or enter an ID manually. Uses NVIDIA&apos;s official point-grounding format;
                the released model is licensed for non-commercial research.
              </small>
            </label>
          </div>

          <section className="browser-fallback-section" hidden={activeSettingsSection !== "browser"} aria-label="Browser model fallbacks">
            <div className="settings-section-heading">
              <div>
                <strong>Fallback order</strong>
                <span>Arivu rotates only when the current model fails before making browser progress.</span>
              </div>
              <button
                className="secondary-command"
                type="button"
                onClick={addBrowserTaskFallback}
                disabled={browserTaskFallbacks.length >= MAX_BROWSER_TASK_FALLBACKS}
              >
                <Plus size={15} />
                Add fallback
              </button>
            </div>

            {browserTaskFallbacks.length === 0 ? (
              <div className="browser-fallback-empty">
                No fallback configured. Infrastructure failures pause the browser task until this model recovers or you select another one.
              </div>
            ) : (
              <div className="browser-fallback-list">
                {browserTaskFallbacks.map((fallback, index) => {
                  const fallbackProvider = providers.find((provider) => provider.id === fallback.providerId);
                  const fallbackModel = fallback.model.trim() || fallbackProvider?.model || "Choose model";
                  return (
                    <article key={fallback.id} className="browser-fallback-row">
                      <span className="browser-fallback-order" aria-label={`Fallback ${index + 1}`}>
                        {index + 1}
                      </span>
                      <div className="browser-fallback-fields">
                        <label>
                          <span>Provider</span>
                          <select
                            value={fallback.providerId}
                            onChange={(event) =>
                              updateBrowserTaskFallback(fallback.id, {
                                providerId: event.target.value,
                                model: ""
                              })
                            }
                          >
                            <option value="">Same as primary</option>
                            {providers.map((provider) => (
                              <option key={provider.id} value={provider.id}>
                                {provider.name.trim() || "Unnamed provider"}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>Model</span>
                          <div className="browser-task-model-picker">
                            <button
                              className="model-dialog-trigger settings-model-trigger"
                              type="button"
                              onClick={() => setBrowserFallbackModelDialogId(fallback.id)}
                              aria-label={`Choose fallback ${index + 1} model. Current model: ${modelDisplayName(fallbackModel)}`}
                            >
                              <Cpu size={15} />
                              <span>{modelDisplayName(fallbackModel)}</span>
                              <Search size={13} />
                            </button>
                          </div>
                          <input
                            value={fallback.model}
                            onChange={(event) => updateBrowserTaskFallback(fallback.id, { model: event.target.value })}
                            placeholder={fallbackProvider?.model ? `Provider default: ${fallbackProvider.model}` : "Enter model ID"}
                          />
                        </label>
                      </div>
                      <div className="browser-fallback-actions">
                        <button
                          className="icon-button compact-icon-button"
                          type="button"
                          onClick={() => moveBrowserTaskFallback(fallback.id, -1)}
                          disabled={index === 0}
                          title="Move fallback up"
                          aria-label={`Move fallback ${index + 1} up`}
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          className="icon-button compact-icon-button"
                          type="button"
                          onClick={() => moveBrowserTaskFallback(fallback.id, 1)}
                          disabled={index === browserTaskFallbacks.length - 1}
                          title="Move fallback down"
                          aria-label={`Move fallback ${index + 1} down`}
                        >
                          <ArrowDown size={14} />
                        </button>
                        <button
                          className="icon-button compact-icon-button"
                          type="button"
                          onClick={() => setBrowserTaskFallbacks((current) => current.filter((item) => item.id !== fallback.id))}
                          title="Remove fallback"
                          aria-label={`Remove fallback ${index + 1}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
            <small className="field-note">
              Configuration, network, rate-limit, and provider failures open a temporary circuit. After partial page progress, Arivu
              preserves the checkpoint and uses the next model on the following browser task instead of replaying actions blindly.
            </small>
          </section>

          <div hidden={activeSettingsSection !== "permissions"} data-settings-panel="permissions">
            <CapabilityPolicyPanel
              activeTrustMode={trustMode}
              policies={capabilityPolicies}
              source={capabilityPolicySource}
              workspaceRoot={state.workspace.root}
              workspaceOverrides={workspacePolicyOverrides}
              workspaceScopeRules={workspaceScopeRules}
              workspacePolicyProfiles={workspacePolicyProfiles}
              workspacePolicyBundle={workspacePolicyBundle}
              workspacePolicyBundleLoading={workspacePolicyBundleLoading}
              workspacePolicyBundleError={workspacePolicyBundleError}
              onWorkspaceOverrideChange={(capability, override) =>
                setWorkspacePolicyOverrides((current) => updateWorkspacePolicyOverride(current, capability, override))
              }
              onWorkspaceScopeRulesChange={setWorkspaceScopeRules}
              onWorkspacePolicyProfilesChange={setWorkspacePolicyProfiles}
              onWorkspacePresetApply={(preset) => {
                const normalizedPreset = normalizedWorkspacePolicyPreset(preset);
                setWorkspacePolicyOverrides(normalizedPreset.overrides);
                setWorkspaceScopeRules(normalizedPreset.scopeRules);
              }}
              onWorkspacePolicyImport={(policy) => {
                setWorkspacePolicyOverrides(policy.overrides);
                setWorkspaceScopeRules(policy.scopeRules);
              }}
              onWorkspacePolicyBundleReload={() => void refreshWorkspacePolicyBundle()}
              loading={capabilityPolicyLoading}
              error={capabilityPolicyError}
              onRefresh={() => void refreshCapabilityPolicies()}
            />
          </div>

          <section
            className="tool-proposals-section"
            hidden={activeSettingsSection !== "integrations"}
            data-settings-panel="integrations"
            aria-label="Proposed tools"
          >
            <div className="settings-section-heading">
              <div>
                <strong>Proposed tools</strong>
                <span>
                  {toolProposals.length === 0
                    ? "Arivu can propose MCP capabilities, but cannot activate them."
                    : `${toolProposals.length} waiting for review`}
                </span>
              </div>
              <Shield size={16} aria-hidden="true" />
            </div>
            {toolProposals.length === 0 ? (
              <div className="tool-proposal-empty">No tool proposals awaiting review.</div>
            ) : (
              <div className="tool-proposal-list">
                {toolProposals.map((proposal) => (
                  <article key={proposal.id} className="tool-proposal-row">
                    <div className="tool-proposal-copy">
                      <div>
                        <Server size={16} />
                        <strong>{proposal.name}</strong>
                        <span>MCP server</span>
                      </div>
                      {proposal.description ? <p>{proposal.description}</p> : null}
                      <code>{[proposal.command, ...proposal.args].join(" ")}</code>
                      {proposal.envKeys.length > 0 ? <small>Credentials requested: {proposal.envKeys.join(", ")}</small> : null}
                      <small>Reason: {proposal.reason}</small>
                    </div>
                    <div className="tool-proposal-actions">
                      <button className="secondary-command" type="button" onClick={() => dismissToolProposal(proposal.id)}>
                        <X size={15} />
                        Dismiss
                      </button>
                      <button className="secondary-command" type="button" onClick={() => addReviewedToolProposal(proposal)}>
                        <Plus size={15} />
                        Add disabled
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {integrationStatus ? <div className="success-strip">{integrationStatus}</div> : null}
          </section>

          <label className="mcp-config-field" hidden={activeSettingsSection !== "integrations"} data-settings-panel="integrations">
            <span>MCP servers</span>
            <textarea value={mcpServersText} onChange={(event) => setMcpServersText(event.target.value)} spellCheck={false} rows={8} />
            <small className="field-note">JSON object keyed by server name. Each server supports command, args, env, and disabled.</small>
          </label>

          <section
            className="skills-settings-section"
            aria-label="Skills"
            hidden={activeSettingsSection !== "skills"}
            data-settings-panel="skills"
          >
            <div className="settings-section-heading">
              <div>
                <strong>Skills</strong>
                <span title={skillsRoot}>
                  {skills.length} installed · {skillsRoot || "Global skills directory"}
                </span>
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
                <input
                  value={skillDescription}
                  onChange={(event) => setSkillDescription(event.target.value)}
                  placeholder="When this skill should be used"
                />
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

          <section
            className="skills-settings-section"
            aria-label="Task worktrees"
            hidden={activeSettingsSection !== "worktrees"}
            data-settings-panel="worktrees"
          >
            <div className="settings-section-heading">
              <div>
                <strong>Task worktrees</strong>
                <span>{taskWorktreeInventorySummary(worktreeInventory)}</span>
              </div>
              <button
                className="secondary-command"
                type="button"
                onClick={() => void refreshTaskWorktrees(true)}
                disabled={worktreeInventoryLoading}
              >
                <RefreshCw size={15} />
                {worktreeInventoryLoading ? "Refreshing" : "Refresh"}
              </button>
            </div>

            <div className="settings-worktree-list">
              {worktreeInventory.length === 0 ? (
                <div className="settings-skill-empty">No task worktrees recorded yet.</div>
              ) : (
                worktreeInventory.map((item) => {
                  const busyKey = `${item.sessionId}:${item.taskRunId}:open`;
                  return (
                    <article key={`${item.sessionId}:${item.taskRunId}`} className="settings-worktree-row">
                      <div className="settings-worktree-main">
                        <div>
                          <strong>{item.branch ?? "Task worktree"}</strong>
                          <span>{worktreeInventoryStatusLabel(item)}</span>
                        </div>
                        <p>{item.promptPreview || item.sessionTitle}</p>
                        {item.path ? <small title={item.path}>{item.path}</small> : null}
                      </div>
                      <div className="settings-worktree-meta">
                        <span>{item.changedFiles === undefined ? "diff unknown" : `${item.changedFiles} changed`}</span>
                        {item.verificationStatus ? (
                          <span
                            title={item.verificationSummary}
                          >{`verification ${verificationStatusLabel(item.verificationStatus).toLowerCase()}`}</span>
                        ) : null}
                        <span>{formatDateTime(item.updatedAt)}</span>
                      </div>
                      <div className="settings-worktree-actions">
                        <button
                          className="secondary-command"
                          type="button"
                          onClick={() => void openInventoryWorktree(item)}
                          disabled={!item.canOpen || worktreeInventoryBusy === busyKey}
                          title={item.canOpen ? "Open this task worktree folder" : "Task worktree folder is unavailable"}
                        >
                          <FolderOpen size={15} />
                          {worktreeInventoryBusy === busyKey ? "Opening" : "Open"}
                        </button>
                        {item.canPreparePullRequest ? (
                          <button
                            className="secondary-command"
                            type="button"
                            onClick={() => void runInventoryWorktreeAction(item, "prepare_pr")}
                            disabled={worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:prepare_pr`}
                            title="Prepare a pull request draft for this task worktree"
                          >
                            <GitPullRequest size={15} />
                            {worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:prepare_pr` ? "Preparing" : "PR draft"}
                          </button>
                        ) : null}
                        {item.canCreatePullRequest ? (
                          <button
                            className="secondary-command"
                            type="button"
                            onClick={() => void runInventoryWorktreeAction(item, "create_pr")}
                            disabled={worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:create_pr`}
                            title="Push this task branch and create a draft pull request"
                          >
                            <GitPullRequest size={15} />
                            {worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:create_pr` ? "Creating" : "Create PR"}
                          </button>
                        ) : null}
                        {item.canDiscard ? (
                          <button
                            className="secondary-command danger-command"
                            type="button"
                            onClick={() => void runInventoryWorktreeAction(item, "discard")}
                            disabled={worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:discard`}
                            title="Discard this task worktree and task branch"
                          >
                            <Trash2 size={15} />
                            {worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:discard` ? "Discarding" : "Discard"}
                          </button>
                        ) : null}
                        {item.canCleanup ? (
                          <button
                            className="secondary-command"
                            type="button"
                            onClick={() => void runInventoryWorktreeAction(item, "cleanup")}
                            disabled={worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:cleanup`}
                            title="Clean up this merged task worktree and task branch"
                          >
                            <Scissors size={15} />
                            {worktreeInventoryBusy === `${item.sessionId}:${item.taskRunId}:cleanup` ? "Cleaning" : "Clean up"}
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })
              )}
            </div>
            {worktreeInventoryError ? <div className="error-strip">{worktreeInventoryError}</div> : null}
            {worktreeInventoryStatus ? <div className="success-strip">{worktreeInventoryStatus}</div> : null}
          </section>

          <section
            className="settings-diagnostics"
            hidden={activeSettingsSection !== "diagnostics"}
            data-settings-panel="diagnostics"
            aria-label="Diagnostics"
          >
            <div className="settings-diagnostics-action">
              <div>
                <strong>Provider health</strong>
                <p>Check model access, streaming, tool calling, image input, and web search configuration.</p>
              </div>
              <button
                className="secondary-command doctor-button"
                type="button"
                onClick={() => void runSettingsDoctor()}
                disabled={doctorRunning}
              >
                <RefreshCw size={17} />
                {doctorRunning ? "Checking" : "Run doctor"}
              </button>
            </div>
            {doctorError ? <div className="error-strip">{doctorError}</div> : null}
            {doctorReport ? <DoctorReportView report={doctorReport} /> : null}
          </section>
        </div>
      </div>

      {modelDialogOpen ? (
        <ModelPickerDialog
          currentModel={model}
          baseUrl={baseUrl}
          apiKey={apiKey}
          providerId={selectedProvider?.id}
          onSelect={(nextModel) => {
            updateSelectedProvider({ model: nextModel });
            setModelDialogOpen(false);
          }}
          onClose={() => setModelDialogOpen(false)}
        />
      ) : null}
      {browserTaskModelDialogOpen ? (
        <ModelPickerDialog
          currentModel={browserTaskEffectiveModel}
          baseUrl={browserTaskBaseUrl}
          apiKey={browserTaskApiKey}
          providerId={browserTaskProvider?.id}
          includeAuto={false}
          title="Select browser task model"
          onSelect={(nextModel) => {
            // Pin the concrete model the user picked. Collapsing it to "" when it happens to match
            // the current chat model would turn the choice into a *relative* "follow the chat model"
            // reference, so any later chat-model change would silently drag the browser task model
            // along. The user must fall back to the chat model explicitly (the reset button below or
            // the "Same as chat model" provider option), never as a side effect of the two coinciding.
            setBrowserTaskModelId(nextModel);
            setBrowserTaskModelDialogOpen(false);
          }}
          onClose={() => setBrowserTaskModelDialogOpen(false)}
        />
      ) : null}
      {browserVisualGroundingModelDialogOpen ? (
        <ModelPickerDialog
          currentModel={browserVisualGroundingEffectiveModel}
          baseUrl={browserVisualGroundingBaseUrl}
          apiKey={browserVisualGroundingProvider?.apiKey ?? ""}
          providerId={browserVisualGroundingProvider?.id ?? "__visual_grounding_custom__"}
          includeAuto={false}
          title="Select visual grounding model"
          onSelect={(nextModel) => {
            setBrowserVisualGroundingModel(nextModel);
            setBrowserVisualGroundingModelDialogOpen(false);
          }}
          onClose={() => setBrowserVisualGroundingModelDialogOpen(false)}
        />
      ) : null}
      {browserFallbackModelPicker && browserFallbackProvider ? (
        <ModelPickerDialog
          currentModel={browserFallbackModelPicker.model.trim() || browserFallbackProvider.model}
          baseUrl={browserFallbackProvider.baseUrl}
          apiKey={browserFallbackProvider.apiKey ?? ""}
          providerId={browserFallbackProvider.id}
          includeAuto={false}
          title="Select fallback model"
          onSelect={(nextModel) => {
            updateBrowserTaskFallback(browserFallbackModelPicker.id, { model: nextModel });
            setBrowserFallbackModelDialogId(null);
          }}
          onClose={() => setBrowserFallbackModelDialogId(null)}
        />
      ) : null}
    </section>
  );
}

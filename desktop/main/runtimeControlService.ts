import type { BrowserTaskModelConfig } from "../../src/tools/browserControl.js";
import type {
  RuntimeBrowserModelChange,
  RuntimeBrowserModelSummary,
  RuntimeControl,
  RuntimeControlScope,
  RuntimeControlStatus,
  RuntimeMcpServerProposalInput,
  RuntimeMcpServerProposalResult,
  RuntimeToolStateChange
} from "../../src/tools/runtimeControl.js";

const PROTECTED_TOOL_NAMES = new Set(["ask_user"]);

type RuntimeControlServiceOptions = {
  configuredBrowserTaskModel: BrowserTaskModelConfig;
  activeBrowserTaskModel?: BrowserTaskModelConfig;
  readSavedDisabledTools: () => Promise<string[]>;
  sessionDisabledTools: Set<string>;
  onSessionBrowserModelChange: (model: BrowserTaskModelConfig) => void;
  onProposeMcpServer: (input: RuntimeMcpServerProposalInput) => Promise<RuntimeMcpServerProposalResult>;
};

type BrowserModelCandidate = {
  id: string;
  config: BrowserTaskModelConfig;
};

export class RuntimeControlService implements RuntimeControl {
  private readonly runDisabledTools = new Set<string>();
  private readonly availableToolNames = new Set<string>();
  private readonly candidates: BrowserModelCandidate[];
  private activeBrowserModel: BrowserTaskModelConfig;

  constructor(private readonly options: RuntimeControlServiceOptions) {
    this.candidates = browserModelCandidates(options.configuredBrowserTaskModel);
    this.activeBrowserModel = cloneBrowserModel(options.activeBrowserTaskModel ?? options.configuredBrowserTaskModel);
  }

  setAvailableToolNames(names: string[]) {
    this.availableToolNames.clear();
    for (const name of names) {
      if (name.trim()) {
        this.availableToolNames.add(name.trim());
      }
    }
  }

  async status(): Promise<RuntimeControlStatus> {
    const disabledTools = await this.disabledToolNames();
    return {
      browserModel: browserModelSummary("active", this.activeBrowserModel, true),
      browserModelCandidates: this.candidates.map((candidate) =>
        browserModelSummary(candidate.id, candidate.config, sameBrowserModel(candidate.config, this.activeBrowserModel))
      ),
      disabledTools,
      runDisabledTools: [...this.runDisabledTools].sort(),
      sessionDisabledTools: [...this.options.sessionDisabledTools].sort(),
      protectedTools: [...new Set([...PROTECTED_TOOL_NAMES, ...this.availableToolNames].filter((name) => isProtectedTool(name)))].sort(),
      toolProposalMode: "review_required"
    };
  }

  async setToolState(input: {
    name: string;
    enabled: boolean;
    scope: RuntimeControlScope;
    reason: string;
  }): Promise<RuntimeToolStateChange> {
    const name = input.name.trim();
    const reason = input.reason.trim();
    if (!name) {
      throw new Error("Tool name is required.");
    }
    if (!reason) {
      throw new Error("A reason is required for runtime changes.");
    }
    if (isProtectedTool(name)) {
      throw new Error(`${name} is part of Arivu's control boundary and cannot be disabled by the model.`);
    }
    if (this.availableToolNames.size > 0 && !this.availableToolNames.has(name)) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const target = input.scope === "session" ? this.options.sessionDisabledTools : this.runDisabledTools;
    if (input.enabled) {
      target.delete(name);
    } else {
      target.add(name);
    }

    const savedDisabled = new Set(await this.options.readSavedDisabledTools());
    const effectiveDisabled = savedDisabled.has(name) || this.runDisabledTools.has(name) || this.options.sessionDisabledTools.has(name);
    const note =
      input.enabled && effectiveDisabled
        ? savedDisabled.has(name)
          ? "The tool remains disabled in saved Settings; only the user can re-enable a saved tool."
          : "The tool remains disabled by another runtime scope."
        : undefined;

    return {
      name,
      requestedState: input.enabled ? "enabled" : "disabled",
      scope: input.scope,
      effectiveState: effectiveDisabled ? "disabled" : "enabled",
      reason,
      note
    };
  }

  async selectBrowserModel(input: { candidateId: string; scope: RuntimeControlScope; reason: string }): Promise<RuntimeBrowserModelChange> {
    const reason = input.reason.trim();
    if (!reason) {
      throw new Error("A reason is required for browser-model changes.");
    }
    const candidate = this.candidates.find((item) => item.id === input.candidateId.trim());
    if (!candidate) {
      throw new Error(`Unknown browser-model candidate: ${input.candidateId}`);
    }

    const candidateIndex = this.candidates.indexOf(candidate);
    this.activeBrowserModel = {
      ...cloneBrowserModel(candidate.config),
      fallbacks: this.candidates.slice(candidateIndex + 1).map((item) => withoutFallbacks(item.config))
    };
    if (this.activeBrowserModel.fallbacks?.length === 0) {
      delete this.activeBrowserModel.fallbacks;
    }
    if (input.scope === "session") {
      this.options.onSessionBrowserModelChange(cloneBrowserModel(this.activeBrowserModel));
    }

    return {
      candidateId: candidate.id,
      scope: input.scope,
      model: browserModelSummary(candidate.id, this.activeBrowserModel, true),
      reason
    };
  }

  proposeMcpServer(input: RuntimeMcpServerProposalInput): Promise<RuntimeMcpServerProposalResult> {
    return this.options.onProposeMcpServer(input);
  }

  currentBrowserTaskModel(): BrowserTaskModelConfig {
    return cloneBrowserModel(this.activeBrowserModel);
  }

  async disabledToolNames(): Promise<string[]> {
    const saved = await this.options.readSavedDisabledTools();
    return [...new Set([...saved, ...this.options.sessionDisabledTools, ...this.runDisabledTools])].sort();
  }
}

function browserModelCandidates(primary: BrowserTaskModelConfig): BrowserModelCandidate[] {
  const models = [withoutFallbacks(primary), ...(primary.fallbacks ?? []).map(withoutFallbacks)];
  const seen = new Set<string>();
  const candidates: BrowserModelCandidate[] = [];
  for (const model of models) {
    const key = browserModelKey(model);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({
      id: candidates.length === 0 ? "primary" : `fallback-${candidates.length}`,
      config: model
    });
  }
  return candidates;
}

function browserModelSummary(id: string, model: BrowserTaskModelConfig, active: boolean): RuntimeBrowserModelSummary {
  return {
    id,
    model: model.model,
    providerId: model.providerId,
    providerName: model.providerName,
    endpoint: safeEndpoint(model.baseUrl),
    active
  };
}

function withoutFallbacks(model: BrowserTaskModelConfig): BrowserTaskModelConfig {
  const { fallbacks: _fallbacks, ...candidate } = model;
  return { ...candidate };
}

function cloneBrowserModel(model: BrowserTaskModelConfig): BrowserTaskModelConfig {
  return {
    ...model,
    fallbacks: model.fallbacks?.map(withoutFallbacks)
  };
}

function sameBrowserModel(left: BrowserTaskModelConfig, right: BrowserTaskModelConfig) {
  return browserModelKey(left) === browserModelKey(right);
}

function browserModelKey(model: BrowserTaskModelConfig) {
  return `${safeEndpoint(model.baseUrl)}\n${model.model}`;
}

function safeEndpoint(baseUrl: string) {
  try {
    const endpoint = new URL(baseUrl);
    endpoint.username = "";
    endpoint.password = "";
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString().replace(/\/$/, "");
  } catch {
    return baseUrl.replace(/[?#].*$/, "").slice(0, 500);
  }
}

function isProtectedTool(name: string) {
  return name.startsWith("arivu_") || PROTECTED_TOOL_NAMES.has(name);
}

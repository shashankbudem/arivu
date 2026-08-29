import {
  mergeRedactedMcpServers,
  redactMcpServers,
  type AppConfig,
  type BrowserTaskModelConfigProfile,
  type BrowserVisualGroundingConfigProfile,
  type LlmProviderProfile,
  type McpToolProposal,
  type WebSearchProviderProfile
} from "../../src/config.js";
export { createDisabledToolsReader, normalizeDisabledTools, normalizeMcpServerProposalInput } from "../../src/harness/mcpProposals.js";

export type PublicBrowserTaskModelProfile = Omit<BrowserTaskModelConfigProfile, "apiKey" | "fallbackModels"> & {
  apiKeyPresent: boolean;
  fallbackModels?: PublicBrowserTaskModelProfile[];
};

export type PublicBrowserVisualGroundingProfile = Omit<BrowserVisualGroundingConfigProfile, "apiKey"> & {
  apiKeyPresent: boolean;
};

export type PublicLlmProviderProfile = Omit<LlmProviderProfile, "apiKey"> & {
  apiKeyPresent: boolean;
};

export type LlmProviderPatch = Omit<LlmProviderProfile, "apiKey"> & {
  apiKey?: string;
};

export type PublicWebSearchProviderProfile = Omit<WebSearchProviderProfile, "apiKey"> & {
  apiKeyPresent: boolean;
};

export type WebSearchProviderPatch = Omit<WebSearchProviderProfile, "apiKey"> & {
  apiKey?: string;
};

export type PublicConfig = {
  baseUrl: string;
  model: string;
  toolCalling: AppConfig["toolCalling"];
  imageInput: AppConfig["imageInput"];
  chatModelRequestDelayMs: number;
  activeProviderId?: string;
  providers: PublicLlmProviderProfile[];
  activeWebSearchProviderId?: string;
  webSearchProviders: PublicWebSearchProviderProfile[];
  browserTaskModel?: PublicBrowserTaskModelProfile;
  browserVisualGrounding?: PublicBrowserVisualGroundingProfile;
  trustMode: AppConfig["trustMode"];
  customSystemPrompt?: string;
  apiKeyPresent: boolean;
  mcpServers: AppConfig["mcpServers"];
  workspacePolicies: AppConfig["workspacePolicies"];
  workspacePolicyProfiles: AppConfig["workspacePolicyProfiles"];
  disabledTools: string[];
  toolProposals: McpToolProposal[];
};

export type ConfigPatch = {
  apiKey?: string;
  /** Legacy settings/CLI compatibility; the desktop UI uses webSearchProviders. */
  tavilyApiKey?: string;
  baseUrl?: string;
  model?: string;
  toolCalling?: AppConfig["toolCalling"];
  imageInput?: AppConfig["imageInput"];
  chatModelRequestDelayMs?: number;
  activeProviderId?: string;
  providers?: LlmProviderPatch[];
  activeWebSearchProviderId?: string;
  webSearchProviders?: WebSearchProviderPatch[];
  trustMode?: AppConfig["trustMode"];
  customSystemPrompt?: string;
  mcpServers?: AppConfig["mcpServers"];
  workspacePolicies?: AppConfig["workspacePolicies"];
  workspacePolicyProfiles?: AppConfig["workspacePolicyProfiles"];
  /** Settings-managed browser_task model override; null clears it back to "follow the chat model". */
  browserTaskModel?: {
    providerId?: string;
    model?: string;
    maxSteps?: number;
    stepDelayMs?: number;
    fallbackModels?: Array<{ providerId?: string; model?: string }>;
  } | null;
  /** Dedicated LocateAnything endpoint; null disables pixel-grounded browser clicks. */
  browserVisualGrounding?: {
    providerId?: string;
    model?: string;
  } | null;
  /** Full replacement list of tool names withheld from the agent; [] re-enables everything. */
  disabledTools?: string[];
  /** Review-only MCP server proposals. They cannot execute until the user adds them to mcpServers. */
  toolProposals?: McpToolProposal[];
};

export function toPublicConfig(config: AppConfig): PublicConfig {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    toolCalling: config.toolCalling,
    imageInput: config.imageInput,
    chatModelRequestDelayMs: config.chatModelRequestDelayMs,
    activeProviderId: config.activeProviderId,
    providers: config.providers.map(toPublicProvider),
    activeWebSearchProviderId: config.activeWebSearchProviderId,
    webSearchProviders: config.webSearchProviders.map(toPublicWebSearchProvider),
    browserTaskModel: config.browserTaskModel ? toPublicBrowserTaskModel(config.browserTaskModel) : undefined,
    browserVisualGrounding: config.browserVisualGrounding ? toPublicBrowserVisualGrounding(config.browserVisualGrounding) : undefined,
    trustMode: config.trustMode,
    customSystemPrompt: config.customSystemPrompt,
    apiKeyPresent: Boolean(config.apiKey),
    mcpServers: redactMcpServers(config.mcpServers),
    workspacePolicies: config.workspacePolicies,
    workspacePolicyProfiles: config.workspacePolicyProfiles,
    disabledTools: config.disabledTools ?? [],
    toolProposals: config.toolProposals ?? []
  };
}

export function mergeBrowserTaskModelPatch(
  saved: BrowserTaskModelConfigProfile | undefined,
  patch: {
    providerId?: string;
    model?: string;
    maxSteps?: number;
    stepDelayMs?: number;
    fallbackModels?: Array<{ providerId?: string; model?: string }>;
  } | null
): BrowserTaskModelConfigProfile | undefined {
  if (patch === null) {
    return undefined;
  }
  const merged: BrowserTaskModelConfigProfile = {
    ...saved,
    providerId: patch.providerId?.trim() || undefined,
    model: patch.model?.trim() || undefined,
    maxSteps: sanitizeSettingsInt(patch.maxSteps, 1, 200),
    stepDelayMs: sanitizeSettingsInt(patch.stepDelayMs, 0, 120_000),
    fallbackModels:
      patch.fallbackModels === undefined ? saved?.fallbackModels : mergeBrowserFallbackModels(saved?.fallbackModels, patch.fallbackModels)
  };
  return Object.values(merged).some((value) => value !== undefined) ? merged : undefined;
}

export function mergeBrowserVisualGroundingPatch(
  saved: BrowserVisualGroundingConfigProfile | undefined,
  patch: { providerId?: string; model?: string } | null
): BrowserVisualGroundingConfigProfile | undefined {
  if (patch === null) {
    return undefined;
  }
  const providerId = patch.providerId?.trim() || undefined;
  const model = patch.model?.trim() || "nvidia/LocateAnything-3B";
  if (!providerId && !saved?.baseUrl) {
    return undefined;
  }
  return {
    ...saved,
    providerId,
    model
  };
}

export function normalizeProviders(providers: LlmProviderPatch[], existingProviders: LlmProviderProfile[] = []): LlmProviderProfile[] {
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
      toolCalling: provider.toolCalling ?? "auto",
      imageInput: provider.imageInput ?? "auto",
      ...(provider.contextWindowTokens && provider.contextWindowTokens > 0 ? { contextWindowTokens: provider.contextWindowTokens } : {}),
      ...(apiKey ? { apiKey } : {})
    });
  }

  return normalized;
}

export function normalizeWebSearchProviders(
  providers: WebSearchProviderPatch[],
  existingProviders: WebSearchProviderProfile[] = []
): WebSearchProviderProfile[] {
  const existingById = new Map(existingProviders.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const normalized: WebSearchProviderProfile[] = [];

  for (const provider of providers) {
    const id = provider.id.trim();
    const name = provider.name.trim();
    const baseUrl = provider.baseUrl.trim();
    if (!id || !name || !baseUrl || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const existingProvider = existingById.get(id);
    const apiKey = provider.apiKey?.trim() || (existingProvider?.kind === provider.kind ? existingProvider.apiKey : undefined);
    normalized.push({
      id,
      name,
      kind: provider.kind,
      baseUrl,
      ...(apiKey ? { apiKey } : {})
    });
  }

  return normalized;
}

export function updateProviderRuntime(providers: LlmProviderProfile[], activeProviderId: string, patch: ConfigPatch): LlmProviderProfile[] {
  if (!patch.baseUrl?.trim() && !patch.model?.trim() && !patch.apiKey?.trim() && !patch.toolCalling && !patch.imageInput) {
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
      toolCalling: patch.toolCalling ?? provider.toolCalling,
      imageInput: patch.imageInput ?? provider.imageInput,
      ...(apiKey ? { apiKey } : {})
    };
  });
}

export function preserveProviderKeys(providers: LlmProviderProfile[], saved: AppConfig): LlmProviderProfile[] {
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

export function applyConfigPatch(config: AppConfig, patch: ConfigPatch): AppConfig {
  const webSearchProviders = patch.webSearchProviders
    ? normalizeWebSearchProviders(patch.webSearchProviders, config.webSearchProviders)
    : config.webSearchProviders;
  const requestedWebSearchProviderId =
    patch.activeWebSearchProviderId !== undefined ? patch.activeWebSearchProviderId.trim() || undefined : config.activeWebSearchProviderId;
  const activeWebSearchProviderId =
    (requestedWebSearchProviderId && webSearchProviders.some((provider) => provider.id === requestedWebSearchProviderId)
      ? requestedWebSearchProviderId
      : undefined) ?? webSearchProviders[0]?.id;

  return {
    ...config,
    apiKey: patch.apiKey?.trim() || config.apiKey,
    tavilyApiKey: patch.tavilyApiKey?.trim() || config.tavilyApiKey,
    baseUrl: patch.baseUrl?.trim() || config.baseUrl,
    model: patch.model?.trim() || config.model,
    toolCalling: patch.toolCalling ?? config.toolCalling,
    imageInput: patch.imageInput ?? config.imageInput,
    chatModelRequestDelayMs:
      patch.chatModelRequestDelayMs === undefined
        ? config.chatModelRequestDelayMs
        : (sanitizeSettingsInt(patch.chatModelRequestDelayMs, 0, 120_000) ?? config.chatModelRequestDelayMs),
    trustMode: patch.trustMode ?? config.trustMode,
    customSystemPrompt: patch.customSystemPrompt ?? config.customSystemPrompt,
    webSearchProviders,
    activeWebSearchProviderId,
    mcpServers: patch.mcpServers ? mergeRedactedMcpServers(patch.mcpServers, config.mcpServers) : config.mcpServers,
    workspacePolicies: patch.workspacePolicies ?? config.workspacePolicies,
    workspacePolicyProfiles: patch.workspacePolicyProfiles ?? config.workspacePolicyProfiles
  };
}

function toPublicProvider(provider: LlmProviderProfile): PublicLlmProviderProfile {
  const { apiKey, ...publicProvider } = provider;
  return {
    ...publicProvider,
    apiKeyPresent: Boolean(apiKey)
  };
}

function toPublicWebSearchProvider(provider: WebSearchProviderProfile): PublicWebSearchProviderProfile {
  const { apiKey, ...publicProvider } = provider;
  return {
    ...publicProvider,
    apiKeyPresent: Boolean(apiKey)
  };
}

function toPublicBrowserTaskModel(profile: BrowserTaskModelConfigProfile): PublicBrowserTaskModelProfile {
  const { apiKey, fallbackModels, ...publicProfile } = profile;
  return {
    ...publicProfile,
    apiKeyPresent: Boolean(apiKey),
    fallbackModels: fallbackModels?.map((fallback) => toPublicBrowserTaskModel(fallback))
  };
}

function toPublicBrowserVisualGrounding(profile: BrowserVisualGroundingConfigProfile): PublicBrowserVisualGroundingProfile {
  const { apiKey, ...publicProfile } = profile;
  return {
    ...publicProfile,
    apiKeyPresent: Boolean(apiKey)
  };
}

function mergeBrowserFallbackModels(
  saved: BrowserTaskModelConfigProfile["fallbackModels"],
  patch: Array<{ providerId?: string; model?: string }>
): BrowserTaskModelConfigProfile["fallbackModels"] {
  const merged = patch
    .slice(0, 5)
    .map((candidate) => ({
      providerId: candidate.providerId?.trim() || undefined,
      model: candidate.model?.trim() || undefined
    }))
    .filter((candidate) => candidate.providerId || candidate.model)
    .map((candidate) => {
      const matchingSaved = saved?.find((item) => item.providerId === candidate.providerId && item.model === candidate.model);
      return {
        ...matchingSaved,
        ...candidate
      };
    });
  return merged.length > 0 ? merged : undefined;
}

export function sanitizeSettingsInt(value: number | undefined, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

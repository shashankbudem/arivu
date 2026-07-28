import { PROVIDER_PRESETS } from "../models/providerCatalog";
import { WEB_SEARCH_PROVIDER_PRESETS } from "../../../../../src/tools/webSearchProvider";

export type ProviderFormState = LlmProviderPatch & {
  apiKeyPresent?: boolean;
};

export type WebSearchProviderFormState = WebSearchProviderPatch & {
  apiKeyPresent?: boolean;
};

export function providerFormsFromConfig(config: DesktopState["config"]): ProviderFormState[] {
  if (config.providers.length > 0) {
    return config.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      toolCalling: provider.toolCalling ?? "auto",
      imageInput: provider.imageInput ?? "auto",
      contextWindowTokens: provider.contextWindowTokens,
      apiKey: "",
      apiKeyPresent: provider.apiKeyPresent
    }));
  }

  const preset = PROVIDER_PRESETS.find((provider) => provider.baseUrl === config.baseUrl);
  return [
    {
      id: preset?.id ?? "current",
      name: preset?.name ?? "Current provider",
      baseUrl: config.baseUrl,
      model: config.model,
      toolCalling: config.toolCalling,
      imageInput: config.imageInput,
      apiKey: "",
      apiKeyPresent: config.apiKeyPresent
    }
  ];
}

export function webSearchProviderFormsFromConfig(config: DesktopState["config"]): WebSearchProviderFormState[] {
  if (config.webSearchProviders?.length) {
    return config.webSearchProviders.map((provider) => ({
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      apiKey: "",
      apiKeyPresent: provider.apiKeyPresent
    }));
  }

  return [
    {
      id: "bing",
      ...WEB_SEARCH_PROVIDER_PRESETS.bing,
      apiKey: "",
      apiKeyPresent: false
    }
  ];
}

export function uniqueProviderId(baseId: string, providers: ProviderFormState[]) {
  const normalizedBase =
    baseId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "provider";
  const used = new Set(providers.map((provider) => provider.id));
  if (!used.has(normalizedBase)) {
    return normalizedBase;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${normalizedBase}-${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

export function uniqueProviderName(baseName: string, providers: ProviderFormState[]) {
  const normalizedNames = new Set(providers.map((provider) => provider.name.trim().toLowerCase()).filter(Boolean));
  if (!normalizedNames.has(baseName.toLowerCase())) {
    return baseName;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!normalizedNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

export function uniqueWebSearchProviderId(baseId: string, providers: WebSearchProviderFormState[]) {
  const used = new Set(providers.map((provider) => provider.id));
  if (!used.has(baseId)) {
    return baseId;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${baseId}-${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

export function uniqueWebSearchProviderName(baseName: string, providers: WebSearchProviderFormState[], excludedProviderId?: string) {
  const normalizedNames = new Set(
    providers
      .filter((provider) => provider.id !== excludedProviderId)
      .map((provider) => provider.name.trim().toLowerCase())
      .filter(Boolean)
  );
  if (!normalizedNames.has(baseName.toLowerCase())) {
    return baseName;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!normalizedNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

export function generatedWebSearchProviderName(name: string, presetName: string) {
  const trimmed = name.trim();
  return trimmed === presetName || (trimmed.startsWith(`${presetName} `) && /^\d+$/.test(trimmed.slice(presetName.length + 1)));
}

export function validateProviderForms(
  providers: ProviderFormState[],
  activeProviderId: string
): { providers: LlmProviderPatch[]; activeProviderId: string; activeProvider: LlmProviderPatch } {
  const nextProviders: LlmProviderPatch[] = [];
  const names = new Set<string>();

  for (const provider of providers) {
    const baseUrl = provider.baseUrl.trim();
    if (!baseUrl) {
      continue;
    }

    const name = provider.name.trim();
    const model = provider.model.trim();
    if (!name) {
      throw new Error("Enter a name for each provider with a URL.");
    }
    if (!model) {
      throw new Error(`Enter a model ID for ${name}, or use the model picker.`);
    }

    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) {
      throw new Error(`Provider name "${name}" is already in use. Provider names must be unique.`);
    }
    names.add(normalizedName);

    nextProviders.push({
      id: provider.id,
      name,
      baseUrl: normalizeProviderUrl(baseUrl, name),
      model,
      toolCalling: provider.toolCalling ?? "auto",
      imageInput: provider.imageInput ?? "auto",
      ...(provider.contextWindowTokens && provider.contextWindowTokens > 0 ? { contextWindowTokens: provider.contextWindowTokens } : {}),
      ...(provider.apiKey?.trim() ? { apiKey: provider.apiKey.trim() } : {})
    });
  }

  if (nextProviders.length === 0) {
    throw new Error("Keep at least one provider with a URL and model ID.");
  }

  const activeProvider = nextProviders.find((provider) => provider.id === activeProviderId) ?? nextProviders[0];
  return {
    providers: nextProviders,
    activeProviderId: activeProvider.id,
    activeProvider
  };
}

export function validateWebSearchProviderForms(
  providers: WebSearchProviderFormState[],
  activeProviderId: string
): {
  providers: WebSearchProviderPatch[];
  activeProviderId: string;
  activeProvider: WebSearchProviderPatch;
} {
  const nextProviders: WebSearchProviderPatch[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();

  for (const provider of providers) {
    const id = provider.id.trim();
    const name = provider.name.trim();
    const baseUrl = provider.baseUrl.trim();
    if (!id || !name || !baseUrl) {
      throw new Error("Each search provider needs a name and search endpoint.");
    }
    if (ids.has(id)) {
      throw new Error(`Search provider ID "${id}" is already in use.`);
    }
    ids.add(id);
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) {
      throw new Error(`Search provider name "${name}" is already in use.`);
    }
    names.add(normalizedName);

    const apiKey = provider.apiKey?.trim();
    nextProviders.push({
      id,
      name,
      kind: provider.kind,
      baseUrl: normalizeProviderUrl(baseUrl, name),
      ...(apiKey ? { apiKey } : {})
    });
  }

  if (nextProviders.length === 0) {
    throw new Error("Keep at least one web search provider.");
  }
  const activeProvider = nextProviders.find((provider) => provider.id === activeProviderId) ?? nextProviders[0]!;
  return {
    providers: nextProviders,
    activeProviderId: activeProvider.id,
    activeProvider
  };
}

function normalizeProviderUrl(baseUrl: string, providerName: string) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported provider URL protocol.");
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${providerName} needs a valid http(s) base URL.`);
  }
}

export function parseOptionalInt(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseBoundedSettingsInt(value: string, min: number, max: number): number | undefined {
  const trimmed = value.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

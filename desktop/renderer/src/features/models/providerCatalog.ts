export const AUTO_MODEL_VALUE = "auto";

export const PROVIDER_PRESETS: LlmProviderPatch[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1",
    toolCalling: "auto",
    imageInput: "auto"
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "moonshotai/kimi-k2.6",
    toolCalling: "auto",
    imageInput: "auto"
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1",
    toolCalling: "auto",
    imageInput: "auto"
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    toolCalling: "auto",
    imageInput: "auto"
  },
  {
    id: "local",
    name: "Local / Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.1",
    toolCalling: "auto",
    imageInput: "auto"
  }
];

export function activeProviderName(config: DesktopState["config"]) {
  const activeProvider = config.providers.find((provider) => provider.id === config.activeProviderId);
  if (activeProvider) {
    return activeProvider.name;
  }
  return PROVIDER_PRESETS.find((provider) => provider.baseUrl === config.baseUrl)?.name ?? "OpenAI-compatible";
}

export function isAutoModelId(model: string | undefined) {
  return model?.trim().toLowerCase() === AUTO_MODEL_VALUE;
}

export function modelDisplayName(model: string | undefined) {
  return isAutoModelId(model) ? "Auto" : model || "default model";
}

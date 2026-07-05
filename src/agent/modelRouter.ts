import type { AppConfig, ProviderImageInputMode, ProviderToolCallingMode } from "../config.js";
import { chatContentToText, type ChatContent } from "./content.js";
import type { AgentSession } from "./types.js";

export const AUTO_MODEL_ID = "auto";

export type AutoModelTask = "vision" | "fast" | "coding" | "reasoning" | "background" | "general";

export type ModelProviderCandidate = {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  toolCalling?: ProviderToolCallingMode;
  imageInput?: ProviderImageInputMode;
  active: boolean;
  models?: string[];
};

export type ModelSelection = {
  mode: "manual" | "auto";
  model: string;
  baseUrl: string;
  apiKey?: string;
  toolCalling?: ProviderToolCallingMode;
  imageInput?: ProviderImageInputMode;
  providerId?: string;
  providerName: string;
  task: AutoModelTask;
  reason: string;
};

type ProviderProfile = {
  id: string;
  matches: (provider: ModelProviderCandidate) => boolean;
  models: Record<AutoModelTask, string[]>;
};

const AUTO_REASON: Record<AutoModelTask, string> = {
  vision: "image input needs a vision-capable model",
  fast: "short/simple request is better served by a low-latency model",
  coding: "coding or repo work benefits from a code-oriented model",
  reasoning: "complex request benefits from a stronger reasoning model",
  background: "explicit long-running/deep-work wording allows a heavier model",
  general: "general conversation uses the balanced default route"
};

const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    id: "nvidia",
    matches: (provider) => provider.baseUrl.toLowerCase().includes("integrate.api.nvidia.com"),
    models: {
      vision: ["meta/llama-3.2-90b-vision-instruct", "meta/llama-3.2-11b-vision-instruct", "nvidia/nemotron-nano-12b-v2-vl"],
      fast: ["deepseek-ai/deepseek-v4-flash", "microsoft/phi-4-mini-instruct", "nvidia/llama-3.1-nemotron-nano-8b-v1"],
      coding: ["moonshotai/kimi-k2.6", "qwen/qwen3-next-80b-a3b-instruct", "mistralai/codestral-22b-instruct-v0.1", "z-ai/glm-5.1"],
      reasoning: ["z-ai/glm-5.1", "nvidia/llama-3.3-nemotron-super-49b-v1.5", "qwen/qwen3.5-122b-a10b"],
      background: ["nvidia/llama-3.1-nemotron-ultra-253b-v1", "nvidia/nemotron-3-ultra-550b-a55b", "deepseek-ai/deepseek-v4-pro"],
      general: ["z-ai/glm-5.1", "moonshotai/kimi-k2.6", "qwen/qwen3-next-80b-a3b-instruct"]
    }
  },
  {
    id: "openai",
    matches: (provider) => provider.baseUrl.toLowerCase().includes("api.openai.com"),
    models: {
      vision: ["gpt-4.1", "gpt-4.1-mini"],
      fast: ["gpt-4.1-mini", "gpt-4.1-nano"],
      coding: ["gpt-4.1", "gpt-4.1-mini"],
      reasoning: ["gpt-4.1"],
      background: ["gpt-4.1"],
      general: ["gpt-4.1", "gpt-4.1-mini"]
    }
  },
  {
    id: "groq",
    matches: (provider) => provider.baseUrl.toLowerCase().includes("groq.com"),
    models: {
      vision: [],
      fast: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"],
      coding: ["llama-3.3-70b-versatile"],
      reasoning: ["llama-3.3-70b-versatile"],
      background: ["llama-3.3-70b-versatile"],
      general: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]
    }
  }
];

const CODING_RE = /\b(code|coding|repo|repository|file|files|function|class|component|typescript|javascript|react|node|electron|python|api|bug|fix|implement|build|test|failing|error|stack trace|diff|patch|refactor|debug|compile|typecheck|lint)\b/i;
const REASONING_RE = /\b(deep|careful|carefully|reason|reasoning|analy[sz]e|architecture|design|plan|strategy|trade[- ]?off|root cause|security|review|complex|think through)\b/i;
const BACKGROUND_RE = /\b(take your time|background|exhaustive|maximum|best possible|slow is ok|slow is fine|thorough|large model|heaviest|ultra)\b/i;
const FAST_RE = /\b(quick|short|brief|simple|summari[sz]e|rewrite|grammar|translate|one[- ]?liner|tl;dr)\b/i;
const CURRENT_RE = /\b(latest|today|current|now|recent|news|price|weather|score|schedule)\b/i;

export function isAutoModel(model: string | undefined): boolean {
  return model?.trim().toLowerCase() === AUTO_MODEL_ID;
}

export function providerCandidatesFromConfig(config: AppConfig): ModelProviderCandidate[] {
  if (config.providers.length === 0) {
    return [
      {
        id: config.activeProviderId,
        name: "OpenAI-compatible",
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey,
        toolCalling: config.toolCalling,
        imageInput: config.imageInput,
        active: true
      }
    ];
  }

  return config.providers.map((provider) => {
    const active = provider.id === config.activeProviderId || (!config.activeProviderId && provider.baseUrl === config.baseUrl);
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: provider.apiKey || (active ? config.apiKey : undefined),
      toolCalling: provider.toolCalling,
      imageInput: provider.imageInput,
      active
    };
  });
}

export function resolveModelForPrompt(
  config: AppConfig,
  prompt: ChatContent,
  options: {
    session?: AgentSession;
    providers?: ModelProviderCandidate[];
  } = {}
): ModelSelection {
  const providers = options.providers?.length ? options.providers : providerCandidatesFromConfig(config);
  if (!isAutoModel(config.model)) {
    const active = activeProvider(providers);
    return {
      mode: "manual",
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      toolCalling: active?.toolCalling ?? config.toolCalling,
      imageInput: active?.imageInput ?? config.imageInput,
      providerId: active?.id,
      providerName: active?.name ?? "OpenAI-compatible",
      task: "general",
      reason: "manual model selected"
    };
  }

  const task = classifyPromptForModel(prompt, options.session);
  const provider = chooseProviderForTask(providers, task);
  const model = chooseModelForProvider(provider, task);
  if (!model) {
    throw new Error(`Auto model selection could not find a concrete model for ${provider.name}. Select a model manually for this provider.`);
  }

  return {
    mode: "auto",
    model,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    toolCalling: provider.toolCalling,
    imageInput: provider.imageInput,
    providerId: provider.id,
    providerName: provider.name,
    task,
    reason: AUTO_REASON[task]
  };
}

export function classifyPromptForModel(prompt: ChatContent, session?: AgentSession): AutoModelTask {
  const text = chatContentToText(prompt).trim();
  const lower = text.toLowerCase();
  if (chatContentHasImage(prompt)) {
    return "vision";
  }
  if (BACKGROUND_RE.test(lower)) {
    return "background";
  }
  if (REASONING_RE.test(lower)) {
    return "reasoning";
  }
  if (CODING_RE.test(lower) || (session?.projectRoot && /\b(add|change|fix|implement|update|create|remove|run|test)\b/i.test(lower))) {
    return "coding";
  }
  if (FAST_RE.test(lower) || CURRENT_RE.test(lower) || text.length <= 180) {
    return "fast";
  }
  return "general";
}

function chooseProviderForTask(providers: ModelProviderCandidate[], task: AutoModelTask): ModelProviderCandidate {
  const scored = providers.map((provider, index) => ({
    provider,
    index,
    score: providerScore(provider, task)
  }));
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return scored[0]?.provider ?? providers[0];
}

function providerScore(provider: ModelProviderCandidate, task: AutoModelTask): number {
  let score = provider.active ? 8 : 0;
  const profile = profileForProvider(provider);
  if (profile) {
    score += 10;
    if (profile.models[task].length > 0) {
      score += 8;
    }
  }
  if (provider.models?.some((model) => modelSupportsTask(model, task))) {
    score += 8;
  }
  if (provider.apiKey) {
    score += 2;
  }
  if (task === "vision") {
    if (provider.imageInput === "disabled") {
      score -= 80;
    } else if (provider.imageInput === "enabled") {
      score += 12;
    }
  }
  if (!isAutoModel(provider.model)) {
    score += 1;
  }
  if (task === "vision" && !profile?.models.vision.length && !modelLooksVisionCapable(provider.model)) {
    score -= 30;
  }
  return score;
}

function chooseModelForProvider(provider: ModelProviderCandidate, task: AutoModelTask): string | undefined {
  const profile = profileForProvider(provider);
  const preferred = [
    ...(profile?.models[task] ?? []),
    ...(task === "general" ? [] : profile?.models.general ?? []),
    ...(!isAutoModel(provider.model) ? [provider.model] : [])
  ];
  const uniquePreferred = Array.from(new Set(preferred.filter(Boolean)));
  if (!provider.models || provider.models.length === 0) {
    return uniquePreferred[0];
  }

  const available = new Set(provider.models);
  const recommended = uniquePreferred.find((model) => available.has(model));
  if (recommended) {
    return recommended;
  }

  if (task === "vision") {
    return provider.models.find(modelLooksVisionCapable) ?? (!isAutoModel(provider.model) ? provider.model : undefined);
  }
  if (task === "coding") {
    return provider.models.find(modelLooksCodeCapable) ?? (!isAutoModel(provider.model) ? provider.model : undefined);
  }
  if (task === "fast") {
    return provider.models.find(modelLooksFast) ?? (!isAutoModel(provider.model) ? provider.model : provider.models[0]);
  }
  if (task === "background") {
    return provider.models.find(modelLooksLarge) ?? provider.models.find(modelLooksReasoningCapable) ?? (!isAutoModel(provider.model) ? provider.model : provider.models[0]);
  }
  if (task === "reasoning") {
    return provider.models.find(modelLooksReasoningCapable) ?? (!isAutoModel(provider.model) ? provider.model : provider.models[0]);
  }
  return !isAutoModel(provider.model) ? provider.model : provider.models[0];
}

function activeProvider(providers: ModelProviderCandidate[]): ModelProviderCandidate | undefined {
  return providers.find((provider) => provider.active) ?? providers[0];
}

function profileForProvider(provider: ModelProviderCandidate): ProviderProfile | undefined {
  return PROVIDER_PROFILES.find((profile) => profile.matches(provider));
}

function chatContentHasImage(content: ChatContent): boolean {
  return Array.isArray(content) && content.some((part) => part.type === "image_url");
}

function modelLooksVisionCapable(model: string): boolean {
  return /\b(vision|vl|vlm|omni|llava|pixtral|qwen[-\w.]*vl|mllama)\b/i.test(model);
}

function modelLooksCodeCapable(model: string): boolean {
  return /\b(code|coder|codestral|starcoder|qwen|kimi|deepseek|glm|granite)\b/i.test(model);
}

function modelLooksFast(model: string): boolean {
  return /\b(fast|flash|mini|nano|small|lite|instant|8b|7b|3b)\b/i.test(model);
}

function modelLooksLarge(model: string): boolean {
  return /\b(large|ultra|pro|405b|550b|671b|675b|253b|120b)\b/i.test(model);
}

function modelLooksReasoningCapable(model: string): boolean {
  return /\b(reason|r1|nemotron|qwen|deepseek|glm|kimi|70b|72b|80b|120b|253b|405b|550b)\b/i.test(model);
}

function modelSupportsTask(model: string, task: AutoModelTask): boolean {
  if (task === "vision") {
    return modelLooksVisionCapable(model);
  }
  if (task === "coding") {
    return modelLooksCodeCapable(model);
  }
  if (task === "fast") {
    return modelLooksFast(model);
  }
  if (task === "background") {
    return modelLooksLarge(model);
  }
  if (task === "reasoning") {
    return modelLooksReasoningCapable(model);
  }
  return true;
}

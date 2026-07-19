import { normalizeCapabilityBaseUrl, type AppConfig } from "../config.js";
import type { ModelCatalog } from "./modelCatalogSchema.js";

// Provider model cards publish the native input context for these versioned models. The hosted
// endpoint can expose a smaller effective window, so catalog observations always cap this value.
// NVIDIA references: https://docs.api.nvidia.com/nim/reference/llm-apis
const PUBLISHED_CONTEXT_WINDOWS = new Map<string, number>([
  ["deepseek-ai/deepseek-v4-flash", 1_000_000],
  ["deepseek-ai/deepseek-v4-pro", 1_000_000],
  ["minimaxai/minimax-m2.7", 204_800],
  ["minimaxai/minimax-m2.7-highspeed", 204_800],
  ["nvidia/nemotron-3-nano-30b-a3b", 1_000_000],
  ["nvidia/nvidia-nemotron-3-nano-30b-a3b-bf16", 1_000_000],
  ["nvidia/nvidia-nemotron-3-nano-30b-a3b-fp8", 1_000_000],
  ["nvidia/nvidia-nemotron-3-nano-30b-a3b-nvfp4", 1_000_000],
  ["nvidia/nemotron-3-ultra-550b-a55b", 1_000_000],
  ["z-ai/glm-5.2", 1_000_000]
]);

/**
 * Resolves the context window for a specific (model, endpoint) pair.
 *
 * This is the seam that makes the budget per-MODEL. Config's `contextWindowTokens` is per-PROVIDER,
 * so before this existed a provider-wide value was applied to every model on that endpoint — a
 * 128k setting silently claimed a 128k window for a 4,096-token model.
 *
 * Resolution: published metadata is a fallback, while any provider-reported limit from the active
 * endpoint caps it. A hosted deployment can enforce less context than its model card advertises.
 * The hand-entered config value also acts only as a CAP. `min()` is deliberate — a user's number
 * can lower the budget (a cost/latency guardrail) but must never raise it above what the endpoint
 * physically accepts.
 *
 * Returns undefined when nothing is known, which callers pass to the agent as "no window" — that
 * degrades to the existing conservative 48k default rather than guessing.
 */
export function resolveContextWindowTokens(
  config: AppConfig,
  selection: { model: string; baseUrl: string },
  catalog: ModelCatalog
): number | undefined {
  const publishedTokens = nativeContextWindowTokens(selection.model);
  const catalogEntry = catalogContextEntry(catalog, selection);
  const catalogTokens = catalogEntry?.context?.tokens;
  const modelTokens = Math.min(publishedTokens ?? Number.POSITIVE_INFINITY, catalogTokens ?? Number.POSITIVE_INFINITY);
  const configTokens = providerContextTokens(config, selection.baseUrl) ?? config.contextWindowTokens;
  const effective = Math.min(modelTokens ?? Number.POSITIVE_INFINITY, configTokens ?? Number.POSITIVE_INFINITY);
  return Number.isFinite(effective) ? effective : undefined;
}

export function catalogContextTokens(catalog: ModelCatalog, selection: { model: string; baseUrl: string }): number | undefined {
  return catalogContextEntry(catalog, selection)?.context?.tokens;
}

export function nativeContextWindowTokens(model: string): number | undefined {
  return PUBLISHED_CONTEXT_WINDOWS.get(model.trim().toLowerCase());
}

function catalogContextEntry(catalog: ModelCatalog, selection: { model: string; baseUrl: string }) {
  const provider = catalog.providers[normalizeCapabilityBaseUrl(selection.baseUrl)];
  const entry = provider?.models[selection.model];
  // A tombstoned model keeps its measured window: the number is still correct if it comes back, and
  // the user may still have it pinned to a session.
  return entry;
}

function providerContextTokens(config: AppConfig, baseUrl: string): number | undefined {
  const key = normalizeCapabilityBaseUrl(baseUrl);
  const provider = config.providers.find((candidate) => normalizeCapabilityBaseUrl(candidate.baseUrl) === key);
  return provider?.contextWindowTokens;
}

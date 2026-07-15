import { normalizeCapabilityBaseUrl, type AppConfig } from "../config.js";
import type { ModelCatalog } from "./modelCatalogSchema.js";

/**
 * Resolves the context window for a specific (model, endpoint) pair.
 *
 * This is the seam that makes the budget per-MODEL. Config's `contextWindowTokens` is per-PROVIDER,
 * so before this existed a provider-wide value was applied to every model on that endpoint — a
 * 128k setting silently claimed a 128k window for a 4,096-token model.
 *
 * Resolution: the catalog is the measured truth; the hand-entered config value acts only as a CAP.
 * `min()` is deliberate — a user's number can lower the budget (a cost/latency guardrail) but must
 * never raise it above what the endpoint physically accepts.
 *
 * Returns undefined when nothing is known, which callers pass to the agent as "no window" — that
 * degrades to the existing conservative 48k default rather than guessing.
 */
export function resolveContextWindowTokens(
  config: AppConfig,
  selection: { model: string; baseUrl: string },
  catalog: ModelCatalog
): number | undefined {
  const catalogTokens = catalogContextTokens(catalog, selection);
  const configTokens = providerContextTokens(config, selection.baseUrl) ?? config.contextWindowTokens;
  const effective = Math.min(catalogTokens ?? Number.POSITIVE_INFINITY, configTokens ?? Number.POSITIVE_INFINITY);
  return Number.isFinite(effective) ? effective : undefined;
}

export function catalogContextTokens(catalog: ModelCatalog, selection: { model: string; baseUrl: string }): number | undefined {
  const provider = catalog.providers[normalizeCapabilityBaseUrl(selection.baseUrl)];
  const entry = provider?.models[selection.model];
  // A tombstoned model keeps its measured window: the number is still correct if it comes back, and
  // the user may still have it pinned to a session.
  return entry?.context?.tokens;
}

function providerContextTokens(config: AppConfig, baseUrl: string): number | undefined {
  const key = normalizeCapabilityBaseUrl(baseUrl);
  const provider = config.providers.find((candidate) => normalizeCapabilityBaseUrl(candidate.baseUrl) === key);
  return provider?.contextWindowTokens;
}

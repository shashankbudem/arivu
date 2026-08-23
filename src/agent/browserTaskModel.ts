import type { AppConfig } from "../config.js";
import { resolveContextWindowTokens } from "../models/contextResolver.js";
import type { ModelCatalog } from "../models/modelCatalogSchema.js";
import type { BrowserTaskModelConfig, BrowserVisualGroundingConfig } from "../tools/browserControl.js";
import { providerCandidatesFromConfig, type ModelSelection } from "./modelRouter.js";

type BrowserTaskModelOverride = NonNullable<AppConfig["browserTaskModel"]>;
type BrowserTaskModelCandidateOverride = Omit<BrowserTaskModelOverride, "fallbackModels">;

/**
 * Resolves the model/provider `browser_task` should use. With no `browserTaskModel`
 * config, it falls back to whatever model the main agent run already resolved for this
 * turn (respecting `auto` model selection). An explicit `providerId` pulls that saved
 * provider's fields; explicit `baseUrl`/`model`/`apiKey` fields override on top of either.
 *
 * `fallbackModels` (if configured) resolve the same way, but default their unset provider,
 * credentials, and loop settings to the *primary's already-resolved* fields rather than the
 * chat model's — a fallback naming only a different `model` id lands on the same endpoint
 * with the same max-steps and action-loop delay, which is the common case.
 */
export function resolveBrowserTaskModel(config: AppConfig, fallback: ModelSelection): BrowserTaskModelConfig {
  const override = config.browserTaskModel;
  const primary = resolveBrowserTaskModelCandidate(config, override, fallback);
  const fallbackOverrides = override?.fallbackModels;
  const resolved: BrowserTaskModelConfig = fallbackOverrides?.length
    ? {
        ...primary,
        fallbacks: fallbackOverrides.map((fallbackOverride) => resolveBrowserTaskModelCandidate(config, fallbackOverride, primary))
      }
    : primary;
  const visualGrounding = resolveBrowserVisualGroundingModel(config);
  return visualGrounding ? { ...resolved, visualGrounding } : resolved;
}

/**
 * Resolve the optional coordinate-only GUI grounding model independently from both chat and
 * browser-task reasoning. The settings profile may point at any saved OpenAI-compatible
 * provider (for example a local vLLM server hosting nvidia/LocateAnything-3B).
 */
export function resolveBrowserVisualGroundingModel(config: AppConfig): BrowserVisualGroundingConfig | undefined {
  const override = config.browserVisualGrounding;
  if (!override) {
    return undefined;
  }
  const provider = override.providerId
    ? providerCandidatesFromConfig(config).find((candidate) => candidate.id === override.providerId)
    : undefined;
  if (override.providerId && !provider) {
    throw new Error(
      `browserVisualGrounding references unknown provider "${override.providerId}". Choose a configured provider or disable visual grounding.`
    );
  }
  const baseUrl = override.baseUrl ?? provider?.baseUrl;
  if (!baseUrl) {
    throw new Error("browserVisualGrounding needs a providerId or baseUrl.");
  }
  return {
    baseUrl,
    model: override.model,
    apiKey: override.apiKey ?? provider?.apiKey,
    providerId: provider?.id ?? override.providerId,
    providerName: provider?.name,
    timeoutMs: override.timeoutMs
  };
}

function resolveBrowserTaskModelCandidate(
  config: AppConfig,
  override: BrowserTaskModelCandidateOverride | undefined,
  base: ModelSelection | BrowserTaskModelConfig
): BrowserTaskModelConfig {
  if (!override) {
    return {
      baseUrl: base.baseUrl,
      model: base.model,
      apiKey: base.apiKey,
      providerId: base.providerId,
      providerName: base.providerName
    };
  }

  const provider = override.providerId
    ? providerCandidatesFromConfig(config).find((candidate) => candidate.id === override.providerId)
    : undefined;
  if (override.providerId && !provider) {
    throw new Error(
      `browser_task references unknown provider "${override.providerId}". Choose a configured provider or remove providerId.`
    );
  }
  const resolvedBase = provider ?? base;
  const baseBrowserConfig = base as Partial<BrowserTaskModelConfig>;

  return {
    baseUrl: override.baseUrl ?? resolvedBase.baseUrl,
    model: override.model ?? resolvedBase.model,
    apiKey: override.apiKey ?? resolvedBase.apiKey,
    providerId: provider?.id ?? base.providerId,
    providerName: provider?.name ?? base.providerName,
    maxSteps: override.maxSteps ?? baseBrowserConfig.maxSteps,
    stepDelayMs: override.stepDelayMs ?? baseBrowserConfig.stepDelayMs
  };
}

/** Resolve browser-task context independently from the chat model selected for the same run. */
export function resolveBrowserTaskContextWindowTokens(
  config: AppConfig,
  chatSelection: Pick<ModelSelection, "model" | "baseUrl">,
  browserModel: Pick<BrowserTaskModelConfig, "model" | "baseUrl">,
  catalog: ModelCatalog
): number | undefined {
  const browserUsesChatModel = browserModel.model === chatSelection.model && browserModel.baseUrl === chatSelection.baseUrl;
  return resolveContextWindowTokens(
    // effectiveConfig stores the already-resolved CHAT-model window at the root. It is not a
    // provider-wide user cap and must not constrain a different browser model on the same
    // endpoint. Saved provider-specific caps remain available through config.providers.
    browserUsesChatModel ? config : { ...config, contextWindowTokens: undefined },
    browserModel,
    catalog
  );
}

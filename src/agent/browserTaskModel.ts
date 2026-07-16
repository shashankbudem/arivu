import type { AppConfig } from "../config.js";
import { resolveContextWindowTokens } from "../models/contextResolver.js";
import type { ModelCatalog } from "../models/modelCatalogSchema.js";
import type { BrowserTaskModelConfig } from "../tools/browserControl.js";
import { providerCandidatesFromConfig, type ModelSelection } from "./modelRouter.js";

/**
 * Resolves the model/provider `browser_task` should use. With no `browserTaskModel`
 * config, it falls back to whatever model the main agent run already resolved for this
 * turn (respecting `auto` model selection). An explicit `providerId` pulls that saved
 * provider's fields; explicit `baseUrl`/`model`/`apiKey` fields override on top of either.
 */
export function resolveBrowserTaskModel(config: AppConfig, fallback: ModelSelection): BrowserTaskModelConfig {
  const override = config.browserTaskModel;
  if (!override) {
    return {
      baseUrl: fallback.baseUrl,
      model: fallback.model,
      apiKey: fallback.apiKey,
      providerId: fallback.providerId,
      providerName: fallback.providerName
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
  const base = provider ?? fallback;

  return {
    baseUrl: override.baseUrl ?? base.baseUrl,
    model: override.model ?? base.model,
    apiKey: override.apiKey ?? base.apiKey,
    providerId: provider?.id ?? fallback.providerId,
    providerName: provider?.name ?? fallback.providerName,
    maxSteps: override.maxSteps,
    stepDelayMs: override.stepDelayMs
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

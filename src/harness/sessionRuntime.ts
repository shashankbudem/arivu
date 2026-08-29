import type { AppConfig } from "../config.js";
import { isAutoModel, type ModelSelection } from "../agent/modelRouter.js";
import type { AgentSession } from "../agent/types.js";

/**
 * Frontend-neutral pieces of session setup. Desktop and the native TUI deliberately
 * render them differently, but a prompt must resolve and persist its model selection
 * identically before either frontend creates an Agent.
 */
export function applyModelSelectionToSession(session: AgentSession, selection: ModelSelection): AgentSession {
  return {
    ...session,
    model: selection.mode === "auto" ? "auto" : selection.model,
    baseUrl: selection.baseUrl,
    modelMode: selection.mode,
    selectedModel: selection.mode === "auto" ? selection.model : undefined,
    selectedProviderId: selection.providerId,
    selectedProviderName: selection.providerName,
    modelSelectionReason: selection.mode === "auto" ? selection.reason : undefined
  };
}

export function configForModelSelection(config: AppConfig, selection: ModelSelection): AppConfig {
  return {
    ...config,
    model: selection.model,
    baseUrl: selection.baseUrl,
    toolCalling: selection.toolCalling ?? config.toolCalling,
    imageInput: selection.imageInput ?? config.imageInput,
    apiKey: selection.apiKey ?? (selection.baseUrl === config.baseUrl ? config.apiKey : undefined)
  };
}

export function updateSessionRuntimeFromConfig(session: AgentSession, config: Partial<AppConfig>): AgentSession {
  const model = config.model ?? session.model;
  const auto = isAutoModel(model);
  return {
    ...session,
    model,
    baseUrl: config.baseUrl ?? session.baseUrl,
    trustMode: config.trustMode ?? session.trustMode,
    modelMode: auto ? "auto" : "manual",
    selectedModel: undefined,
    selectedProviderId: undefined,
    selectedProviderName: undefined,
    modelSelectionReason: undefined,
    updatedAt: new Date().toISOString()
  };
}

import { describe, expect, it } from "vitest";
import { resolveBrowserTaskModel } from "../src/agent/browserTaskModel.js";
import type { AppConfig } from "../src/config.js";
import type { ModelSelection } from "../src/agent/modelRouter.js";

const FALLBACK: ModelSelection = {
  mode: "manual",
  model: "chat-model",
  baseUrl: "https://chat.example/v1",
  apiKey: "chat-key",
  toolCalling: "auto",
  imageInput: "auto",
  providerId: "chat-provider",
  providerName: "Chat provider",
  task: "general"
} as ModelSelection;

function configWith(overrides: Partial<AppConfig>): AppConfig {
  return {
    baseUrl: "https://chat.example/v1",
    model: "chat-model",
    apiKey: "chat-key",
    toolCalling: "auto",
    imageInput: "auto",
    providers: [
      {
        id: "chat-provider",
        name: "Chat provider",
        baseUrl: "https://chat.example/v1",
        model: "chat-model",
        toolCalling: "auto",
        imageInput: "auto"
      },
      {
        id: "browser-provider",
        name: "Browser provider",
        baseUrl: "https://browser.example/v1",
        model: "browser-model",
        apiKey: "browser-key",
        toolCalling: "auto",
        imageInput: "auto"
      }
    ],
    activeProviderId: "chat-provider",
    trustMode: "ask",
    mcpServers: {},
    workspacePolicies: {},
    workspacePolicyProfiles: {},
    ...overrides
  } as AppConfig;
}

describe("resolveBrowserTaskModel", () => {
  it("follows the chat model when no override is configured", () => {
    const resolved = resolveBrowserTaskModel(configWith({}), FALLBACK);
    expect(resolved).toEqual({ baseUrl: "https://chat.example/v1", model: "chat-model", apiKey: "chat-key" });
  });

  it("uses the saved provider referenced by providerId", () => {
    const resolved = resolveBrowserTaskModel(configWith({ browserTaskModel: { providerId: "browser-provider" } }), FALLBACK);
    expect(resolved).toEqual({ baseUrl: "https://browser.example/v1", model: "browser-model", apiKey: "browser-key" });
  });

  it("applies an explicit model override on top of the selected provider", () => {
    const resolved = resolveBrowserTaskModel(
      configWith({ browserTaskModel: { providerId: "browser-provider", model: "special-model" } }),
      FALLBACK
    );
    expect(resolved).toEqual({ baseUrl: "https://browser.example/v1", model: "special-model", apiKey: "browser-key" });
  });

  it("applies a bare model override on top of the chat model", () => {
    const resolved = resolveBrowserTaskModel(configWith({ browserTaskModel: { model: "special-model" } }), FALLBACK);
    expect(resolved).toEqual({ baseUrl: "https://chat.example/v1", model: "special-model", apiKey: "chat-key" });
  });

  it("preserves browser-agent loop and rate-limit overrides", () => {
    const resolved = resolveBrowserTaskModel(
      configWith({ browserTaskModel: { providerId: "browser-provider", maxSteps: 80, stepDelayMs: 12_000 } }),
      FALLBACK
    );
    expect(resolved).toMatchObject({ maxSteps: 80, stepDelayMs: 12_000 });
  });

  it("falls back to the chat model when the referenced provider no longer exists", () => {
    const resolved = resolveBrowserTaskModel(configWith({ browserTaskModel: { providerId: "deleted-provider" } }), FALLBACK);
    expect(resolved).toEqual({ baseUrl: "https://chat.example/v1", model: "chat-model", apiKey: "chat-key" });
  });
});

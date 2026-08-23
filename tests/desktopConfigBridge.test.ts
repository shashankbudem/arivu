import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { toPublicConfig } from "../desktop/main/configBridge.js";

describe("desktop config bridge", () => {
  it("reports configured secrets without exposing their values to the renderer", () => {
    const config: AppConfig = {
      apiKey: "root-secret",
      baseUrl: "https://api.example.com/v1",
      model: "chat-model",
      toolCalling: "auto",
      imageInput: "auto",
      chatModelRequestDelayMs: 0,
      activeProviderId: "chat",
      providers: [
        {
          id: "chat",
          name: "Chat",
          baseUrl: "https://api.example.com/v1",
          model: "chat-model",
          toolCalling: "auto",
          imageInput: "auto",
          apiKey: "provider-secret"
        }
      ],
      activeWebSearchProviderId: "search",
      webSearchProviders: [
        {
          id: "search",
          name: "Search",
          kind: "brave",
          baseUrl: "https://api.search.brave.com/res/v1/web/search",
          apiKey: "search-secret"
        }
      ],
      browserTaskModel: {
        providerId: "chat",
        model: "browser-model",
        apiKey: "browser-secret",
        fallbackModels: [
          {
            providerId: "chat",
            model: "browser-fallback",
            apiKey: "fallback-secret"
          }
        ]
      },
      browserVisualGrounding: {
        providerId: "chat",
        model: "nvidia/LocateAnything-3B",
        apiKey: "visual-secret"
      },
      disabledTools: [],
      trustMode: "ask",
      mcpServers: {
        demo: {
          command: "demo-server",
          args: [],
          env: { TOKEN: "mcp-secret" },
          disabled: false
        }
      },
      toolProposals: [],
      workspacePolicies: {},
      workspacePolicyProfiles: {}
    };

    const publicConfig = toPublicConfig(config);
    const serialized = JSON.stringify(publicConfig);

    expect(publicConfig.apiKeyPresent).toBe(true);
    expect(publicConfig.providers[0]?.apiKeyPresent).toBe(true);
    expect(publicConfig.webSearchProviders[0]?.apiKeyPresent).toBe(true);
    expect(publicConfig.browserTaskModel?.apiKeyPresent).toBe(true);
    expect(publicConfig.browserTaskModel?.fallbackModels?.[0]?.apiKeyPresent).toBe(true);
    expect(publicConfig.browserVisualGrounding?.apiKeyPresent).toBe(true);
    for (const secret of [
      "root-secret",
      "provider-secret",
      "search-secret",
      "browser-secret",
      "fallback-secret",
      "visual-secret",
      "mcp-secret"
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

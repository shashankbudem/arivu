import { describe, expect, it } from "vitest";
import { resolveModelForPrompt, type ModelProviderCandidate } from "../src/agent/modelRouter.js";
import type { ChatContent } from "../src/agent/content.js";
import type { AppConfig } from "../src/config.js";

describe("model router", () => {
  it("leaves manually selected models alone", () => {
    const selection = resolveModelForPrompt(config({ model: "manual-model" }), "hello");

    expect(selection).toMatchObject({
      mode: "manual",
      model: "manual-model",
      baseUrl: "https://integrate.api.nvidia.com/v1"
    });
  });

  it("routes short prompts to a fast model", () => {
    const selection = resolveModelForPrompt(config({ model: "auto" }), "summarize this quickly", {
      providers: [nvidiaProvider(["deepseek-ai/deepseek-v4-flash", "moonshotai/kimi-k2.6"])]
    });

    expect(selection).toMatchObject({
      mode: "auto",
      task: "fast",
      model: "deepseek-ai/deepseek-v4-flash"
    });
  });

  it("routes repo work to a coding model", () => {
    const selection = resolveModelForPrompt(config({ model: "auto" }), "fix the React component and run tests", {
      providers: [nvidiaProvider(["deepseek-ai/deepseek-v4-flash", "moonshotai/kimi-k2.6"])]
    });

    expect(selection).toMatchObject({
      task: "coding",
      model: "moonshotai/kimi-k2.6"
    });
  });

  it("routes image prompts to a vision model", () => {
    const content: ChatContent = [
      { type: "text", text: "what is in this screenshot?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc", detail: "auto" } }
    ];
    const selection = resolveModelForPrompt(config({ model: "auto" }), content, {
      providers: [nvidiaProvider(["meta/llama-3.2-90b-vision-instruct", "moonshotai/kimi-k2.6"])]
    });

    expect(selection).toMatchObject({
      task: "vision",
      model: "meta/llama-3.2-90b-vision-instruct"
    });
  });

  it("can choose a non-active provider when it is a better task fit", () => {
    const content: ChatContent = [
      { type: "text", text: "describe this image" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }
    ];
    const selection = resolveModelForPrompt(config({ model: "auto" }), content, {
      providers: [
        {
          id: "active",
          name: "Active Text Provider",
          baseUrl: "https://api.example.test/v1",
          model: "auto",
          apiKey: "test-key",
          active: true,
          models: ["plain-chat"]
        },
        nvidiaProvider(["meta/llama-3.2-90b-vision-instruct"])
      ]
    });

    expect(selection).toMatchObject({
      providerName: "NVIDIA NIM",
      model: "meta/llama-3.2-90b-vision-instruct"
    });
  });

  it("falls back to available model heuristics when preferred ids are unavailable", () => {
    const selection = resolveModelForPrompt(config({ model: "auto" }), "debug this stack trace", {
      providers: [nvidiaProvider(["custom-code-coder-32b", "plain-chat"])]
    });

    expect(selection).toMatchObject({
      task: "coding",
      model: "custom-code-coder-32b"
    });
  });
});

function config(patch: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "auto",
    activeProviderId: "nvidia",
    providers: [],
    trustMode: "ask",
    mcpServers: {},
    ...patch
  };
}

function nvidiaProvider(models: string[]): ModelProviderCandidate {
  return {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "auto",
    apiKey: "test-key",
    active: true,
    models
  };
}

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appConfigDir, appDataDir, loadConfig, saveConfig } from "../src/config.js";

let tempDir: string;

describe("config", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-config-"));
    process.env.ARIVU_CONFIG_HOME = tempDir;
    delete process.env.ARIVU_DATA_HOME;
    delete process.env.ARIVU_API_KEY;
    delete process.env.ARIVU_TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.ARIVU_BASE_URL;
    delete process.env.ARIVU_MODEL;
    delete process.env.ARIVU_TRUST_MODE;
    delete process.env.SHANKINSTER_API_KEY;
    delete process.env.SHANKINSTER_TAVILY_API_KEY;
    delete process.env.SHANKINSTER_BASE_URL;
    delete process.env.SHANKINSTER_MODEL;
    delete process.env.SHANKINSTER_TRUST_MODE;
    delete process.env.SHANKINSTER_CONFIG_HOME;
    delete process.env.SHANKINSTER_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.ARIVU_CONFIG_HOME;
    delete process.env.ARIVU_DATA_HOME;
    delete process.env.ARIVU_API_KEY;
    delete process.env.ARIVU_TAVILY_API_KEY;
    delete process.env.ARIVU_BASE_URL;
    delete process.env.ARIVU_MODEL;
    delete process.env.ARIVU_TRUST_MODE;
    delete process.env.TAVILY_API_KEY;
    delete process.env.SHANKINSTER_API_KEY;
    delete process.env.SHANKINSTER_TAVILY_API_KEY;
    delete process.env.SHANKINSTER_BASE_URL;
    delete process.env.SHANKINSTER_MODEL;
    delete process.env.SHANKINSTER_TRUST_MODE;
    delete process.env.SHANKINSTER_CONFIG_HOME;
    delete process.env.SHANKINSTER_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
  });

  it("loads defaults", async () => {
    await expect(loadConfig()).resolves.toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1",
      trustMode: "ask"
    });
  });

  it("keeps saved config when env vars are unset", async () => {
    await saveConfig({
      apiKey: "saved-key",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      model: "saved-model",
      trustMode: "trusted"
    });

    await expect(loadConfig()).resolves.toMatchObject({
      apiKey: "saved-key",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      model: "saved-model",
      trustMode: "trusted"
    });
  });

  it("ignores empty env vars", async () => {
    await saveConfig({ apiKey: "saved-key", model: "saved-model" });
    process.env.ARIVU_API_KEY = "";
    process.env.ARIVU_MODEL = "";

    await expect(loadConfig()).resolves.toMatchObject({
      apiKey: "saved-key",
      model: "saved-model"
    });
  });

  it("lets env override saved config", async () => {
    await saveConfig({ model: "saved-model" });
    process.env.ARIVU_MODEL = "env-model";
    await expect(loadConfig()).resolves.toMatchObject({ model: "env-model" });
  });

  it("loads Tavily API key from env", async () => {
    process.env.ARIVU_TAVILY_API_KEY = "tvly-test";
    await expect(loadConfig()).resolves.toMatchObject({ tavilyApiKey: "tvly-test" });
  });

  it("accepts legacy Shankinster env vars as fallbacks", async () => {
    process.env.SHANKINSTER_API_KEY = "legacy-key";
    process.env.SHANKINSTER_MODEL = "legacy-model";
    await expect(loadConfig()).resolves.toMatchObject({ apiKey: "legacy-key", model: "legacy-model" });
  });

  it("prefers Arivu env vars over legacy Shankinster env vars", async () => {
    process.env.ARIVU_MODEL = "arivu-model";
    process.env.SHANKINSTER_MODEL = "legacy-model";
    await expect(loadConfig()).resolves.toMatchObject({ model: "arivu-model" });
  });

  it("reuses standard Tavily API key env var", async () => {
    process.env.TAVILY_API_KEY = "tvly-standard";
    await expect(loadConfig()).resolves.toMatchObject({ tavilyApiKey: "tvly-standard" });
  });

  it("migrates legacy config and data directories without overwriting Arivu files", async () => {
    delete process.env.ARIVU_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, "xdg-config");
    process.env.XDG_DATA_HOME = path.join(tempDir, "xdg-data");

    const legacyConfigDir = path.join(process.env.XDG_CONFIG_HOME, "shankinster");
    const currentConfigDir = path.join(process.env.XDG_CONFIG_HOME, "arivu");
    await mkdir(legacyConfigDir, { recursive: true });
    await writeFile(path.join(legacyConfigDir, "config.json"), `${JSON.stringify({ model: "legacy-model" })}\n`, "utf8");

    const legacySessionsDir = path.join(process.env.XDG_DATA_HOME, "shankinster", "sessions");
    const currentSessionsDir = path.join(process.env.XDG_DATA_HOME, "arivu", "sessions");
    await mkdir(legacySessionsDir, { recursive: true });
    await mkdir(currentSessionsDir, { recursive: true });
    await writeFile(path.join(legacySessionsDir, "legacy.json"), "{}\n", "utf8");
    await writeFile(path.join(legacySessionsDir, "kept.json"), "legacy\n", "utf8");
    await writeFile(path.join(currentSessionsDir, "kept.json"), "current\n", "utf8");

    expect(appConfigDir()).toBe(currentConfigDir);
    await expect(loadConfig({ includeEnv: false })).resolves.toMatchObject({ model: "legacy-model" });
    expect(appDataDir()).toBe(path.join(process.env.XDG_DATA_HOME, "arivu"));
    await expect(readFile(path.join(currentSessionsDir, "legacy.json"), "utf8")).resolves.toBe("{}\n");
    await expect(readFile(path.join(currentSessionsDir, "kept.json"), "utf8")).resolves.toBe("current\n");
  });
});

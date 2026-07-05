import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REDACTED_SECRET_VALUE,
  appConfigDir,
  appDataDir,
  configPath,
  loadConfig,
  mergeRedactedMcpServers,
  normalizeWorkspacePolicyOverrides,
  normalizeWorkspacePolicyProfiles,
  redactConfigForDisplay,
  saveConfig,
  updateWorkspacePolicy,
  workspacePolicyOverridesForRoot,
  workspaceScopeRulesForRoot
} from "../src/config.js";

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
      toolCalling: "auto",
      imageInput: "auto",
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

  it("saves config with owner-only file permissions", async () => {
    await saveConfig({ apiKey: "saved-key" });

    const mode = (await stat(configPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("redacts secrets for display and preserves masked MCP env values", () => {
    const display = redactConfigForDisplay({
      apiKey: "saved-key",
      tavilyApiKey: "tavily-key",
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4.1",
          toolCalling: "auto",
          imageInput: "auto",
          apiKey: "provider-key"
        }
      ],
      mcpServers: {
        docs: {
          command: "server",
          args: [],
          env: { TOKEN: "mcp-token" },
          disabled: false
        }
      }
    });

    expect(display.apiKey).toBe(REDACTED_SECRET_VALUE);
    expect(display.tavilyApiKey).toBe(REDACTED_SECRET_VALUE);
    expect(display.providers?.[0]?.apiKey).toBe(REDACTED_SECRET_VALUE);
    expect(display.mcpServers?.docs?.env.TOKEN).toBe(REDACTED_SECRET_VALUE);

    expect(
      mergeRedactedMcpServers(
        {
          docs: {
            command: "server",
            args: [],
            env: { TOKEN: REDACTED_SECRET_VALUE },
            disabled: false
          }
        },
        {
          docs: {
            command: "server",
            args: [],
            env: { TOKEN: "mcp-token" },
            disabled: false
          }
        }
      ).docs.env.TOKEN
    ).toBe("mcp-token");
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

  it("persists provider capability flags", async () => {
    await writeFile(configPath(), `${JSON.stringify({
      toolCalling: "disabled",
      imageInput: "enabled",
      providers: [
        {
          id: "plain",
          name: "Plain Chat",
          baseUrl: "https://api.example.test/v1",
          model: "plain-model",
          toolCalling: "disabled",
          imageInput: "disabled"
        },
        {
          id: "legacy-default",
          name: "Legacy Default",
          baseUrl: "https://legacy.example.test/v1",
          model: "legacy-model"
        }
      ]
    })}\n`);

    const loaded = await loadConfig({ includeEnv: false });

    expect(loaded.toolCalling).toBe("disabled");
    expect(loaded.imageInput).toBe("enabled");
    expect(loaded.providers).toMatchObject([
      { id: "plain", toolCalling: "disabled", imageInput: "disabled" },
      { id: "legacy-default", toolCalling: "auto", imageInput: "auto" }
    ]);
  });

  it("saves workspace capability policy overrides by absolute workspace root", async () => {
    const workspaceRoot = path.join(tempDir, "repo");
    await saveConfig({
      workspacePolicies: updateWorkspacePolicy({}, workspaceRoot, {
        read_repo: "prompt",
        write_workspace: "prompt",
        browser_control: "deny"
      }, {
        blockedPathPrefixes: [".env", "secrets", ".env"],
        allowedNetworkDomains: ["https://api.tavily.com/search", "BING.com"],
        allowedMcpServers: ["github", "github", "chrome-devtools"],
        allowedBrowserTargetClasses: ["public", "background", "public"]
      })
    });

    const loaded = await loadConfig({ includeEnv: false });
    expect(workspacePolicyOverridesForRoot(loaded, workspaceRoot)).toEqual({
      read_repo: "prompt",
      write_workspace: "prompt",
      browser_control: "deny"
    });
    expect(workspaceScopeRulesForRoot(loaded, workspaceRoot)).toEqual({
      blockedPathPrefixes: [".env", "secrets"],
      allowedNetworkDomains: ["api.tavily.com", "bing.com"],
      allowedMcpServers: ["chrome-devtools", "github"],
      allowedBrowserTargetClasses: ["background", "public"]
    });
    expect(workspacePolicyOverridesForRoot(loaded, path.join(tempDir, "other"))).toEqual({});
    expect(workspaceScopeRulesForRoot(loaded, path.join(tempDir, "other"))).toEqual({});
  });

  it("saves reusable workspace policy profiles", async () => {
    await saveConfig({
      workspacePolicyProfiles: normalizeWorkspacePolicyProfiles({
        "  Sensitive   repo  ": {
          overrides: {
            read_repo: "prompt",
            network_fetch: "deny"
          },
          scopeRules: {
            blockedPathPrefixes: ["secrets", ".env", ".env"],
            allowedBrowserTargetClasses: ["public", "background", "public"]
          }
        }
      })
    });

    const loaded = await loadConfig({ includeEnv: false });
    expect(loaded.workspacePolicyProfiles).toEqual({
      "Sensitive repo": {
        overrides: {
          read_repo: "prompt",
          network_fetch: "deny"
        },
        scopeRules: {
          blockedPathPrefixes: [".env", "secrets"],
          allowedBrowserTargetClasses: ["background", "public"]
        }
      }
    });
  });

  it("normalizes workspace capability policy overrides", () => {
    const workspaceRoot = path.join(tempDir, "repo");
    const policies = updateWorkspacePolicy({}, workspaceRoot, {
      write_workspace: "prompt",
      browser_control: "deny",
      read_repo: "deny"
    } as ReturnType<typeof normalizeWorkspacePolicyOverrides>);

    expect(Object.keys(policies[path.resolve(workspaceRoot)]?.overrides ?? {})).toEqual([
      "write_workspace",
      "browser_control",
      "read_repo"
    ]);
    expect(
      updateWorkspacePolicy(
        policies,
        workspaceRoot,
        {},
        {
          blockedPathPrefixes: ["private", "private"],
          allowedNetworkDomains: ["Example.com"],
          allowedMcpServers: ["github", "github"],
          allowedBrowserTargetClasses: ["visible", "public", "visible"]
        }
      )[path.resolve(workspaceRoot)]?.scopeRules
    ).toEqual({
      blockedPathPrefixes: ["private"],
      allowedNetworkDomains: ["example.com"],
      allowedMcpServers: ["github"],
      allowedBrowserTargetClasses: ["public", "visible"]
    });
    expect(updateWorkspacePolicy(policies, workspaceRoot, {})).toEqual({});
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

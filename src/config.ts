import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { normalizeWorkspaceScopePolicyRules, type WorkspaceScopePolicyRules } from "./permissions/scopePolicy.js";
import { normalizeWorkspacePolicyProfiles } from "./permissions/workspacePolicyProfiles.js";

export { normalizeWorkspacePolicyProfileName, normalizeWorkspacePolicyProfiles } from "./permissions/workspacePolicyProfiles.js";

const APP_SLUG = "arivu";
const LEGACY_APP_SLUG = "shankinster";

const TrustModeSchema = z.enum(["ask", "readonly", "trusted"]);
const WorkspacePolicyCapabilitySchema = z.enum([
  "read_repo",
  "write_workspace",
  "run_command",
  "network_fetch",
  "browser_control",
  "mcp_call",
  "unknown"
]);
const CapabilityPolicyOverrideSchema = z.enum(["prompt", "deny"]);
const WorkspaceScopePolicyRulesSchema = z.object({
  blockedPathPrefixes: z.array(z.string()).optional(),
  allowedNetworkDomains: z.array(z.string()).optional(),
  allowedMcpServers: z.array(z.string()).optional(),
  allowedBrowserTargetClasses: z.array(z.enum(["background", "visible", "local", "file", "public"])).optional()
});

const McpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  disabled: z.boolean().default(false)
});

const ProviderToolCallingSchema = z.enum(["auto", "enabled", "disabled"]);
const ProviderImageInputSchema = z.enum(["auto", "enabled", "disabled"]);

const ContextWindowTokensSchema = z.number().int().min(1_000).max(10_000_000);

const LlmProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  toolCalling: ProviderToolCallingSchema.default("auto"),
  imageInput: ProviderImageInputSchema.default("auto"),
  contextWindowTokens: ContextWindowTokensSchema.optional(),
  apiKey: z.string().optional()
});

const BrowserTaskModelSchema = z.object({
  providerId: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  maxSteps: z.number().int().min(1).max(200).optional(),
  stepDelayMs: z.number().int().min(0).max(120_000).optional()
});

const WorkspaceCapabilityPolicySchema = z.object({
  overrides: z.record(WorkspacePolicyCapabilitySchema, CapabilityPolicyOverrideSchema).default({}),
  scopeRules: WorkspaceScopePolicyRulesSchema.default({})
});

const ConfigSchema = z.object({
  apiKey: z.string().optional(),
  tavilyApiKey: z.string().optional(),
  baseUrl: z.string().url().default("https://api.openai.com/v1"),
  model: z.string().default("gpt-4.1"),
  toolCalling: ProviderToolCallingSchema.default("auto"),
  imageInput: ProviderImageInputSchema.default("auto"),
  requestTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  contextWindowTokens: ContextWindowTokensSchema.optional(),
  activeProviderId: z.string().optional(),
  providers: z.array(LlmProviderSchema).default([]),
  browserTaskModel: BrowserTaskModelSchema.optional(),
  disabledTools: z.array(z.string()).default([]),
  trustMode: TrustModeSchema.default("ask"),
  mcpServers: z.record(McpServerSchema).default({}),
  workspacePolicies: z.record(WorkspaceCapabilityPolicySchema).default({}),
  workspacePolicyProfiles: z.record(WorkspaceCapabilityPolicySchema).default({})
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type LlmProviderProfile = z.infer<typeof LlmProviderSchema>;
export type BrowserTaskModelConfigProfile = z.infer<typeof BrowserTaskModelSchema>;

export function resolveModelListEndpoint(
  config: AppConfig,
  selection: { providerId?: string; baseUrl?: string; apiKey?: string }
): { baseUrl: string; apiKey?: string } {
  const requestedProvider = selection.providerId ? config.providers.find((provider) => provider.id === selection.providerId) : undefined;
  const requestedProviderUsesActiveSecret = Boolean(
    requestedProvider &&
    (requestedProvider.id === config.activeProviderId || (!config.activeProviderId && requestedProvider.baseUrl === config.baseUrl))
  );
  const unknownProviderUsesActiveEndpoint = Boolean(
    selection.providerId && !requestedProvider && selection.baseUrl?.trim() === config.baseUrl
  );
  return {
    baseUrl: selection.baseUrl?.trim() || requestedProvider?.baseUrl || config.baseUrl,
    apiKey:
      selection.apiKey?.trim() ||
      requestedProvider?.apiKey ||
      (!selection.providerId || requestedProviderUsesActiveSecret || unknownProviderUsesActiveEndpoint ? config.apiKey : undefined)
  };
}
export type ProviderToolCallingMode = z.infer<typeof ProviderToolCallingSchema>;
export type ProviderImageInputMode = z.infer<typeof ProviderImageInputSchema>;
export type ProviderCapabilityName = "toolCalling" | "imageInput";
export type ProviderCapabilityObservationPatch = {
  providerId?: string;
  baseUrl: string;
  capability: ProviderCapabilityName;
  value: "disabled";
};
export type WorkspacePolicyCapability = z.infer<typeof WorkspacePolicyCapabilitySchema>;
export type WorkspaceCapabilityPolicyOverrides = Partial<Record<WorkspacePolicyCapability, CapabilityPolicyOverrideEffect>>;
export type WorkspaceCapabilityPolicyScopeRules = WorkspaceScopePolicyRules;
export type WorkspaceCapabilityPolicy = z.infer<typeof WorkspaceCapabilityPolicySchema>;
export type WorkspacePolicyProfiles = Record<string, WorkspaceCapabilityPolicy>;
export type ConfigKey = Exclude<keyof AppConfig, "mcpServers" | "providers" | "activeProviderId">;
export const REDACTED_SECRET_VALUE = "********";

export function appEnv(name: string) {
  const current = process.env[`ARIVU_${name}`];
  return current === undefined || current === "" ? process.env[`SHANKINSTER_${name}`] : current;
}

export async function loadConfig(options: { includeEnv?: boolean } = {}): Promise<AppConfig> {
  const includeEnv = options.includeEnv ?? true;
  const fileConfig = await readSavedConfig();
  const envConfig = includeEnv
    ? {
        apiKey: appEnv("API_KEY"),
        tavilyApiKey: appEnv("TAVILY_API_KEY") || process.env.TAVILY_API_KEY,
        baseUrl: appEnv("BASE_URL"),
        model: appEnv("MODEL"),
        trustMode: appEnv("TRUST_MODE"),
        mcpServers: undefined
      }
    : {};

  return normalizeLoadedConfig(ConfigSchema.parse({ ...fileConfig, ...removeUnsetEnv(envConfig) }));
}

export async function saveConfig(config: Partial<AppConfig>) {
  const parsed = normalizeConfigPatch(ConfigSchema.partial().parse(config));
  const file = configPath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

export function configPath() {
  return path.join(appConfigDir(), "config.json");
}

export function appConfigDir() {
  const configHome = appEnv("CONFIG_HOME");
  if (configHome) {
    return configHome;
  }
  if (process.env.XDG_CONFIG_HOME) {
    return migrateLegacyAppDir(path.join(process.env.XDG_CONFIG_HOME, APP_SLUG), path.join(process.env.XDG_CONFIG_HOME, LEGACY_APP_SLUG));
  }
  if (process.platform === "darwin") {
    return migrateLegacyAppDir(
      path.join(os.homedir(), "Library", "Application Support", APP_SLUG),
      path.join(os.homedir(), "Library", "Application Support", LEGACY_APP_SLUG)
    );
  }
  return migrateLegacyAppDir(path.join(os.homedir(), ".config", APP_SLUG), path.join(os.homedir(), ".config", LEGACY_APP_SLUG));
}

export function appDataDir() {
  const dataHome = appEnv("DATA_HOME");
  if (dataHome) {
    return dataHome;
  }
  if (process.env.XDG_DATA_HOME) {
    return migrateLegacyAppDir(path.join(process.env.XDG_DATA_HOME, APP_SLUG), path.join(process.env.XDG_DATA_HOME, LEGACY_APP_SLUG));
  }
  if (process.platform === "darwin") {
    return migrateLegacyAppDir(
      path.join(os.homedir(), "Library", "Application Support", APP_SLUG),
      path.join(os.homedir(), "Library", "Application Support", LEGACY_APP_SLUG)
    );
  }
  return migrateLegacyAppDir(
    path.join(os.homedir(), ".local", "share", APP_SLUG),
    path.join(os.homedir(), ".local", "share", LEGACY_APP_SLUG)
  );
}

export function redactConfigForDisplay(config: Partial<AppConfig>): Partial<AppConfig> {
  return {
    ...config,
    apiKey: redactSecret(config.apiKey),
    tavilyApiKey: redactSecret(config.tavilyApiKey),
    providers: config.providers?.map((provider) => ({
      ...provider,
      apiKey: redactSecret(provider.apiKey)
    })),
    browserTaskModel: config.browserTaskModel
      ? { ...config.browserTaskModel, apiKey: redactSecret(config.browserTaskModel.apiKey) }
      : config.browserTaskModel,
    mcpServers: config.mcpServers ? redactMcpServers(config.mcpServers) : config.mcpServers
  };
}

export function redactMcpServers(servers: AppConfig["mcpServers"]): AppConfig["mcpServers"] {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      {
        ...server,
        env: Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, value ? REDACTED_SECRET_VALUE : value]))
      }
    ])
  );
}

export function applyProviderCapabilityObservation(config: AppConfig, observation: ProviderCapabilityObservationPatch): AppConfig {
  if (observation.value !== "disabled") {
    return config;
  }

  const capability = observation.capability;
  if (config.providers.length > 0) {
    const targetId = observation.providerId ?? config.activeProviderId;
    const normalizedBaseUrl = normalizeCapabilityBaseUrl(observation.baseUrl);
    let changed = false;
    let matchedProviderIsActive = false;
    const providers = config.providers.map((provider): LlmProviderProfile => {
      const isTarget = targetId ? provider.id === targetId : normalizeCapabilityBaseUrl(provider.baseUrl) === normalizedBaseUrl;
      if (!isTarget) {
        return provider;
      }
      matchedProviderIsActive = provider.id === config.activeProviderId;
      if (provider[capability] !== "auto") {
        return provider;
      }
      changed = true;
      return {
        ...provider,
        [capability]: "disabled"
      } as LlmProviderProfile;
    });

    if (!changed) {
      return config;
    }

    return {
      ...config,
      providers,
      ...(matchedProviderIsActive && config[capability] === "auto" ? { [capability]: "disabled" } : {})
    };
  }

  if (normalizeCapabilityBaseUrl(config.baseUrl) !== normalizeCapabilityBaseUrl(observation.baseUrl) || config[capability] !== "auto") {
    return config;
  }

  return {
    ...config,
    [capability]: "disabled"
  };
}

/**
 * Canonical key for "the same provider endpoint": trim, drop trailing slashes, lowercase. Shared by
 * the capability-observation matcher and the model catalog, which keys per-(endpoint, model) facts
 * so they survive a provider row being renamed, recreated, or given a fresh id.
 */
export function normalizeCapabilityBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "").toLowerCase();
}

export function mergeRedactedMcpServers(next: AppConfig["mcpServers"], existing: AppConfig["mcpServers"] = {}): AppConfig["mcpServers"] {
  return Object.fromEntries(
    Object.entries(next).map(([name, server]) => {
      const existingEnv = existing[name]?.env ?? {};
      return [
        name,
        {
          ...server,
          env: Object.fromEntries(
            Object.entries(server.env ?? {}).map(([key, value]) => [
              key,
              value === REDACTED_SECRET_VALUE ? (existingEnv[key] ?? value) : value
            ])
          )
        }
      ];
    })
  );
}

export function workspacePolicyOverridesForRoot(config: AppConfig, workspaceRoot: string | undefined): WorkspaceCapabilityPolicyOverrides {
  if (!workspaceRoot) {
    return {};
  }
  const policy = config.workspacePolicies[path.resolve(workspaceRoot)];
  return policy?.overrides ?? {};
}

export function workspaceScopeRulesForRoot(config: AppConfig, workspaceRoot: string | undefined): WorkspaceCapabilityPolicyScopeRules {
  if (!workspaceRoot) {
    return {};
  }
  const policy = config.workspacePolicies[path.resolve(workspaceRoot)];
  return normalizeWorkspaceScopePolicyRules(policy?.scopeRules);
}

function normalizeLoadedConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    workspacePolicyProfiles: normalizeWorkspacePolicyProfiles(config.workspacePolicyProfiles)
  };
}

function normalizeConfigPatch(config: Partial<AppConfig>): Partial<AppConfig> {
  if (!config.workspacePolicyProfiles) {
    return config;
  }
  return {
    ...config,
    workspacePolicyProfiles: normalizeWorkspacePolicyProfiles(config.workspacePolicyProfiles)
  };
}

async function readSavedConfig(): Promise<Partial<AppConfig>> {
  try {
    const raw = await readFile(configPath(), "utf8");
    return ConfigSchema.partial().parse(JSON.parse(raw));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function removeUnsetEnv<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== "")) as Partial<T>;
}

function redactSecret(value: string | undefined) {
  return value ? REDACTED_SECRET_VALUE : value;
}

function migrateLegacyAppDir(currentDir: string, legacyDir: string) {
  if (currentDir !== legacyDir && existsSync(legacyDir)) {
    copyMissingEntries(legacyDir, currentDir);
  }
  return currentDir;
}

function copyMissingEntries(source: string, target: string) {
  if (!existsSync(source)) {
    return;
  }
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    const sourcePath = path.join(source, entry);
    const targetPath = path.join(target, entry);
    const stat = lstatSync(sourcePath);
    if (existsSync(targetPath)) {
      if (stat.isDirectory() && lstatSync(targetPath).isDirectory()) {
        copyMissingEntries(sourcePath, targetPath);
      }
      continue;
    }

    if (stat.isDirectory()) {
      copyMissingEntries(sourcePath, targetPath);
    } else if (stat.isFile()) {
      copyFileSync(sourcePath, targetPath);
    }
  }
}

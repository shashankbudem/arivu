import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { CapabilityPolicyOverrideEffect } from "./permissions/capabilityPolicy.js";

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

const McpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  disabled: z.boolean().default(false)
});

const LlmProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().optional()
});

const WorkspaceCapabilityPolicySchema = z.object({
  overrides: z.record(WorkspacePolicyCapabilitySchema, CapabilityPolicyOverrideSchema).default({})
});

const ConfigSchema = z.object({
  apiKey: z.string().optional(),
  tavilyApiKey: z.string().optional(),
  baseUrl: z.string().url().default("https://api.openai.com/v1"),
  model: z.string().default("gpt-4.1"),
  activeProviderId: z.string().optional(),
  providers: z.array(LlmProviderSchema).default([]),
  trustMode: TrustModeSchema.default("ask"),
  mcpServers: z.record(McpServerSchema).default({}),
  workspacePolicies: z.record(WorkspaceCapabilityPolicySchema).default({})
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type LlmProviderProfile = z.infer<typeof LlmProviderSchema>;
export type WorkspacePolicyCapability = z.infer<typeof WorkspacePolicyCapabilitySchema>;
export type WorkspaceCapabilityPolicyOverrides = Partial<Record<WorkspacePolicyCapability, CapabilityPolicyOverrideEffect>>;
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

  return ConfigSchema.parse({ ...fileConfig, ...removeUnsetEnv(envConfig) });
}

export async function saveConfig(config: Partial<AppConfig>) {
  const parsed = ConfigSchema.partial().parse(config);
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
  return migrateLegacyAppDir(path.join(os.homedir(), ".local", "share", APP_SLUG), path.join(os.homedir(), ".local", "share", LEGACY_APP_SLUG));
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

export function mergeRedactedMcpServers(next: AppConfig["mcpServers"], existing: AppConfig["mcpServers"] = {}): AppConfig["mcpServers"] {
  return Object.fromEntries(
    Object.entries(next).map(([name, server]) => {
      const existingEnv = existing[name]?.env ?? {};
      return [
        name,
        {
          ...server,
          env: Object.fromEntries(
            Object.entries(server.env ?? {}).map(([key, value]) => [key, value === REDACTED_SECRET_VALUE ? (existingEnv[key] ?? value) : value])
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

export function updateWorkspacePolicy(
  policies: AppConfig["workspacePolicies"],
  workspaceRoot: string,
  overrides: WorkspaceCapabilityPolicyOverrides
): AppConfig["workspacePolicies"] {
  const root = path.resolve(workspaceRoot);
  const normalized = normalizeWorkspacePolicyOverrides(overrides);
  const next = { ...policies };
  if (Object.keys(normalized).length === 0) {
    delete next[root];
  } else {
    next[root] = { overrides: normalized };
  }
  return next;
}

export function normalizeWorkspacePolicyOverrides(overrides: WorkspaceCapabilityPolicyOverrides): WorkspaceCapabilityPolicyOverrides {
  return Object.fromEntries(
    Object.entries(overrides).filter(
      (entry): entry is [keyof WorkspaceCapabilityPolicyOverrides, CapabilityPolicyOverrideEffect] =>
        isWorkspacePolicyCapability(entry[0]) && (entry[1] === "prompt" || entry[1] === "deny")
    )
  );
}

function isWorkspacePolicyCapability(value: string): value is keyof WorkspaceCapabilityPolicyOverrides {
  return WorkspacePolicyCapabilitySchema.safeParse(value).success;
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

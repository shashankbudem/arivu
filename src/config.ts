import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const APP_SLUG = "arivu";
const LEGACY_APP_SLUG = "shankinster";

const TrustModeSchema = z.enum(["ask", "readonly", "trusted"]);

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

const ConfigSchema = z.object({
  apiKey: z.string().optional(),
  tavilyApiKey: z.string().optional(),
  baseUrl: z.string().url().default("https://api.openai.com/v1"),
  model: z.string().default("gpt-4.1"),
  activeProviderId: z.string().optional(),
  providers: z.array(LlmProviderSchema).default([]),
  trustMode: TrustModeSchema.default("ask"),
  mcpServers: z.record(McpServerSchema).default({})
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type LlmProviderProfile = z.infer<typeof LlmProviderSchema>;
export type ConfigKey = Exclude<keyof AppConfig, "mcpServers" | "providers" | "activeProviderId">;

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
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
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

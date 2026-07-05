#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import { Agent } from "./agent/Agent.js";
import { COMPACT_RECENT_MESSAGE_COUNT, compactSessionMessages } from "./agent/contextCompaction.js";
import type { AgentSession } from "./agent/types.js";
import { OpenAICompatibleChatClient } from "./agent/OpenAICompatibleChatClient.js";
import {
  loadConfig,
  redactConfigForDisplay,
  saveConfig,
  workspacePolicyOverridesForRoot,
  workspaceScopeRulesForRoot,
  type AppConfig,
  type ConfigKey
} from "./config.js";
import { runDoctor, type DoctorReport, type DoctorStatus } from "./diagnostics/doctor.js";
import { ApprovalManager } from "./permissions/ApprovalManager.js";
import { SessionStore } from "./sessions/SessionStore.js";
import {
  describeSessionListFilters,
  filterSessions,
  sessionDisplayTitle,
  sessionWorkspacePath,
  type SessionListFilters
} from "./sessions/sessionList.js";
import { TuiApp } from "./tui/TuiApp.js";
import { detectWorkspace } from "./workspace.js";

const program = new Command();

program
  .name("arivu")
  .description("A local TUI coding agent.")
  .version("0.1.0")
  .option("-m, --model <model>", "model name")
  .option("-b, --base-url <url>", "OpenAI-compatible API base URL")
  .option("--trust <mode>", "trust mode: ask, readonly, trusted")
  .argument("[task...]", "task to run in one-shot mode")
  .action(async (taskParts: string[], options: RootOptions) => {
    const config = await loadConfig();
    const resolved = validateRuntimeConfig({
      ...config,
      model: options.model ?? config.model,
      baseUrl: options.baseUrl ?? config.baseUrl,
      trustMode: options.trust ?? config.trustMode
    });

    const task = taskParts.join(" ").trim();
    if (task.length > 0) {
      await runOneShot(task, resolved);
      return;
    }

    await runTui(resolved);
  });

program
  .command("resume")
  .description("Resume a saved session in the TUI.")
  .argument("<session-id>", "session id")
  .action(async (sessionId: string) => {
    const config = await loadConfig();
    const store = new SessionStore();
    const session = await store.load(sessionId);
    const resumedConfig = validateRuntimeConfig({
      ...config,
      model: session.model ?? config.model,
      baseUrl: session.baseUrl ?? config.baseUrl,
      trustMode: session.trustMode
    });

    await runTui(resumedConfig, session);
  });

program
  .command("sessions")
  .description("List recent saved sessions.")
  .option("-l, --limit <count>", "maximum sessions to show", parseLimit, 20)
  .option("-s, --search <text>", "filter by session id, title, message, model, provider, or workspace")
  .option("-w, --workspace <text>", "filter by workspace path or folder name")
  .option("--pinned", "show only pinned sessions")
  .option("--unpinned", "show only unpinned sessions")
  .option("--project", "show only project/workspace sessions")
  .option("--standalone", "show only standalone chats")
  .action(async (options: SessionsOptions) => {
    const store = new SessionStore();
    const filters = sessionFiltersFromCliOptions(options);
    const sessions = filterSessions(await store.list(), filters);
    const visible = sessions.slice(0, options.limit);
    const filterDescription = describeSessionListFilters(filters);
    if (visible.length === 0) {
      console.log(chalk.dim(filterDescription ? `No saved sessions match filters: ${filterDescription}.` : "No saved sessions."));
      return;
    }

    if (filterDescription) {
      console.log(chalk.dim(`Filters: ${filterDescription}`));
    }
    console.log(["ID", "UPDATED", "WORKSPACE", "TITLE"].join("\t"));
    for (const session of visible) {
      console.log([session.id, formatCliDate(session.updatedAt), sessionWorkspacePath(session), sessionDisplayTitle(session)].join("\t"));
    }
  });

program
  .command("compact")
  .description("Compact a saved session transcript locally.")
  .argument("<session-id>", "session id")
  .option("--recent <count>", "number of recent non-system messages to keep", String(COMPACT_RECENT_MESSAGE_COUNT))
  .option("--entry-limit <chars>", "maximum characters per compacted summary entry")
  .option("--dry-run", "show what would be compacted without saving")
  .action(async (sessionId: string, options: CompactOptions) => {
    const store = new SessionStore();
    const session = await store.load(sessionId);
    const now = new Date();
    const recentMessageCount = parsePositiveInteger(options.recent, "Recent message count");
    const entryCharacterLimit = options.entryLimit ? parsePositiveInteger(options.entryLimit, "Entry limit") : undefined;
    const result = compactSessionMessages(session.messages, {
      recentMessageCount,
      entryCharacterLimit,
      now
    });

    if (!result.compacted) {
      console.log(
        chalk.dim(
          `Session ${session.id} is already compact enough. Non-system messages: ${result.remainingMessageCount}; recent window: ${recentMessageCount}.`
        )
      );
      return;
    }

    if (!options.dryRun) {
      await store.save({
        ...session,
        messages: result.messages,
        updatedAt: now.toISOString()
      });
    }

    console.log(chalk.green(`${options.dryRun ? "Would compact" : "Compacted"} session ${session.id}.`));
    console.log(`Compacted messages: ${result.compactedMessageCount}`);
    console.log(`Kept recent messages: ${result.remainingMessageCount}`);
    console.log(`Total stored messages after compaction: ${result.messages.length}`);
  });

program
  .command("config")
  .description("Read or update arivu config.")
  .argument("<action>", "get or set")
  .argument("[key]", "config key")
  .argument("[value]", "config value")
  .action(async (action: string, key?: ConfigKey, value?: string) => {
    const config = await loadConfig({ includeEnv: false });
    if (action === "get") {
      const displayConfig = redactConfigForDisplay(config);
      if (key) {
        if (!isConfigKey(key)) {
          throw new Error(`Unknown config key: ${key}`);
        }
        console.log(JSON.stringify({ [key]: displayConfig[key] ?? null }, null, 2));
        return;
      }
      console.log(JSON.stringify(displayConfig, null, 2));
      return;
    }

    if (action === "set") {
      if (!key || value === undefined) {
        throw new Error("Usage: arivu config set <key> <value>");
      }
      if (!isConfigKey(key)) {
        throw new Error(`Unknown config key: ${key}`);
      }
      const next = { ...config, [key]: value };
      await saveConfig(next);
      console.log(chalk.green(`Saved ${key}.`));
      return;
    }

    throw new Error(`Unknown config action: ${action}`);
  });

program
  .command("doctor")
  .description("Validate API, model, tool-calling, streaming, and Tavily connectivity.")
  .option("--json", "print raw JSON report")
  .action(async (options: DoctorOptions) => {
    const config = await loadConfig();
    const report = await runDoctor(config);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printDoctorReport(report);
  });

type RootOptions = {
  model?: string;
  baseUrl?: string;
  trust?: string;
};

type SessionsOptions = {
  limit: number;
  search?: string;
  workspace?: string;
  pinned?: boolean;
  unpinned?: boolean;
  project?: boolean;
  standalone?: boolean;
};

type CompactOptions = {
  recent: string;
  entryLimit?: string;
  dryRun?: boolean;
};

type DoctorOptions = {
  json?: boolean;
};

async function runTui(config: AppConfig, session?: AgentSession) {
  const app = new TuiApp({
    config,
    cwd: session?.cwd ?? process.cwd(),
    session
  });
  await app.run();
}

async function runOneShot(task: string, config: AppConfig) {
  const cwd = process.cwd();
  const workspace = await detectWorkspace(cwd);
  const client = new OpenAICompatibleChatClient(config);
  const scopePolicyRules = workspaceScopeRulesForRoot(config, workspace.root);
  const approvals = new ApprovalManager(
    config.trustMode,
    undefined,
    workspacePolicyOverridesForRoot(config, workspace.root),
    undefined,
    scopePolicyRules
  );
  const agent = new Agent({
    client,
    approvals,
    cwd,
    model: config.model,
    baseUrl: config.baseUrl,
    tavilyApiKey: config.tavilyApiKey,
    mcpServers: config.mcpServers,
    scopePolicyRules
  });
  const store = new SessionStore();

  const result = await agent.run(task);
  await store.save(result.session);
  console.log(result.output);
  console.log(chalk.dim(`Session ${result.session.id} saved.`));
}

function validateRuntimeConfig(config: Omit<AppConfig, "trustMode"> & { trustMode: string }): AppConfig {
  if (!isTrustMode(config.trustMode)) {
    throw new Error(`Invalid trust mode: ${config.trustMode}`);
  }
  return { ...config, trustMode: config.trustMode };
}

function isTrustMode(value: string): value is AppConfig["trustMode"] {
  return ["ask", "readonly", "trusted"].includes(value);
}

function isConfigKey(key: string): key is ConfigKey {
  return ["apiKey", "tavilyApiKey", "baseUrl", "model", "toolCalling", "trustMode"].includes(key);
}

function formatCliDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseLimit(value: string) {
  return parsePositiveInteger(value, "Limit");
}

function parsePositiveInteger(value: string, label = "Value") {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function sessionFiltersFromCliOptions(options: SessionsOptions): SessionListFilters {
  if (options.pinned && options.unpinned) {
    throw new Error("Use only one of --pinned or --unpinned.");
  }
  if (options.project && options.standalone) {
    throw new Error("Use only one of --project or --standalone.");
  }
  return {
    search: options.search,
    workspace: options.workspace,
    pinned: options.pinned ? "pinned" : options.unpinned ? "unpinned" : "all",
    project: options.project ? "project" : options.standalone ? "standalone" : "all"
  };
}

function printDoctorReport(report: DoctorReport) {
  console.log(chalk.bold("arivu doctor"));
  for (const entry of report.checks) {
    console.log(`${statusLabel(entry.status)} ${entry.label}: ${entry.message}`);
    if (entry.detail) {
      console.log(chalk.dim(indent(entry.detail)));
    }
  }
  console.log(
    chalk.dim(
      `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail, ${report.summary.skip} skip`
    )
  );
}

function statusLabel(status: DoctorStatus) {
  const label = `[${status.toUpperCase()}]`;
  if (status === "pass") {
    return chalk.green(label);
  }
  if (status === "warn") {
    return chalk.yellow(label);
  }
  if (status === "fail") {
    return chalk.red(label);
  }
  return chalk.gray(label);
}

function indent(value: string) {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

program.parseAsync(process.argv).catch((error) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});

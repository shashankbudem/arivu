#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import { Agent } from "./agent/Agent.js";
import { COMPACT_RECENT_MESSAGE_COUNT, compactSessionMessages } from "./agent/contextCompaction.js";
import type { AgentSession } from "./agent/types.js";
import { OpenAICompatibleChatClient } from "./agent/OpenAICompatibleChatClient.js";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  redactConfigForDisplay,
  resolveModelListEndpoint,
  saveConfig,
  workspacePolicyOverridesForRoot,
  workspaceScopeRulesForRoot,
  type AppConfig,
  type ConfigKey
} from "./config.js";
import { runDoctor, type DoctorReport, type DoctorStatus } from "./diagnostics/doctor.js";
import { terminalElicit } from "./tools/elicitation.js";
import { ModelCatalogStore } from "./models/ModelCatalogStore.js";
import { resolveContextWindowTokens } from "./models/contextResolver.js";
import type { ModelCatalog } from "./models/modelCatalogSchema.js";
import { recordContextFact, recordContextFromRuntime, runModelCatalogSync, type SyncSummary } from "./models/syncModelCatalog.js";
import { probeContextViaMaxTokens, probeContextViaOversizedInput } from "./models/probe.js";
import { installLaunchAgent, launchAgentInstalled, launchAgentPath, uninstallLaunchAgent } from "./models/schedule.js";
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

const models = program.command("models").description("Inspect and maintain the provider model catalog.");

models
  .command("sync")
  .description("Record each model's status and context length, and detect added/removed models.")
  .option("--json", "print the raw JSON summary")
  .option("--dry-run", "compute the diff without writing the catalog")
  .option("--force-active", "include the active model (normally only swept on Mondays)")
  .option("--reprobe", "re-probe context length even for models that already have one")
  .option("--max-probes <count>", "cap context probes for this run", (value) => Number.parseInt(value, 10))
  .option("--rpm <count>", "requests per minute", (value) => Number.parseInt(value, 10))
  .option("--provider <id>", "provider id to sync (defaults to the active provider)")
  .action(async (options: ModelsSyncOptions) => {
    const config = await loadConfig();
    const summary = await runModelCatalogSync(config, {
      dryRun: options.dryRun,
      forceActive: options.forceActive,
      reprobe: options.reprobe,
      maxProbes: options.maxProbes,
      rpm: options.rpm,
      providerId: options.provider
    });
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    printSyncSummary(summary);
  });

models
  .command("status")
  .description("Show the stored catalog: status and context length per model.")
  .option("--json", "print the raw catalog")
  .option("--all", "include models the provider has removed (tombstones)")
  .action(async (options: { json?: boolean; all?: boolean }) => {
    const catalog = await new ModelCatalogStore().load();
    if (options.json) {
      console.log(JSON.stringify(catalog, null, 2));
      return;
    }
    printCatalog(catalog, Boolean(options.all));
  });

models
  .command("events")
  .description("Show recent catalog changes: models added/removed, status flips, resolved windows.")
  .option("--json", "print the raw events")
  .option("--limit <count>", "events to show (newest first)", (value) => Number.parseInt(value, 10), 30)
  .action(async (options: { json?: boolean; limit: number }) => {
    const events = await new ModelCatalogStore().readEvents(options.limit);
    if (options.json) {
      console.log(JSON.stringify(events, null, 2));
      return;
    }
    if (events.length === 0) {
      console.log("No catalog events yet. Run: arivu models sync");
      return;
    }
    for (const event of events) {
      const at = chalk.dim(event.at.replace("T", " ").slice(0, 16));
      switch (event.type) {
        case "model_added":
          console.log(`${at} ${chalk.green("+ added")}    ${event.model}`);
          break;
        case "model_removed":
          console.log(`${at} ${chalk.red("- removed")}  ${event.model}`);
          break;
        case "status_changed":
          console.log(`${at} ${chalk.yellow("~ status")}   ${event.model}: ${event.from} → ${event.to}`);
          break;
        case "context_resolved":
          console.log(`${at} ${chalk.cyan("◆ context")}  ${event.model}: ${event.tokens.toLocaleString()} tokens (${event.source})`);
          break;
        case "context_changed":
          console.log(
            `${at} ${chalk.cyan("◆ context")}  ${event.model}: ${event.from.toLocaleString()} → ${event.to.toLocaleString()} tokens (${event.source})`
          );
          break;
      }
    }
  });

models
  .command("probe-context <model>")
  .description("Resolve one model's context length, optionally with the slow oversized-input probe.")
  .option("--deep", "use the reliable oversized-input probe (multi-MB upload)")
  .option("--approx-tokens <count>", "input size for --deep; must exceed the model's window (1M-context models need ~1200000)", (value) =>
    Number.parseInt(value, 10)
  )
  .action(async (model: string, options: { deep?: boolean; approxTokens?: number }) => {
    const config = await loadConfig();
    const { baseUrl, apiKey } = resolveModelListEndpoint(config, { providerId: config.activeProviderId });
    if (!options.deep) {
      console.log(chalk.dim("Tip: --deep uses an oversized input; it is slower but works on models that ignore max_tokens."));
    }
    const result = options.deep
      ? await probeContextViaOversizedInput({ baseUrl, apiKey, model }, fetch, options.approxTokens)
      : await probeContextViaMaxTokens({ baseUrl, apiKey, model }, fetch);
    if (result.tokens && result.source) {
      console.log(`${chalk.bold(model)}: ${result.tokens.toLocaleString()} tokens (${result.source})`);
      const store = new ModelCatalogStore();
      await recordContextFact(store, { baseUrl, model }, { tokens: result.tokens, source: result.source });
      console.log(chalk.dim(`Recorded in ${store.catalogPath}.`));
      return;
    }
    console.log(`${chalk.bold(model)}: ${chalk.yellow("unresolved")} — ${result.error ?? "no limit reported"}`);
    process.exitCode = 1;
  });

models
  .command("schedule")
  .description("Install, remove, or inspect the daily 7AM catalog sync (macOS launchd).")
  .option("--install", "write the LaunchAgent plist")
  .option("--uninstall", "remove the LaunchAgent plist")
  .action(async (options: { install?: boolean; uninstall?: boolean }) => {
    if (options.install && options.uninstall) {
      throw new Error("Choose either --install or --uninstall.");
    }
    if (options.install) {
      const cliPath = fileURLToPath(import.meta.url);
      const result = await installLaunchAgent({ cliPath });
      console.log(`Wrote ${result.plistPath}`);
      console.log(`  node: ${result.nodePath}`);
      console.log(`  cli:  ${result.cliPath}`);
      console.log(`  log:  ${result.logFile}`);
      console.log(`\nActivate it with:\n  ${chalk.cyan(result.bootstrapCommand)}`);
      return;
    }
    if (options.uninstall) {
      const result = await uninstallLaunchAgent();
      console.log(`Removed ${result.plistPath}`);
      console.log(`\nDeactivate it with:\n  ${chalk.cyan(result.bootoutCommand)}`);
      return;
    }
    const installed = await launchAgentInstalled();
    console.log(installed ? `Installed: ${launchAgentPath()}` : "Not installed. Run: arivu models schedule --install");
  });

type ModelsSyncOptions = {
  json?: boolean;
  dryRun?: boolean;
  forceActive?: boolean;
  reprobe?: boolean;
  maxProbes?: number;
  rpm?: number;
  provider?: string;
};

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
    scopePolicyRules,
    workspace.root
  );
  const catalogStore = new ModelCatalogStore();
  const agent = new Agent({
    client,
    approvals,
    cwd,
    model: config.model,
    baseUrl: config.baseUrl,
    tavilyApiKey: config.tavilyApiKey,
    mcpServers: config.mcpServers,
    scopePolicyRules,
    // Interactive terminal sessions can answer structured ask_user questions inline.
    elicit: terminalElicit,
    // Per-model window from the catalog, capped by any hand-entered provider value.
    contextWindowTokens: resolveContextWindowTokens(config, { model: config.model, baseUrl: config.baseUrl }, await catalogStore.load()),
    onContextWindowObserved: (tokens) => recordContextFromRuntime(catalogStore, { baseUrl: config.baseUrl, model: config.model }, tokens)
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
  return ["apiKey", "tavilyApiKey", "baseUrl", "model", "toolCalling", "imageInput", "trustMode"].includes(key);
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

function printSyncSummary(summary: SyncSummary) {
  console.log(chalk.bold(`arivu models sync${summary.dryRun ? chalk.yellow(" (dry run)") : ""}`));
  console.log(`  endpoint      ${summary.baseUrl}`);
  console.log(`  listed        ${summary.listed} models`);
  console.log(`  active model  ${summary.includedActiveModel ? `included (${summary.activeReason})` : "skipped (checked on Mondays)"}`);
  if (summary.added.length) {
    console.log(chalk.green(`  added         ${summary.added.length}`));
    for (const model of summary.added.slice(0, 20)) {
      console.log(chalk.green(`    + ${model}`));
    }
  }
  if (summary.removed.length) {
    console.log(chalk.red(`  removed       ${summary.removed.length}`));
    for (const model of summary.removed.slice(0, 20)) {
      console.log(chalk.red(`    - ${model}`));
    }
  }
  const counts = Object.entries(summary.statusCounts).filter(([, count]) => count > 0);
  if (counts.length) {
    console.log(`  status        ${counts.map(([status, count]) => `${status}=${count}`).join("  ")}`);
  }
  if (summary.contextResolved.length) {
    console.log(`  context       resolved ${summary.contextResolved.length}`);
    for (const entry of summary.contextResolved.slice(0, 20)) {
      console.log(`    ${entry.model}: ${entry.tokens.toLocaleString()} tokens`);
    }
  }
  if (summary.contextUnresolved) {
    console.log(chalk.dim(`  context       unresolved ${summary.contextUnresolved} (provider reported no limit)`));
  }
}

function printCatalog(catalog: ModelCatalog, includeRemoved: boolean) {
  const providers = Object.values(catalog.providers);
  if (providers.length === 0) {
    console.log("No catalog yet. Run: arivu models sync");
    return;
  }
  for (const provider of providers) {
    console.log(chalk.bold(provider.baseUrl));
    console.log(
      chalk.dim(`  last sync: ${provider.lastFullSyncAt ?? "never"}   last active sweep: ${provider.lastActiveSweepAt ?? "never"}`)
    );
    const entries = Object.values(provider.models)
      .filter((model) => includeRemoved || !model.removedAt)
      .sort((left, right) => (right.context?.tokens ?? 0) - (left.context?.tokens ?? 0) || left.id.localeCompare(right.id));
    for (const model of entries) {
      const context = model.context ? `${model.context.tokens.toLocaleString().padStart(9)} tokens` : `${"unknown".padStart(9)}       `;
      // Pad before colouring: ANSI escapes count toward String.padEnd's length but not visible width.
      const label = (model.removedAt ? "removed" : model.status).padEnd(13);
      const status = model.removedAt ? chalk.red(label) : colorStatus(model.status, label);
      console.log(`  ${context}  ${status}  ${model.id}`);
    }
    console.log(chalk.dim(`  ${entries.length} models`));
  }
}

function colorStatus(status: string, label = status) {
  if (status === "available") {
    return chalk.green(label);
  }
  if (status === "not_entitled") {
    return chalk.dim(label);
  }
  if (status === "error") {
    return chalk.red(label);
  }
  return chalk.yellow(label);
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
    chalk.dim(`Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail, ${report.summary.skip} skip`)
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

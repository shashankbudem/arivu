#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import { Agent } from "./agent/Agent.js";
import { chatContentToText } from "./agent/content.js";
import type { AgentSession } from "./agent/types.js";
import { OpenAICompatibleChatClient } from "./agent/OpenAICompatibleChatClient.js";
import { loadConfig, saveConfig, type AppConfig, type ConfigKey } from "./config.js";
import { runDoctor, type DoctorReport, type DoctorStatus } from "./diagnostics/doctor.js";
import { ApprovalManager } from "./permissions/ApprovalManager.js";
import { SessionStore } from "./sessions/SessionStore.js";
import { TuiApp } from "./tui/TuiApp.js";

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
  .action(async (options: SessionsOptions) => {
    const store = new SessionStore();
    const sessions = await store.list();
    const visible = sessions.slice(0, options.limit);
    if (visible.length === 0) {
      console.log(chalk.dim("No saved sessions."));
      return;
    }

    console.log(["ID", "UPDATED", "WORKSPACE", "TITLE"].join("\t"));
    for (const session of visible) {
      console.log([session.id, formatCliDate(session.updatedAt), session.projectRoot ?? session.cwd, sessionTitle(session)].join("\t"));
    }
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
      if (key) {
        if (!isConfigKey(key)) {
          throw new Error(`Unknown config key: ${key}`);
        }
        console.log(JSON.stringify({ [key]: config[key] ?? null }, null, 2));
        return;
      }
      console.log(JSON.stringify(config, null, 2));
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
  const client = new OpenAICompatibleChatClient(config);
  const approvals = new ApprovalManager(config.trustMode);
  const agent = new Agent({
    client,
    approvals,
    cwd,
    model: config.model,
    baseUrl: config.baseUrl,
    tavilyApiKey: config.tavilyApiKey,
    mcpServers: config.mcpServers
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
  return ["apiKey", "tavilyApiKey", "baseUrl", "model", "trustMode"].includes(key);
}

function sessionTitle(session: AgentSession) {
  const content = session.messages.find((message) => message.role === "user")?.content;
  return content ? chatContentToText(content).trim().split(/\s+/).slice(0, 12).join(" ") || "Untitled session" : "Untitled session";
}

function formatCliDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseLimit(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("Limit must be a positive integer.");
  }
  return parsed;
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

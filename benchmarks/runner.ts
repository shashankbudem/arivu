#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import { discoverScenarios } from "./lib/manifest.js";
import { runCodingScenario, type RunnerOptions } from "./lib/codingRunner.js";
import { printResultTable, writeResult, writeSuiteSummary } from "./lib/results.js";
import type { BenchmarkResult, Scenario } from "./lib/types.js";

/**
 * Benchmark runner (see BENCHMARKS.md). Scenarios accumulate from real dev/test sessions:
 *   npm run bench -- list
 *   npm run bench -- run coding-fix-failing-test
 *   npm run bench -- run all --live
 */

const program = new Command();

program.name("bench").description("Run arivu benchmarks captured from dev/test sessions.");

program
  .command("list")
  .description("List discovered scenarios.")
  .action(async () => {
    const scenarios = await discoverScenarios();
    if (scenarios.length === 0) {
      console.log("No scenarios found under benchmarks/scenarios/.");
      return;
    }
    for (const scenario of scenarios) {
      const live = scenario.manifest.browser?.target === "live" ? chalk.yellow(" [live]") : "";
      console.log(`${chalk.bold(scenario.manifest.id.padEnd(28))} ${scenario.manifest.kind.padEnd(8)}${live} ${scenario.manifest.title}`);
    }
  });

program
  .command("run")
  .description("Run one or more scenarios (or 'all').")
  .argument("<ids...>", "scenario ids, or 'all'")
  .option("--live", "include live-site scenarios (skipped by default)")
  .option("--manual", "browser scenarios: pause for a human-driven app run instead of the automated entry")
  .option("--verify-only", "browser scenarios: skip setup (baseline capture) and the app run; just verify")
  .option("--reset", "browser scenarios: run the scenario's reset command after verification")
  .option("--built", "run the built dist/cli.js instead of tsx src/cli.ts")
  .option("--keep", "keep temp workspaces and data homes even on pass")
  .option("--json", "print the suite summary as JSON instead of a table")
  .option("--model <model>", "override the model (defaults to your configured model)")
  .option("--base-url <url>", "override the provider base URL")
  .action(async (ids: string[], flags: RunFlags) => {
    const scenarios = await discoverScenarios();
    const selected = selectScenarios(scenarios, ids);
    const startedAt = new Date().toISOString();
    const results: BenchmarkResult[] = [];

    for (const scenario of selected) {
      console.log(chalk.bold(`\n▶ ${scenario.manifest.id}`) + chalk.dim(` — ${scenario.manifest.title}`));
      const result = await runScenario(scenario, flags);
      results.push(result);
      await writeResult(result);
    }

    const summaryPath = await writeSuiteSummary(results, startedAt);
    if (flags.json) {
      console.log(JSON.stringify({ startedAt, results }, null, 2));
    } else {
      printResultTable(results);
      console.log(chalk.dim(`Summary written to ${summaryPath}`));
    }
    if (results.some((result) => result.outcome === "fail" || result.outcome === "error" || result.outcome === "timeout")) {
      process.exitCode = 1;
    }
  });

type RunFlags = {
  live?: boolean;
  manual?: boolean;
  verifyOnly?: boolean;
  reset?: boolean;
  built?: boolean;
  keep?: boolean;
  json?: boolean;
  model?: string;
  baseUrl?: string;
};

function selectScenarios(scenarios: Scenario[], ids: string[]): Scenario[] {
  if (ids.length === 1 && ids[0] === "all") {
    return scenarios;
  }
  const byId = new Map(scenarios.map((scenario) => [scenario.manifest.id, scenario]));
  return ids.map((id) => {
    const scenario = byId.get(id);
    if (!scenario) {
      throw new Error(`Unknown scenario "${id}". Run: npm run bench -- list`);
    }
    return scenario;
  });
}

async function runScenario(scenario: Scenario, flags: RunFlags): Promise<BenchmarkResult> {
  const runnerOptions: RunnerOptions = {
    built: flags.built,
    keep: flags.keep,
    model: flags.model,
    baseUrl: flags.baseUrl
  };

  if (scenario.manifest.kind === "coding") {
    return runCodingScenario(scenario, runnerOptions);
  }

  const { runBrowserScenario } = await import("./lib/browserRunner.js");
  return runBrowserScenario(scenario, {
    ...runnerOptions,
    live: flags.live === true,
    manual: flags.manual === true,
    verifyOnly: flags.verifyOnly === true,
    reset: flags.reset === true
  });
}

program
  .command("new")
  .description("Scaffold a scenario from the capture template.")
  .argument("<id>", "kebab-case scenario id")
  .requiredOption("--kind <kind>", "coding | browser")
  .action(async (id: string, options: { kind: string }) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`Scenario id must be kebab-case, got "${id}".`);
    }
    if (options.kind !== "coding" && options.kind !== "browser") {
      throw new Error(`--kind must be coding or browser, got "${options.kind}".`);
    }
    const { cp, readFile, writeFile, access } = await import("node:fs/promises");
    const path = await import("node:path");
    const { benchmarksRoot, scenariosRoot } = await import("./lib/manifest.js");
    const target = path.join(scenariosRoot, id);
    try {
      await access(target);
      throw new Error(`Scenario "${id}" already exists at ${target}.`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) {
        throw error;
      }
    }
    await cp(path.join(benchmarksRoot, "_template", options.kind), target, { recursive: true });
    for (const name of ["scenario.json", "README.md"]) {
      const file = path.join(target, name);
      const content = await readFile(file, "utf8");
      await writeFile(file, content.replaceAll("__ID__", id).replaceAll("__DATE__", new Date().toISOString().slice(0, 10)), "utf8");
    }
    console.log(`Scaffolded ${target}`);
    console.log(`\nCapture checklist:`);
    console.log(`  1. Paste the exact prompt from your dev session into scenario.json "task".`);
    if (options.kind === "coding") {
      console.log(`  2. Snapshot the starting repo state into fixture-repo/ (zero-dep fixtures run fastest).`);
      console.log(`  3. Encode success as verify checks; validate with: npm run bench -- run ${id}`);
    } else {
      console.log(`  2. Point setup/verify/reset at a Python verifier in benchmarks/browser/ (REST > DOM scraping).`);
      console.log(`  3. Create ${id}.scenario.local.json with credentials; validate with: npm run bench -- run ${id} --live`);
    }
    console.log(`  4. Delete the checklist from README.md and commit the scenario directory.`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});

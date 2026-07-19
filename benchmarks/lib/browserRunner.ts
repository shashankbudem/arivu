import path from "node:path";
import readline from "node:readline/promises";
import { readFile, rm } from "node:fs/promises";
import chalk from "chalk";
import { execa } from "execa";
import { fileExists, repoRoot } from "./manifest.js";
import { runElectronBenchTask } from "./electronRunner.js";
import { scoreOutcome } from "./results.js";
import { applySessionMetrics, readIsolatedSession } from "./sessionMetrics.js";
import { runVerifiers } from "./verifiers.js";
import type { RunnerOptions } from "./codingRunner.js";
import type { BenchmarkResult, Scenario } from "./types.js";
import type { CmdSchema } from "./types.js";
import type { z } from "zod";

export type BrowserRunnerOptions = RunnerOptions & {
  live: boolean;
  manual: boolean;
  verifyOnly: boolean;
  reset: boolean;
};

/**
 * Live browser scenario flow: setup (baseline capture) → execute (automated Electron bench entry,
 * or a human-driven app run with --manual) → verify (Python tool contract) → optional reset.
 */
export async function runBrowserScenario(scenario: Scenario, options: BrowserRunnerOptions): Promise<BenchmarkResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const manifest = scenario.manifest;
  const browser = manifest.browser!;

  const result: BenchmarkResult = {
    schemaVersion: 1,
    scenarioId: manifest.id,
    kind: "browser",
    startedAt,
    finishedAt: startedAt,
    runMode: options.manual || browser.execution === "manual" ? "manual" : "electron",
    outcome: "error",
    score: 0,
    assertions: [],
    metrics: { wallMs: 0 }
  };

  const finish = (): BenchmarkResult => {
    result.metrics.wallMs = Date.now() - started;
    result.finishedAt = new Date().toISOString();
    return result;
  };

  if (!options.live) {
    result.outcome = "skipped";
    result.error = "live scenario — include it with --live";
    return finish();
  }
  // {{key}} tokens in the task resolve from the git-ignored local file, so committed manifests can
  // reference instance URLs and record names without hardcoding anyone's environment.
  let task = manifest.task;
  if (browser.live.requiresLocalFile) {
    const localFile = path.resolve(scenario.dir, browser.live.requiresLocalFile);
    if (!(await fileExists(localFile))) {
      result.outcome = "skipped";
      result.error = `missing ${browser.live.requiresLocalFile} — see the scenario README for setup`;
      return finish();
    }
    try {
      const localValues = JSON.parse(await readFile(localFile, "utf8")) as Record<string, unknown>;
      task = task.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (token, key: string) => {
        const value = localValues[key];
        return typeof value === "string" || typeof value === "number" ? String(value) : token;
      });
    } catch (error) {
      result.outcome = "error";
      result.error = `unreadable ${browser.live.requiresLocalFile}: ${error instanceof Error ? error.message : String(error)}`;
      return finish();
    }
  }

  try {
    if (browser.live.setup && !options.verifyOnly) {
      await runCmd(browser.live.setup, scenario.dir, "setup");
    }

    let electronDataHome: string | undefined;
    if (!options.verifyOnly) {
      if (result.runMode === "manual") {
        await promptManualRun(task);
      } else {
        const run = await runElectronBenchTask({ task, taskOptions: browser.taskOptions }, manifest.bounds.timeoutMs, {
          model: options.model,
          baseUrl: options.baseUrl
        });
        electronDataHome = run.dataHome;
        result.metrics.exitCode = run.exitCode;
        result.stdoutTail = run.stdoutTail;
        if (run.timedOut) {
          result.outcome = "timeout";
          result.error = `app run exceeded bounds.timeoutMs (${manifest.bounds.timeoutMs}ms)`;
          return finish();
        }
        if (!run.outcome) {
          result.outcome = "error";
          result.error = `bench entry exited ${run.exitCode} without writing a result — is the desktop build current?`;
          return finish();
        }
        applySessionMetrics(result, await readIsolatedSession(run.dataHome));
        // Verification decides pass/fail; the app's own success flag only annotates errors.
        if (!run.outcome.success) {
          result.error = run.outcome.error ?? `app reported failure (stopReason: ${run.outcome.stopReason ?? "unknown"})`;
        }
      }
    }

    const verified = await runVerifiers(manifest.verify, {
      workspaceDir: scenario.dir,
      scenarioDir: scenario.dir,
      repoRoot
    });
    result.assertions = verified.assertions;
    if (verified.errored) {
      result.outcome = "error";
      result.error = verified.errorDetail;
    } else {
      const scored = scoreOutcome(verified.assertions, manifest.scoring.passThreshold);
      result.score = scored.score;
      result.outcome = scored.outcome;
    }

    if (options.reset && browser.live.reset) {
      if (!browser.live.confirmReset || (await confirm(`Run reset for ${manifest.id}?`))) {
        await runCmd(browser.live.reset, scenario.dir, "reset");
      } else {
        console.log(chalk.yellow("Reset declined — live state left as-is."));
      }
    }

    if (electronDataHome && result.outcome === "pass" && !options.keep) {
      await rm(electronDataHome, { recursive: true, force: true }).catch(() => undefined);
    } else if (electronDataHome) {
      result.stdoutTail = [result.stdoutTail, `bench data kept: ${electronDataHome}`].filter(Boolean).join("\n");
    }
  } catch (error) {
    result.outcome = "error";
    result.error = error instanceof Error ? error.message : String(error);
  }

  return finish();
}

async function runCmd(cmd: z.infer<typeof CmdSchema>, scenarioDir: string, label: string): Promise<void> {
  const cwd = cmd.cwd ? path.resolve(scenarioDir, cmd.cwd) : repoRoot;
  console.log(chalk.dim(`  ${label}: ${cmd.command} ${cmd.args.join(" ")}`));
  const result = await execa(cmd.command, cmd.args, { cwd, reject: false, stdio: "inherit", timeout: 600_000 });
  if (result.exitCode !== 0) {
    throw new Error(`${label} command exited ${result.exitCode}`);
  }
}

async function promptManualRun(task: string): Promise<void> {
  console.log(chalk.bold("\nPaste this prompt verbatim into an Arivu desktop browser task, run it, then press Enter:\n"));
  console.log(chalk.cyan(task));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("\nPress Enter when the run has finished (or Ctrl+C to abort)… ");
  rl.close();
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { loadConfig } from "../../src/config.js";
import { repoRoot } from "./manifest.js";
import { scoreOutcome } from "./results.js";
import { applySessionMetrics, readIsolatedSession } from "./sessionMetrics.js";
import { runVerifiers } from "./verifiers.js";
import type { BenchmarkResult, Scenario } from "./types.js";

export type RunnerOptions = {
  /** Run the built dist/cli.js instead of tsx src/cli.ts. */
  built?: boolean;
  /** Keep the temp workspace and data home (always kept on non-pass outcomes). */
  keep?: boolean;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
};

export async function runCodingScenario(scenario: Scenario, options: RunnerOptions): Promise<BenchmarkResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const manifest = scenario.manifest;

  const result: BenchmarkResult = {
    schemaVersion: 1,
    scenarioId: manifest.id,
    kind: "coding",
    startedAt,
    finishedAt: startedAt,
    runMode: "cli",
    outcome: "error",
    score: 0,
    assertions: [],
    metrics: { wallMs: 0 }
  };

  // Model identity comes from the user's real config unless overridden — the child is env-isolated,
  // so the credentials must be handed to it explicitly.
  const config = await loadConfig();
  const model = options.model ?? config.model;
  const baseUrl = options.baseUrl ?? config.baseUrl;
  const apiKey = options.apiKey ?? config.apiKey ?? "";
  result.model = model;
  result.baseUrl = baseUrl;

  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), `arivu-bench-${manifest.id}-ws-`));
  const dataHome = await mkdtemp(path.join(os.tmpdir(), `arivu-bench-${manifest.id}-data-`));

  let keepDirs = options.keep === true;
  try {
    await cp(path.join(scenario.dir, manifest.workspace!.fixture), workspaceDir, { recursive: true });
    await git(workspaceDir, ["init", "-q"]);
    await git(workspaceDir, ["add", "-A"]);
    await git(workspaceDir, ["-c", "user.email=bench@arivu", "-c", "user.name=bench", "commit", "-qm", "baseline", "--allow-empty"]);
    for (const command of manifest.workspace!.setup) {
      await execa(command, { shell: true, cwd: workspaceDir, timeout: 300_000 });
    }

    const child = await spawnArivu(manifest.task, workspaceDir, dataHome, { model, baseUrl, apiKey }, manifest.bounds.timeoutMs, options);
    result.metrics.exitCode = child.exitCode;
    result.stdoutTail = tail(child.stdout, 800);

    applySessionMetrics(result, await readIsolatedSession(dataHome));
    result.metrics.diff = await diffShortstat(workspaceDir);

    if (child.timedOut) {
      result.outcome = "timeout";
      result.error = `run exceeded bounds.timeoutMs (${manifest.bounds.timeoutMs}ms)`;
    } else if (child.exitCode !== 0) {
      result.outcome = "error";
      result.error = tail(child.stderr || child.stdout, 400) || `arivu exited ${child.exitCode}`;
    } else {
      const verified = await runVerifiers(manifest.verify, { workspaceDir, scenarioDir: scenario.dir, repoRoot });
      result.assertions = verified.assertions;
      if (verified.errored) {
        result.outcome = "error";
        result.error = verified.errorDetail;
      } else {
        const scored = scoreOutcome(verified.assertions, manifest.scoring.passThreshold);
        result.score = scored.score;
        result.outcome = scored.outcome;
      }
    }
  } catch (error) {
    result.outcome = "error";
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    result.metrics.wallMs = Date.now() - started;
    result.finishedAt = new Date().toISOString();
    keepDirs = keepDirs || result.outcome !== "pass";
    if (keepDirs) {
      result.stdoutTail = [result.stdoutTail, `workspace kept: ${workspaceDir}`].filter(Boolean).join("\n");
    } else {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(dataHome, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return result;
}

async function spawnArivu(
  task: string,
  workspaceDir: string,
  dataHome: string,
  provider: { model?: string; baseUrl?: string; apiKey: string },
  timeoutMs: number,
  options: RunnerOptions
) {
  // Mirrors the execArivu isolation in tests/cli.test.ts: private data/config homes, legacy
  // SHANKINSTER_* fallbacks neutralized (src/config.ts appEnv falls back to them when ARIVU_* is
  // empty — so point them at the same isolated locations rather than blanking them).
  const env = {
    ...process.env,
    ARIVU_DATA_HOME: dataHome,
    SHANKINSTER_DATA_HOME: dataHome,
    ARIVU_CONFIG_HOME: path.join(dataHome, "config"),
    SHANKINSTER_CONFIG_HOME: path.join(dataHome, "config"),
    ARIVU_API_KEY: provider.apiKey,
    SHANKINSTER_API_KEY: provider.apiKey,
    ARIVU_BASE_URL: provider.baseUrl ?? "",
    SHANKINSTER_BASE_URL: provider.baseUrl ?? "",
    ARIVU_MODEL: provider.model ?? "",
    SHANKINSTER_MODEL: provider.model ?? "",
    ARIVU_TRUST_MODE: "trusted",
    SHANKINSTER_TRUST_MODE: "trusted",
    NO_COLOR: "1"
  };

  const [command, args] = options.built
    ? [process.execPath, [path.join(repoRoot, "dist", "cli.js"), task, "--trust", "trusted"]]
    : [
        path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx"),
        [path.join(repoRoot, "src", "cli.ts"), task, "--trust", "trusted"]
      ];

  const result = await execa(command, args, {
    cwd: workspaceDir,
    env,
    reject: false,
    timeout: timeoutMs,
    forceKillAfterDelay: 10_000
  });
  return {
    exitCode: result.exitCode ?? -1,
    timedOut: result.timedOut === true,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? "")
  };
}

async function diffShortstat(workspaceDir: string): Promise<BenchmarkResult["metrics"]["diff"]> {
  try {
    await git(workspaceDir, ["add", "-A"]);
    const { stdout } = await execa("git", ["diff", "HEAD", "--shortstat"], { cwd: workspaceDir });
    const text = String(stdout);
    const files = Number(/(\d+) files? changed/.exec(text)?.[1] ?? 0);
    const insertions = Number(/(\d+) insertions?\(\+\)/.exec(text)?.[1] ?? 0);
    const deletions = Number(/(\d+) deletions?\(-\)/.exec(text)?.[1] ?? 0);
    return { files, insertions, deletions };
  } catch {
    return undefined;
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execa("git", args, { cwd });
}

function tail(text: string, maxChars: number): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`;
}

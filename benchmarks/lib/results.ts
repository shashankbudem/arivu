import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { resultsRoot } from "./manifest.js";
import type { BenchmarkResult } from "./types.js";

/** History layout: results/<scenario>/<ISO-ts>-<model-slug>.json (git-ignored — results are
 *  model/machine/time specific; curated snapshots can be committed by hand if ever wanted). */
export async function writeResult(result: BenchmarkResult): Promise<string> {
  const dir = path.join(resultsRoot, result.scenarioId);
  await mkdir(dir, { recursive: true });
  const stamp = result.startedAt.replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${modelSlug(result.model)}.json`);
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return file;
}

export async function writeSuiteSummary(results: BenchmarkResult[], startedAt: string): Promise<string> {
  await mkdir(resultsRoot, { recursive: true });
  const file = path.join(resultsRoot, `summary-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, `${JSON.stringify({ startedAt, results }, null, 2)}\n`, "utf8");
  return file;
}

export function printResultTable(results: BenchmarkResult[]): void {
  console.log("");
  console.log(chalk.bold(["SCENARIO".padEnd(28), "OUTCOME".padEnd(9), "SCORE".padEnd(7), "TIME".padEnd(8), "MODEL"].join(" ")));
  for (const result of results) {
    const outcome = colorOutcome(result.outcome);
    const score = `${Math.round(result.score * 100)}%`.padEnd(7);
    const time = formatMs(result.metrics.wallMs).padEnd(8);
    console.log([result.scenarioId.padEnd(28), outcome, score, time, result.model ?? "-"].join(" "));
    for (const assertion of result.assertions.filter((entry) => !entry.passed)) {
      console.log(chalk.red(`  ✗ ${assertion.label}${assertion.detail ? ` — ${assertion.detail}` : ""}`));
    }
    if (result.error) {
      console.log(chalk.red(`  ! ${result.error}`));
    }
  }
  console.log("");
}

function colorOutcome(outcome: BenchmarkResult["outcome"]): string {
  const padded = outcome.padEnd(9);
  switch (outcome) {
    case "pass":
      return chalk.green(padded);
    case "skipped":
      return chalk.dim(padded);
    case "fail":
      return chalk.red(padded);
    default:
      return chalk.yellow(padded);
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  return seconds < 90 ? `${seconds.toFixed(1)}s` : `${(seconds / 60).toFixed(1)}m`;
}

function modelSlug(model?: string): string {
  return (
    (model ?? "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "unknown"
  );
}

export function scoreOutcome(
  assertions: BenchmarkResult["assertions"],
  passThreshold: number
): { score: number; outcome: "pass" | "fail" } {
  const score = assertions.length === 0 ? 0 : assertions.filter((entry) => entry.passed).length / assertions.length;
  return { score, outcome: score >= passThreshold && assertions.length > 0 ? "pass" : "fail" };
}

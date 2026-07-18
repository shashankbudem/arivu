import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { loadConfig } from "../../src/config.js";
import { repoRoot } from "./manifest.js";

/**
 * Drives the app's headless bench entry: spawns the built Electron main with ARIVU_BENCH_TASK
 * pointing at a task file, fully env-isolated (private data/config homes seeded with the user's
 * provider + browserTaskModel config). Isolation guarantees exactly one session in the child's
 * data home, giving deterministic taskRuns metrics with no session matching.
 */

export type ElectronBenchTask = {
  task: string;
  taskOptions?: {
    maxSteps?: number;
    allowedDomains?: string[];
    allowJavaScript?: boolean;
    allowSensitiveActions?: boolean;
    mode?: "visible" | "background";
  };
};

export type ElectronBenchOutcome = {
  success: boolean;
  output?: string;
  stopReason?: string;
  error?: string;
};

export type ElectronBenchRun = {
  outcome?: ElectronBenchOutcome;
  exitCode: number;
  timedOut: boolean;
  stdoutTail: string;
  dataHome: string;
};

export async function runElectronBenchTask(
  bench: ElectronBenchTask,
  timeoutMs: number,
  overrides: { model?: string; baseUrl?: string } = {}
): Promise<ElectronBenchRun> {
  const mainJs = path.join(repoRoot, "dist-desktop", "main", "main.js");
  try {
    await access(mainJs);
  } catch {
    throw new Error(`dist-desktop/main/main.js is missing — run "npm run desktop:build" first.`);
  }

  const dataHome = await mkdtemp(path.join(os.tmpdir(), "arivu-bench-electron-"));
  const configHome = path.join(dataHome, "config");
  await mkdir(configHome, { recursive: true });

  // Seed the child with the user's real provider + browserTaskModel config; overrides let a
  // benchmark pin a specific main-agent model without touching the user's config.
  const config = await loadConfig();
  const seeded = {
    ...config,
    model: overrides.model ?? config.model,
    baseUrl: overrides.baseUrl ?? config.baseUrl,
    trustMode: "trusted"
  };
  await writeFile(path.join(configHome, "config.json"), `${JSON.stringify(seeded, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const taskFile = path.join(dataHome, "bench-task.json");
  const resultFile = path.join(dataHome, "bench-result.json");
  await writeFile(taskFile, `${JSON.stringify(bench, null, 2)}\n`, "utf8");

  const electronBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  const child = await execa(electronBin, [mainJs], {
    env: {
      ...process.env,
      ARIVU_DATA_HOME: dataHome,
      SHANKINSTER_DATA_HOME: dataHome,
      ARIVU_CONFIG_HOME: configHome,
      SHANKINSTER_CONFIG_HOME: configHome,
      ARIVU_BENCH_TASK: taskFile,
      ARIVU_BENCH_RESULT: resultFile
    },
    reject: false,
    timeout: timeoutMs,
    forceKillAfterDelay: 15_000
  });

  let outcome: ElectronBenchOutcome | undefined;
  try {
    outcome = JSON.parse(await readFile(resultFile, "utf8")) as ElectronBenchOutcome;
  } catch {
    // Child died before writing its result — the caller reports the exit code / timeout instead.
  }

  const stdout = String(child.stdout ?? "");
  return {
    outcome,
    exitCode: child.exitCode ?? -1,
    timedOut: child.timedOut === true,
    stdoutTail: stdout.length > 1200 ? `…${stdout.slice(-1200)}` : stdout,
    dataHome
  };
}

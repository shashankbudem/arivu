import { readFile, writeFile } from "node:fs/promises";
import { appEnv } from "../../src/config.js";
import type { DesktopController } from "./desktopController.js";

/**
 * Headless benchmark entry (see BENCHMARKS.md). Gated on ARIVU_BENCH_TASK like the smoke modes:
 * reads {task, taskOptions} from the task file, runs it through the real desktop prompt path with
 * browser tools attached, writes the outcome to ARIVU_BENCH_RESULT, and exits 0/1.
 */
export async function runDesktopBenchmark(taskFile: string, controller: DesktopController): Promise<number> {
  const resultFile = appEnv("BENCH_RESULT");
  const writeOutcome = async (outcome: Record<string, unknown>) => {
    if (resultFile) {
      await writeFile(resultFile, `${JSON.stringify(outcome, null, 2)}\n`, "utf8").catch(() => undefined);
    }
  };
  try {
    const spec = JSON.parse(await readFile(taskFile, "utf8")) as { task?: string; taskOptions?: Record<string, unknown> };
    if (!spec.task || typeof spec.task !== "string") {
      throw new Error(`Task file ${taskFile} has no "task" string.`);
    }
    const prompt =
      spec.taskOptions && Object.keys(spec.taskOptions).length > 0
        ? `${spec.task}\n\nWhen you delegate to the browser_task tool, pass these options: ${JSON.stringify(spec.taskOptions)}`
        : spec.task;
    console.log(`bench: starting task (${prompt.length} chars)`);
    const outcome = await controller.runBenchPrompt(prompt);
    console.log(`bench: finished success=${outcome.success} stopReason=${outcome.stopReason ?? "-"} session=${outcome.sessionId}`);
    await writeOutcome(outcome);
    return outcome.success ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`bench: failed — ${message}`);
    await writeOutcome({ success: false, error: message });
    return 1;
  }
}

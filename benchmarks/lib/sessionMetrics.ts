import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { BenchmarkResult } from "./types.js";

/**
 * Extracts run metrics from a saved session JSON. Parsed structurally (not via SessionStore's
 * schema) so the harness tolerates sessions written by older/newer app builds — missing pieces
 * degrade to omitted metrics, never to a failed benchmark.
 */

type LooseMessage = {
  role?: string;
  content?: unknown;
  toolCalls?: Array<{ name?: string }>;
};

type LooseSession = {
  id?: string;
  model?: string;
  baseUrl?: string;
  messages?: LooseMessage[];
  taskRuns?: Array<{
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; requestCount?: number };
    artifacts?: Array<{ browserTask?: { stepCount?: number; stopReason?: string; navigationCount?: number; tokensUsed?: number } }>;
  }>;
};

export type SessionMetrics = {
  sessionId?: string;
  sessionPath: string;
  model?: string;
  baseUrl?: string;
  messageCount: number;
  assistantTurns: number;
  toolCallCount: number;
  toolErrorCount: number;
  usage?: NonNullable<BenchmarkResult["metrics"]["usage"]>;
  browserTask?: NonNullable<BenchmarkResult["metrics"]["browserTask"]>;
};

/** Finds the single session under an isolated data home. Returns undefined when the run died before
 *  the save (e.g. timeout kills — runOneShot saves only after the agent resolves). */
export async function readIsolatedSession(dataHome: string): Promise<SessionMetrics | undefined> {
  const sessionsDir = path.join(dataHome, "sessions");
  let files: string[];
  try {
    files = (await readdir(sessionsDir)).filter((name) => name.endsWith(".json") && !name.endsWith(".bak"));
  } catch {
    return undefined;
  }
  if (files.length === 0) {
    return undefined;
  }
  // Isolation should guarantee exactly one; if the app ever writes more, take the newest by name mtime order.
  const sessionPath = path.join(sessionsDir, files.sort().at(-1)!);
  return readSessionMetrics(sessionPath);
}

export async function readSessionMetrics(sessionPath: string): Promise<SessionMetrics | undefined> {
  let session: LooseSession;
  try {
    session = JSON.parse(await readFile(sessionPath, "utf8")) as LooseSession;
  } catch {
    return undefined;
  }
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const toolErrorCount = messages.filter(
    (message) => message.role === "tool" && typeof message.content === "string" && message.content.startsWith("Error:")
  ).length;

  const usageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requestCount: 0 };
  let sawUsage = false;
  let browserTask: SessionMetrics["browserTask"];
  for (const run of session.taskRuns ?? []) {
    if (run.usage) {
      sawUsage = true;
      usageTotals.promptTokens += run.usage.promptTokens ?? 0;
      usageTotals.completionTokens += run.usage.completionTokens ?? 0;
      usageTotals.totalTokens += run.usage.totalTokens ?? 0;
      usageTotals.requestCount += run.usage.requestCount ?? 0;
    }
    for (const artifact of run.artifacts ?? []) {
      if (artifact.browserTask && typeof artifact.browserTask.stepCount === "number") {
        browserTask = {
          stepCount: artifact.browserTask.stepCount,
          stopReason: artifact.browserTask.stopReason,
          navigationCount: artifact.browserTask.navigationCount,
          tokensUsed: artifact.browserTask.tokensUsed
        };
      }
    }
  }

  return {
    sessionId: session.id,
    sessionPath,
    model: session.model,
    baseUrl: session.baseUrl,
    messageCount: messages.length,
    assistantTurns: messages.filter((message) => message.role === "assistant").length,
    toolCallCount: messages.reduce((total, message) => total + (message.toolCalls?.length ?? 0), 0),
    toolErrorCount,
    usage: sawUsage ? usageTotals : undefined,
    browserTask
  };
}

export function applySessionMetrics(result: BenchmarkResult, metrics: SessionMetrics | undefined): void {
  if (!metrics) {
    return;
  }
  result.sessionId = metrics.sessionId;
  result.sessionPath = metrics.sessionPath;
  result.model = result.model ?? metrics.model;
  result.baseUrl = result.baseUrl ?? metrics.baseUrl;
  result.metrics.messageCount = metrics.messageCount;
  result.metrics.assistantTurns = metrics.assistantTurns;
  result.metrics.toolCallCount = metrics.toolCallCount;
  result.metrics.toolErrorCount = metrics.toolErrorCount;
  result.metrics.usage = metrics.usage;
  result.metrics.browserTask = metrics.browserTask;
}

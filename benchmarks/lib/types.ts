import { z } from "zod";

/**
 * Scenario manifest + result shapes for the benchmark harness (see BENCHMARKS.md).
 *
 * Scenarios are captured from real dev/test sessions, so the manifest optimizes for cheap authoring:
 * one JSON file, the exact prompt that was handed to the app, and declarative verification. The
 * command verifier's report contract deliberately matches the existing Python tool
 * (benchmarks/browser/linkedin_profile_benchmark.py): exit 0 = pass, 1 = mismatch, 2 = setup error,
 * report JSON {passed, fields:[{section, field, expected, actual, passed}]}.
 */

export const CmdSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional()
});

const WorkspaceCheckSchema = z.discriminatedUnion("check", [
  z.object({
    check: z.literal("command"),
    /** Run with shell semantics in the workspace; the assertion passes when the exit code matches. */
    command: z.string().min(1),
    expectExitCode: z.number().int().default(0),
    label: z.string().min(1)
  }),
  z.object({ check: z.literal("fileContains"), path: z.string().min(1), text: z.string().min(1), label: z.string().min(1) }),
  z.object({
    check: z.literal("fileEquals"),
    path: z.string().min(1),
    /** Baseline file, relative to the scenario dir. Guards e.g. "the agent must not edit the tests". */
    file: z.string().min(1),
    label: z.string().min(1)
  }),
  z.object({ check: z.literal("fileAbsent"), path: z.string().min(1), label: z.string().min(1) })
]);

export const VerifierSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workspace"), checks: z.array(WorkspaceCheckSchema).min(1) }),
  z.object({
    type: z.literal("command"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Relative to the scenario dir unless absolute; defaults to the repo root. */
    cwd: z.string().optional(),
    /** If set and the file matches the Python tool's report shape, fields become per-assertion partial credit. */
    reportPath: z.string().optional(),
    label: z.string().min(1)
  })
]);

export const ScenarioManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id must be kebab-case"),
  title: z.string().min(1),
  kind: z.enum(["coding", "browser"]),
  /** The exact prompt handed to the app — verbatim from the dev session that spawned the scenario. */
  task: z.string().min(1),
  /** Provenance: which dev/test session this was captured from, and anything a future runner should know. */
  notes: z.string().optional(),
  bounds: z.object({ timeoutMs: z.number().int().min(10_000).max(14_400_000) }),
  workspace: z
    .object({
      /** Directory inside the scenario dir copied into a temp workspace for the run. */
      fixture: z.string().min(1),
      /** Shell commands run inside the workspace before the agent starts. */
      setup: z.array(z.string()).default([])
    })
    .optional(),
  browser: z
    .object({
      target: z.enum(["live"]),
      execution: z.enum(["auto", "manual"]).default("auto"),
      live: z
        .object({
          /** Typically the Python tool's capture-baseline. Skipped with --verify-only. */
          setup: CmdSchema.optional(),
          /** Typically the Python tool's reset --yes. Only run with --reset. */
          reset: CmdSchema.optional(),
          /** Require an interactive confirmation before reset runs even with --reset. */
          confirmReset: z.boolean().default(false),
          /** Scenario is skipped (not failed) when this file is missing — credentials live outside git. */
          requiresLocalFile: z.string().optional()
        })
        .default({}),
      taskOptions: z
        .object({
          maxSteps: z.number().int().min(1).max(200).optional(),
          allowedDomains: z.array(z.string()).optional(),
          allowJavaScript: z.boolean().optional(),
          allowSensitiveActions: z.boolean().optional(),
          mode: z.enum(["visible", "background"]).optional()
        })
        .default({})
    })
    .optional(),
  verify: z.array(VerifierSpecSchema).min(1),
  scoring: z.object({ passThreshold: z.number().min(0).max(1).default(1) }).default({ passThreshold: 1 })
});

export type ScenarioManifest = z.infer<typeof ScenarioManifestSchema>;
export type VerifierSpec = z.infer<typeof VerifierSpecSchema>;
export type WorkspaceCheck = z.infer<typeof WorkspaceCheckSchema>;

export type Scenario = { manifest: ScenarioManifest; dir: string };

export type AssertionResult = {
  label: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  detail?: string;
};

export type BenchmarkOutcome = "pass" | "fail" | "error" | "timeout" | "skipped";

export type BenchmarkResult = {
  schemaVersion: 1;
  scenarioId: string;
  kind: "coding" | "browser";
  startedAt: string;
  finishedAt: string;
  model?: string;
  baseUrl?: string;
  runMode: "cli" | "electron" | "manual";
  outcome: BenchmarkOutcome;
  /** passed/total assertions; 0 when none ran. Outcome is pass when score >= scoring.passThreshold. */
  score: number;
  assertions: AssertionResult[];
  metrics: {
    wallMs: number;
    exitCode?: number;
    messageCount?: number;
    assistantTurns?: number;
    toolCallCount?: number;
    toolErrorCount?: number;
    diff?: { files: number; insertions: number; deletions: number };
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number; requestCount: number };
    browserTask?: { stepCount: number; stopReason?: string; navigationCount?: number; tokensUsed?: number };
  };
  sessionId?: string;
  sessionPath?: string;
  stdoutTail?: string;
  error?: string;
};

/** Report shape produced by benchmarks/browser/*_benchmark.py `verify` — parsed for partial credit. */
export const PythonVerifierReportSchema = z.object({
  passed: z.boolean(),
  fields: z
    .array(
      z.object({
        section: z.string().optional(),
        field: z.string(),
        expected: z.unknown().optional(),
        actual: z.unknown().optional(),
        passed: z.boolean()
      })
    )
    .default([])
});

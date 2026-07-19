import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { PythonVerifierReportSchema, type AssertionResult, type VerifierSpec, type WorkspaceCheck } from "./types.js";

export type VerifierContext = {
  /** Temp workspace for coding scenarios; scenario dir for browser scenarios. */
  workspaceDir: string;
  scenarioDir: string;
  repoRoot: string;
};

export type VerifyRunResult = {
  assertions: AssertionResult[];
  /** True when a verifier itself broke (exit 2, unreadable report) — outcome becomes "error", not "fail". */
  errored: boolean;
  errorDetail?: string;
};

export async function runVerifiers(specs: VerifierSpec[], context: VerifierContext): Promise<VerifyRunResult> {
  const assertions: AssertionResult[] = [];
  let errored = false;
  let errorDetail: string | undefined;

  for (const spec of specs) {
    if (spec.type === "workspace") {
      for (const check of spec.checks) {
        assertions.push(await runWorkspaceCheck(check, context));
      }
      continue;
    }

    const outcome = await runCommandVerifier(spec, context);
    assertions.push(...outcome.assertions);
    if (outcome.errored) {
      errored = true;
      errorDetail = errorDetail ?? outcome.errorDetail;
    }
  }

  return { assertions, errored, errorDetail };
}

async function runWorkspaceCheck(check: WorkspaceCheck, context: VerifierContext): Promise<AssertionResult> {
  switch (check.check) {
    case "command": {
      const result = await execa(check.command, { shell: true, cwd: context.workspaceDir, reject: false, timeout: 120_000 });
      const exitCode = result.exitCode ?? -1;
      return {
        label: check.label,
        passed: exitCode === check.expectExitCode,
        expected: `exit ${check.expectExitCode}`,
        actual: `exit ${exitCode}`,
        detail: exitCode === check.expectExitCode ? undefined : tail(String(result.stderr || result.stdout || ""), 300)
      };
    }
    case "fileContains": {
      const content = await readFileOrUndefined(path.join(context.workspaceDir, check.path));
      return {
        label: check.label,
        passed: content !== undefined && content.includes(check.text),
        expected: `contains ${JSON.stringify(check.text)}`,
        actual: content === undefined ? "file missing" : "file present",
        detail: content !== undefined && !content.includes(check.text) ? "text not found" : undefined
      };
    }
    case "fileEquals": {
      const actual = await readFileOrUndefined(path.join(context.workspaceDir, check.path));
      const baseline = await readFileOrUndefined(path.join(context.scenarioDir, check.file));
      if (baseline === undefined) {
        return { label: check.label, passed: false, detail: `baseline ${check.file} missing in scenario dir` };
      }
      return {
        label: check.label,
        passed: actual === baseline,
        detail: actual === undefined ? "file missing" : actual === baseline ? undefined : "content differs from baseline"
      };
    }
    case "fileAbsent": {
      const exists = await pathExists(path.join(context.workspaceDir, check.path));
      return { label: check.label, passed: !exists, detail: exists ? "file unexpectedly present" : undefined };
    }
  }
}

/**
 * Runs an external verifier honoring the Python tool contract: exit 0 pass / 1 mismatch / 2 broken,
 * optional report JSON with per-field results for partial credit. Without a parsable report the
 * whole command collapses to a single assertion on its exit code.
 */
async function runCommandVerifier(spec: Extract<VerifierSpec, { type: "command" }>, context: VerifierContext): Promise<VerifyRunResult> {
  const cwd = spec.cwd ? path.resolve(context.scenarioDir, spec.cwd) : context.repoRoot;
  const result = await execa(spec.command, spec.args, { cwd, reject: false, timeout: 600_000 });
  const exitCode = result.exitCode ?? -1;

  if (exitCode === 2) {
    return {
      assertions: [{ label: spec.label, passed: false, detail: tail(String(result.stderr || result.stdout || ""), 300) }],
      errored: true,
      errorDetail: `verifier "${spec.label}" exited 2 (broken setup)`
    };
  }

  if (spec.reportPath) {
    const reportFile = path.isAbsolute(spec.reportPath) ? spec.reportPath : path.resolve(context.repoRoot, spec.reportPath);
    const raw = await readFileOrUndefined(reportFile);
    if (raw !== undefined) {
      try {
        const report = PythonVerifierReportSchema.parse(JSON.parse(raw));
        if (report.fields.length > 0) {
          return {
            assertions: report.fields.map((field) => ({
              label: [field.section, field.field].filter(Boolean).join("."),
              passed: field.passed,
              expected: field.expected,
              actual: field.actual
            })),
            errored: false
          };
        }
      } catch (error) {
        return {
          assertions: [{ label: spec.label, passed: false, detail: "unparsable verifier report" }],
          errored: true,
          errorDetail: `verifier report ${spec.reportPath}: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }
  }

  return {
    assertions: [
      {
        label: spec.label,
        passed: exitCode === 0,
        expected: "exit 0",
        actual: `exit ${exitCode}`,
        detail: exitCode === 0 ? undefined : tail(String(result.stderr || result.stdout || ""), 300)
      }
    ],
    errored: false
  };
}

async function readFileOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function tail(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`;
}

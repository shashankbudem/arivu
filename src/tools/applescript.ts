/**
 * Pure argv builders and validators for the `applescript` tool. Keeping these free of I/O,
 * approvals, and process spawning (all of which live in the registry) makes each supported
 * operation directly unit-testable without macOS scripting binaries installed.
 *
 * `run` and `run_file` execute through `osascript`; `compile` produces a compiled script via
 * `osacompile`. Trailing arguments after the script are delivered to the script's `on run argv`
 * handler (or `function run(argv)` for JXA).
 */

export type AppleScriptOperation = "run" | "run_file" | "compile";

export const APPLESCRIPT_OPERATIONS: readonly AppleScriptOperation[] = ["run", "run_file", "compile"] as const;

export type AppleScriptLanguage = "applescript" | "javascript";

export const APPLESCRIPT_LANGUAGES: readonly AppleScriptLanguage[] = ["applescript", "javascript"] as const;

export const APPLESCRIPT_DEFAULT_TIMEOUT_MS = 60_000;
export const APPLESCRIPT_MIN_TIMEOUT_MS = 1_000;
export const APPLESCRIPT_MAX_TIMEOUT_MS = 600_000;
export const APPLESCRIPT_MAX_OUTPUT_CHARS = 30_000;

/** Script files osascript can execute: plain-text sources and compiled scripts. */
export const APPLESCRIPT_RUNNABLE_EXTENSIONS = [".applescript", ".scpt", ".scptd", ".js"] as const;

/** Outputs osacompile can produce. */
export const APPLESCRIPT_COMPILED_EXTENSIONS = [".scpt", ".scptd", ".app"] as const;

export type AppleScriptBuildParams = {
  /** Inline script source for run and compile. */
  source?: string;
  /** Resolved, workspace-safe absolute path to a script file (already validated by the caller). */
  file?: string;
  /** Resolved, workspace-safe absolute path for the compiled output (already validated by the caller). */
  output?: string;
  /** Script language. Defaults to AppleScript for inline source; omitted for files so osascript infers it. */
  language?: AppleScriptLanguage;
  /** Arguments delivered to the script's run handler. */
  scriptArgs?: string[];
};

export type AppleScriptPlan = {
  bin: "osascript" | "osacompile";
  argv: string[];
  /** True when the plan produces the file at `output`, so the caller checkpoints and gates it. */
  writesOutput: boolean;
};

export type AppleScriptRisk = "low" | "medium" | "high";

export type AppleScriptSourceAnalysis = {
  risk: AppleScriptRisk;
  destructive: boolean;
  summary: string;
  reasons: string[];
};

const LANGUAGE_NAMES: Record<AppleScriptLanguage, string> = {
  applescript: "AppleScript",
  javascript: "JavaScript"
};

export function buildAppleScriptPlan(operation: AppleScriptOperation, params: AppleScriptBuildParams): AppleScriptPlan {
  const scriptArgs = params.scriptArgs ?? [];
  switch (operation) {
    case "run": {
      const source = requireParam("source", params.source);
      const language = params.language ?? "applescript";
      return {
        bin: "osascript",
        argv: ["-l", LANGUAGE_NAMES[language], "-e", source, ...scriptArgs],
        writesOutput: false
      };
    }
    case "run_file": {
      const file = requireParam("file", params.file);
      assertExtension("file", file, APPLESCRIPT_RUNNABLE_EXTENSIONS);
      // Only force a language when the caller asked for one; compiled scripts and .applescript
      // sources carry their own language and osascript infers it from the file.
      const argv = params.language ? ["-l", LANGUAGE_NAMES[params.language]] : [];
      argv.push(file, ...scriptArgs);
      return { bin: "osascript", argv, writesOutput: false };
    }
    case "compile": {
      const output = requireParam("output", params.output);
      assertExtension("output", output, APPLESCRIPT_COMPILED_EXTENSIONS);
      if (params.source !== undefined && params.file !== undefined) {
        throw new Error("Provide either source or file for compile, not both.");
      }
      const argv: string[] = [];
      if (params.source !== undefined) {
        const language = params.language ?? "applescript";
        argv.push("-l", LANGUAGE_NAMES[language], "-o", output, "-e", requireParam("source", params.source));
      } else {
        const file = requireParam("source or file", params.file);
        if (params.language) {
          argv.push("-l", LANGUAGE_NAMES[params.language]);
        }
        argv.push("-o", output, file);
      }
      return { bin: "osacompile", argv, writesOutput: true };
    }
  }
}

/** True for plain-text script sources whose content the caller can read and audit. */
export function isPlainTextAppleScriptFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".applescript") || lower.endsWith(".js");
}

const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /do\s+shell\s+script/i, reason: "runs shell commands via `do shell script`" },
  { pattern: /administrator\s+privileges/i, reason: "requests administrator privileges" },
  { pattern: /\b(?:keystroke|key\s+code)\b/i, reason: "sends synthetic keyboard input" },
  { pattern: /\bdelete\b/i, reason: "deletes items" },
  { pattern: /empty(?:\s+the)?\s+trash/i, reason: "empties the Trash" },
  { pattern: /\b(?:restart|shut\s+down|log\s*out)\b/i, reason: "controls system power or the login session" },
  { pattern: /\berase\b/i, reason: "erases data" }
];

/**
 * Risk heuristic for script execution. Every executed script is treated as destructive because
 * AppleScript drives applications and OS state outside the workspace sandbox; known-dangerous
 * constructs escalate the risk so the approval layer can prompt more loudly. Pass `undefined`
 * for compiled scripts whose source cannot be read.
 */
export function analyzeAppleScriptSource(source: string | undefined): AppleScriptSourceAnalysis {
  if (source === undefined) {
    return {
      risk: "high",
      destructive: true,
      summary: "Compiled script; source cannot be reviewed before execution.",
      reasons: ["compiled script; source cannot be reviewed"]
    };
  }
  const reasons = HIGH_RISK_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(({ reason }) => reason);
  if (reasons.length > 0) {
    return {
      risk: "high",
      destructive: true,
      summary: `Script ${reasons.join("; ")}.`,
      reasons
    };
  }
  return {
    risk: "medium",
    destructive: true,
    summary: "Script automates applications and OS state outside the workspace.",
    reasons: ["automates applications outside the workspace"]
  };
}

export function maxAppleScriptRisk(left: AppleScriptRisk, right: AppleScriptRisk): AppleScriptRisk {
  const order: Record<AppleScriptRisk, number> = { low: 0, medium: 1, high: 2 };
  return order[left] >= order[right] ? left : right;
}

function requireParam(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required for this applescript operation.`);
  }
  return value;
}

function assertExtension(name: string, value: string, allowed: readonly string[]) {
  const lower = value.toLowerCase();
  if (!allowed.some((extension) => lower.endsWith(extension))) {
    throw new Error(`Invalid ${name} "${value}"; expected one of: ${allowed.join(", ")}.`);
  }
}

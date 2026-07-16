import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";
import {
  analyzeAppleScriptSource,
  buildAppleScriptPlan,
  isPlainTextAppleScriptFile,
  maxAppleScriptRisk
} from "../src/tools/applescript.js";
import { createToolRegistry } from "../src/tools/registry.js";

const SOURCE = 'display notification "hi"';
const FILE = "/ws/script.applescript";
const OUT = "/ws/script.scpt";

describe("buildAppleScriptPlan", () => {
  it("builds a run plan defaulting to AppleScript", () => {
    const plan = buildAppleScriptPlan("run", { source: SOURCE });
    expect(plan.bin).toBe("osascript");
    expect(plan.writesOutput).toBe(false);
    expect(plan.argv).toEqual(["-l", "AppleScript", "-e", SOURCE]);
  });

  it("builds a run plan for JXA with script args", () => {
    const plan = buildAppleScriptPlan("run", { source: "function run(argv) { return argv[0] }", language: "javascript", scriptArgs: ["a", "b"] });
    expect(plan.argv.slice(0, 2)).toEqual(["-l", "JavaScript"]);
    expect(plan.argv.slice(-2)).toEqual(["a", "b"]);
  });

  it("builds a run_file plan without forcing a language", () => {
    const plan = buildAppleScriptPlan("run_file", { file: "/ws/compiled.scpt", scriptArgs: ["x"] });
    expect(plan.bin).toBe("osascript");
    expect(plan.argv).toEqual(["/ws/compiled.scpt", "x"]);
  });

  it("builds a run_file plan with an explicit language", () => {
    const plan = buildAppleScriptPlan("run_file", { file: "/ws/script.js", language: "javascript" });
    expect(plan.argv).toEqual(["-l", "JavaScript", "/ws/script.js"]);
  });

  it("rejects a run_file plan for an unsupported extension", () => {
    expect(() => buildAppleScriptPlan("run_file", { file: "/ws/script.sh" })).toThrow(/Invalid file/);
  });

  it("builds a compile plan from inline source", () => {
    const plan = buildAppleScriptPlan("compile", { source: SOURCE, output: OUT });
    expect(plan.bin).toBe("osacompile");
    expect(plan.writesOutput).toBe(true);
    expect(plan.argv).toEqual(["-l", "AppleScript", "-o", OUT, "-e", SOURCE]);
  });

  it("builds a compile plan from a script file", () => {
    const plan = buildAppleScriptPlan("compile", { file: FILE, output: OUT });
    expect(plan.argv).toEqual(["-o", OUT, FILE]);
  });

  it("rejects a compile with both source and file, or neither", () => {
    expect(() => buildAppleScriptPlan("compile", { source: SOURCE, file: FILE, output: OUT })).toThrow(/not both/);
    expect(() => buildAppleScriptPlan("compile", { output: OUT })).toThrow(/source or file is required/);
  });

  it("rejects a compile output with an unsupported extension", () => {
    expect(() => buildAppleScriptPlan("compile", { source: SOURCE, output: "/ws/out.txt" })).toThrow(/Invalid output/);
  });

  it("requires source and output where the operation needs them", () => {
    expect(() => buildAppleScriptPlan("run", {})).toThrow(/source is required/);
    expect(() => buildAppleScriptPlan("run_file", {})).toThrow(/file is required/);
    expect(() => buildAppleScriptPlan("compile", { source: SOURCE })).toThrow(/output is required/);
  });
});

describe("analyzeAppleScriptSource", () => {
  it("treats benign scripts as medium-risk but still destructive", () => {
    const analysis = analyzeAppleScriptSource(SOURCE);
    expect(analysis.risk).toBe("medium");
    expect(analysis.destructive).toBe(true);
  });

  it("escalates dangerous constructs to high risk with reasons", () => {
    for (const [source, reason] of [
      ['do shell script "rm -rf ~"', /shell commands/],
      ['tell application "System Events" to keystroke "hello"', /keyboard input/],
      ['tell application "Finder" to delete file "x"', /deletes items/],
      ['tell application "Finder" to empty the trash', /Trash/],
      ["with administrator privileges", /administrator/]
    ] as const) {
      const analysis = analyzeAppleScriptSource(source);
      expect(analysis.risk).toBe("high");
      expect(analysis.reasons.join("; ")).toMatch(reason);
    }
  });

  it("flags unreadable compiled scripts as high risk", () => {
    const analysis = analyzeAppleScriptSource(undefined);
    expect(analysis.risk).toBe("high");
    expect(analysis.summary).toMatch(/cannot be reviewed/);
  });

  it("orders risks and detects plain-text script files", () => {
    expect(maxAppleScriptRisk("medium", "high")).toBe("high");
    expect(maxAppleScriptRisk("high", "low")).toBe("high");
    expect(maxAppleScriptRisk("low", "medium")).toBe("medium");
    expect(isPlainTextAppleScriptFile("/ws/a.applescript")).toBe(true);
    expect(isPlainTextAppleScriptFile("/ws/a.js")).toBe(true);
    expect(isPlainTextAppleScriptFile("/ws/a.scpt")).toBe(false);
  });
});

describe("applescript tool registration and guards", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-applescript-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function registry() {
    return createToolRegistry({
      workspaceRoot: tempDir,
      approvals: new ApprovalManager("trusted", async () => true)
    });
  }

  it("registers the applescript tool", () => {
    expect(registry().schemas.map((schema) => schema.name)).toContain("applescript");
  });

  it.runIf(process.platform === "darwin")("reports a missing script file before spawning anything", async () => {
    await expect(registry().execute("applescript", { operation: "run_file", file: "missing.applescript" })).resolves.toMatch(
      /Script not found/
    );
  });

  it.runIf(process.platform === "darwin")("keeps script paths inside the workspace", async () => {
    await expect(
      registry().execute("applescript", { operation: "run_file", file: "../escape.applescript" })
    ).resolves.toMatch(/escapes workspace/);
  });

  it.runIf(process.platform === "darwin")("refuses to overwrite an existing compile output unless overwrite is set", async () => {
    await writeFile(path.join(tempDir, "out.scpt"), "x", "utf8");
    await expect(
      registry().execute("applescript", { operation: "compile", source: SOURCE, output: "out.scpt" })
    ).resolves.toMatch(/already exists/);
  });

  it.runIf(process.platform !== "darwin")("reports that macOS is required on other platforms", async () => {
    await expect(registry().execute("applescript", { operation: "run", source: SOURCE })).resolves.toMatch(/requires macOS/);
  });

  it.runIf(process.platform === "darwin")("runs an inline script and returns its result with script args", async () => {
    const output = await registry().execute("applescript", {
      operation: "run",
      source: ['on run argv', 'return "hello " & item 1 of argv', "end run"].join("\n"),
      args: ["world"]
    });
    expect(output).toMatch(/status: success/);
    expect(output).toMatch(/hello world/);
  });

  it.runIf(process.platform === "darwin")("compiles a script file and runs the compiled output", async () => {
    await writeFile(path.join(tempDir, "greet.applescript"), 'return "compiled greeting"', "utf8");
    const compileOutput = await registry().execute("applescript", {
      operation: "compile",
      file: "greet.applescript",
      output: "greet.scpt"
    });
    expect(compileOutput).toMatch(/status: success/);
    const runOutput = await registry().execute("applescript", { operation: "run_file", file: "greet.scpt" });
    expect(runOutput).toMatch(/compiled greeting/);
  });
});

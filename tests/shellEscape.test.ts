import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatShellCommandDisplay,
  parseShellEscape,
  resolveShellInvocation,
  runShellCommand,
  sanitizeTerminalText,
  TerminalTextSanitizer
} from "../src/tui/shellEscape.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describe("TUI shell escape parsing", () => {
  it("recognizes both compact and spaced bang commands without touching other prompts", () => {
    expect(parseShellEscape("!printf ok")).toEqual({ command: "printf ok" });
    expect(parseShellEscape("! printf ok")).toEqual({ command: "printf ok" });
    expect(parseShellEscape("!   ")).toEqual({ command: "" });
    expect(parseShellEscape("please run !printf ok")).toBeUndefined();
  });

  it("passes the exact shell program as one final argument", () => {
    const command = "printf '%s' \"$HOME\" && echo done";
    const invocation = resolveShellInvocation(command, { SHELL: "/bin/zsh" });

    expect(invocation).toEqual({ file: "/bin/zsh", args: ["-l", "-c", command] });
  });
});

describe("terminal text sanitization", () => {
  it("removes control sequences across chunks while preserving readable output", () => {
    const sanitizer = new TerminalTextSanitizer();

    expect(sanitizer.write("\u001b[3")).toBe("");
    expect(sanitizer.write("1mcyan\u001b]0;unsafe title")).toBe("cyan");
    expect(sanitizer.write("\u0007done\rnext\u001b[0m")).toBe("done\nnext");
    expect(sanitizer.end()).toBe("");
    expect(sanitizeTerminalText("a\u001b]2;title\u001b\\b\u0000c")).toBe("abc");
  });

  it("formats multiline shell programs into bounded one-line UI labels", () => {
    expect(formatShellCommandDisplay("  printf\tone\n\u001b[31mprintf two\u001b[0m  ")).toBe("printf one ↵ printf two");
    expect(formatShellCommandDisplay("abcdefghijk", 8)).toBe("abcdefg…");
  });
});

describePosix("TUI shell command runner", () => {
  it("streams stdout and stderr, retains nonzero status, and uses the supplied cwd", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "arivu-tui-shell-"));
    const resolvedCwd = await realpath(cwd);
    const output: string[] = [];
    try {
      const result = await runShellCommand(
        nodeCommand("process.stdout.write(process.cwd()); process.stderr.write(' warning'); process.exitCode = 7;"),
        {
          cwd,
          onOutput: (event) => output.push(`${event.stream}:${event.delta}`)
        }
      );

      expect(result.exitCode).toBe(7);
      expect(result.signal).toBeNull();
      expect(result.aborted).toBe(false);
      expect(result.output).toContain(`stdout:\n${resolvedCwd}`);
      expect(result.output).toContain("stderr:\n warning");
      expect(output.join("")).toContain(resolvedCwd);
      expect(output.join("")).toContain("warning");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("cancels the shell process group after deterministic first output", async () => {
    const controller = new AbortController();
    const result = await runShellCommand(nodeCommand("process.stdout.write('ready\\n'); setInterval(() => {}, 1_000);"), {
      cwd: process.cwd(),
      signal: controller.signal,
      onOutput: ({ delta }) => {
        if (delta.includes("ready")) {
          controller.abort();
        }
      }
    });

    expect(result.aborted).toBe(true);
    expect(result.output).toContain("ready");
  });

  it("bounds retained output while preserving a recent tail marker", async () => {
    const result = await runShellCommand(nodeCommand("process.stdout.write('x'.repeat(70_000));"), {
      cwd: process.cwd()
    });

    expect(result.exitCode).toBe(0);
    expect(result.outputTruncated).toBe(true);
    expect(result.output).toContain("output truncated; recent output follows");
    expect(result.output.length).toBeLessThanOrEqual(64_200);
  });
});

function nodeCommand(source: string) {
  return `${shellQuote(process.execPath)} -e ${shellQuote(source)}`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

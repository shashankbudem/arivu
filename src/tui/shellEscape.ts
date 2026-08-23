import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type ShellOutputStream = "stdout" | "stderr";

export type ShellOutputEvent = {
  stream: ShellOutputStream;
  delta: string;
};

export type ShellCommandResult = {
  command: string;
  output: string;
  outputTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  aborted: boolean;
};

export type ShellCommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onOutput?: (event: ShellOutputEvent) => void;
};

export type ShellCommandRunner = (command: string, options: ShellCommandOptions) => Promise<ShellCommandResult>;

export type ShellInvocation = {
  file: string;
  args: string[];
};

const MAX_RETAINED_OUTPUT_CHARS = 64_000;
const HEAD_OUTPUT_CHARS = 24_000;
const TAIL_OUTPUT_CHARS = MAX_RETAINED_OUTPUT_CHARS - HEAD_OUTPUT_CHARS;
const MAX_LIVE_OUTPUT_CHARS = 64_000;
const TERMINATE_GRACE_MS = 1_000;
export const MAX_SHELL_COMMAND_DISPLAY_CHARS = 160;

/**
 * Recognizes the intentionally terse terminal escape syntax. The command is
 * returned without its leading marker, ready to be passed as one shell arg.
 */
export function parseShellEscape(value: string): { command: string } | undefined {
  if (!value.startsWith("!")) {
    return undefined;
  }
  return { command: value.slice(1).trim() };
}

/**
 * Produces a safe, one-line representation for the native terminal. Execution
 * always receives the original command; this only prevents multiline input or
 * control bytes from reshaping the TUI's status, live output, or scrollback.
 */
export function formatShellCommandDisplay(command: string, maximum = MAX_SHELL_COMMAND_DISPLAY_CHARS) {
  const compact = sanitizeTerminalText(command).replaceAll("\t", " ").replaceAll("\n", " ↵ ").replace(/\s+/gu, " ").trim();
  const limit = Number.isFinite(maximum) ? Math.max(1, Math.floor(maximum)) : MAX_SHELL_COMMAND_DISPLAY_CHARS;
  if (compact.length <= limit) {
    return compact;
  }
  return `${takePrefix(compact, Math.max(0, limit - 1))}…`;
}

/**
 * Resolves the user's configured interactive shell without ever re-parsing the
 * command string. The final argument is always the exact program text the user
 * entered after `!`.
 */
export function resolveShellInvocation(command: string, environment: NodeJS.ProcessEnv = process.env): ShellInvocation {
  const configuredShell = environment.SHELL?.trim();
  if (configuredShell) {
    return { file: configuredShell, args: ["-l", "-c", command] };
  }
  if (process.platform === "win32") {
    return { file: environment.ComSpec?.trim() || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  // Do not assume a login flag exists on a minimal POSIX fallback shell.
  return { file: "/bin/sh", args: ["-c", command] };
}

/**
 * Runs an explicit TUI shell escape in its own process group on POSIX. Output
 * is streamed as it arrives and a bounded head/tail transcript is returned for
 * the permanent terminal scrollback.
 */
export const runShellCommand: ShellCommandRunner = async (command, options) => {
  if (options.signal?.aborted) {
    return {
      command,
      output: "",
      outputTruncated: false,
      exitCode: null,
      signal: null,
      elapsedMs: 0,
      aborted: true
    };
  }

  const invocation = resolveShellInvocation(command, options.env);
  const startedAt = performance.now();
  const capture = new BoundedOutputCapture();
  let liveOutputChars = 0;
  let liveOutputCapped = false;
  let aborted = false;
  let child: ChildProcess;

  try {
    child = spawn(invocation.file, invocation.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
  } catch (error) {
    throw shellSpawnError(invocation.file, error);
  }

  return new Promise<ShellCommandResult>((resolve, reject) => {
    let settled = false;
    let forceTerminateTimer: NodeJS.Timeout | undefined;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const stdoutSanitizer = new TerminalTextSanitizer();
    const stderrSanitizer = new TerminalTextSanitizer();

    const emit = (stream: ShellOutputStream, delta: string) => {
      if (!delta) {
        return;
      }
      capture.append(stream, delta);
      if (liveOutputCapped || !options.onOutput) {
        return;
      }
      const remaining = MAX_LIVE_OUTPUT_CHARS - liveOutputChars;
      if (remaining <= 0) {
        liveOutputCapped = true;
        options.onOutput({
          stream,
          delta: "\n… [live output capped; final result keeps recent output] …\n"
        });
        return;
      }
      const visible = takePrefix(delta, remaining);
      liveOutputChars += visible.length;
      options.onOutput({ stream, delta: visible });
      if (visible.length < delta.length) {
        liveOutputCapped = true;
        options.onOutput({
          stream,
          delta: "\n… [live output capped; final result keeps recent output] …\n"
        });
      }
    };

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      terminateProcessTree(child, "SIGTERM");
      forceTerminateTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), TERMINATE_GRACE_MS);
      forceTerminateTimer.unref();
    };

    const onAbort = () => {
      aborted = true;
      terminate();
    };

    const cleanup = () => {
      if (forceTerminateTimer) {
        clearTimeout(forceTerminateTimer);
      }
      options.signal?.removeEventListener("abort", onAbort);
    };

    const settleError = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(shellSpawnError(invocation.file, error));
    };

    child.stdout?.on("data", (chunk: Buffer | string) => emit("stdout", stdoutSanitizer.write(decodeChunk(stdoutDecoder, chunk))));
    child.stderr?.on("data", (chunk: Buffer | string) => emit("stderr", stderrSanitizer.write(decodeChunk(stderrDecoder, chunk))));
    child.once("error", settleError);
    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      emit("stdout", stdoutSanitizer.write(stdoutDecoder.end()) + stdoutSanitizer.end());
      emit("stderr", stderrSanitizer.write(stderrDecoder.end()) + stderrSanitizer.end());
      cleanup();
      resolve({
        command,
        output: capture.format(),
        outputTruncated: capture.truncated,
        exitCode,
        signal,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        aborted: aborted || Boolean(options.signal?.aborted)
      });
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
  });
};

class BoundedOutputCapture {
  private readonly head = new OutputSegments();
  private readonly tail = new OutputSegments();
  truncated = false;

  append(stream: ShellOutputStream, delta: string) {
    const headRemaining = HEAD_OUTPUT_CHARS - this.head.length;
    if (headRemaining > 0) {
      const visible = takePrefix(delta, headRemaining);
      this.head.append(stream, visible);
      delta = delta.slice(visible.length);
    }
    if (!delta) {
      return;
    }
    this.truncated = true;
    this.tail.append(stream, delta);
    this.tail.trimTo(TAIL_OUTPUT_CHARS);
  }

  format() {
    return formatShellOutput(this.head.entries, this.truncated ? this.tail.entries : [], this.truncated);
  }
}

class OutputSegments {
  readonly entries: ShellOutputEvent[] = [];
  length = 0;

  append(stream: ShellOutputStream, delta: string) {
    if (!delta) {
      return;
    }
    const last = this.entries.at(-1);
    if (last?.stream === stream) {
      last.delta += delta;
    } else {
      this.entries.push({ stream, delta });
    }
    this.length += delta.length;
  }

  trimTo(limit: number) {
    while (this.length > limit && this.entries.length > 0) {
      const first = this.entries[0]!;
      const excess = this.length - limit;
      if (first.delta.length <= excess) {
        this.length -= first.delta.length;
        this.entries.shift();
      } else {
        const remainder = takeSuffix(first.delta, first.delta.length - excess);
        this.length -= first.delta.length - remainder.length;
        first.delta = remainder;
      }
    }
  }
}

function formatShellOutput(head: ShellOutputEvent[], tail: ShellOutputEvent[], truncated: boolean) {
  let text = "";
  let previousStream: ShellOutputStream | undefined;
  const append = (entries: ShellOutputEvent[]) => {
    for (const entry of entries) {
      if (entry.stream !== previousStream) {
        if (text && !text.endsWith("\n")) {
          text += "\n";
        }
        text += `${entry.stream}:\n`;
        previousStream = entry.stream;
      }
      text += entry.delta;
    }
  };

  append(head);
  if (truncated) {
    if (text && !text.endsWith("\n")) {
      text += "\n";
    }
    text += "… [output truncated; recent output follows] …\n";
    previousStream = undefined;
  }
  append(tail);
  return text.trimEnd();
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if (!isMissingProcessError(error)) {
        // The shell may already have exited. Its direct child is still worth a
        // best-effort signal below.
      }
    }
  } else {
    try {
      const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      taskkill.unref();
      return;
    } catch {
      // Fall through to Node's direct-child signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the status check and the signal.
  }
}

function isMissingProcessError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function shellSpawnError(shell: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Unable to start shell ${shell}: ${message}`);
}

function takePrefix(value: string, maximum: number) {
  if (value.length <= maximum) {
    return value;
  }
  let end = Math.max(0, maximum);
  if (end > 0 && isHighSurrogate(value.charCodeAt(end - 1)) && isLowSurrogate(value.charCodeAt(end))) {
    end -= 1;
  }
  return value.slice(0, end);
}

function takeSuffix(value: string, maximum: number) {
  if (value.length <= maximum) {
    return value;
  }
  let start = Math.max(0, value.length - maximum);
  if (start < value.length && isLowSurrogate(value.charCodeAt(start)) && isHighSurrogate(value.charCodeAt(start - 1))) {
    start += 1;
  }
  return value.slice(start);
}

function isHighSurrogate(value: number) {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number) {
  return value >= 0xdc00 && value <= 0xdfff;
}

/**
 * Neutralizes terminal control data before it crosses the JSON protocol into a
 * Ratatui buffer. This is deliberately stateful: a CSI or OSC sequence may be
 * split across arbitrary stdout/stderr chunks.
 */
export class TerminalTextSanitizer {
  private state: "text" | "escape" | "csi" | "string" | "string_escape" = "text";

  write(value: string) {
    let safe = "";
    for (const character of value) {
      switch (this.state) {
        case "text":
          if (character === "\u001b") {
            this.state = "escape";
          } else if (character === "\r") {
            // A carriage return would otherwise overwrite a Ratatui line.
            safe += "\n";
          } else if (isSafeTerminalCharacter(character)) {
            safe += character;
          }
          break;
        case "escape":
          if (character === "[") {
            this.state = "csi";
          } else if (character === "]" || character === "P" || character === "^" || character === "_") {
            this.state = "string";
          } else {
            this.state = "text";
          }
          break;
        case "csi":
          if (isCsiFinal(character)) {
            this.state = "text";
          }
          break;
        case "string":
          if (character === "\u0007") {
            this.state = "text";
          } else if (character === "\u001b") {
            this.state = "string_escape";
          }
          break;
        case "string_escape":
          this.state = character === "\\" ? "text" : "string";
          break;
      }
    }
    return safe;
  }

  end() {
    // Incomplete control sequences deliberately disappear rather than being
    // rendered as raw escapes. There is no buffered visible text to flush.
    this.state = "text";
    return "";
  }
}

export function sanitizeTerminalText(value: string) {
  const sanitizer = new TerminalTextSanitizer();
  return sanitizer.write(value) + sanitizer.end();
}

function decodeChunk(decoder: StringDecoder, chunk: Buffer | string) {
  return decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
}

function isSafeTerminalCharacter(character: string) {
  if (character === "\n" || character === "\t") {
    return true;
  }
  const code = character.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
}

function isCsiFinal(character: string) {
  const code = character.codePointAt(0) ?? 0;
  return code >= 0x40 && code <= 0x7e;
}

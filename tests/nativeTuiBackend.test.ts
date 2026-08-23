import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { NativeTuiBackend } from "../src/tui/NativeTuiBackend.js";
import type { NativeClientEvent } from "../src/tui/nativeProtocol.js";

type BackendHarness = {
  handleNativeEvent(event: Exclude<NativeClientEvent, { type: "hello" }>): Promise<void>;
  runPrompt(value: string): Promise<void>;
  runShellEscape(command: string): Promise<void>;
  continueTurn(): Promise<void>;
  switchModel(model: string, operation?: unknown): Promise<void>;
  submit(value: string): Promise<void>;
  finishForegroundRun(): void;
  exit(): void;
};

type MutableBackendHarness = BackendHarness & Record<string, any>;

function backendHarness() {
  return new NativeTuiBackend({
    config: {} as AppConfig,
    cwd: "/tmp/arivu"
  }) as unknown as BackendHarness;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native TUI backend input dispatch", () => {
  it("releases the native event queue while a prompt is running", async () => {
    const backend = backendHarness();
    const run = deferred();
    backend.runPrompt = vi.fn(() => run.promise);

    let inputHandled = false;
    const handling = backend.handleNativeEvent({ type: "submit", value: "hello" }).then(() => {
      inputHandled = true;
    });

    await setImmediate();
    const releasedBeforeRunCompleted = inputHandled;
    run.resolve();
    await handling;

    expect(releasedBeforeRunCompleted).toBe(true);
    expect(backend.runPrompt).toHaveBeenCalledWith("hello");
  });

  it("releases the native event queue while /continue is running", async () => {
    const backend = backendHarness();
    const run = deferred();
    backend.continueTurn = vi.fn(() => run.promise);

    let inputHandled = false;
    const handling = backend.handleNativeEvent({ type: "submit", value: "/continue" }).then(() => {
      inputHandled = true;
    });

    await setImmediate();
    const releasedBeforeRunCompleted = inputHandled;
    run.resolve();
    await handling;

    expect(releasedBeforeRunCompleted).toBe(true);
    expect(backend.continueTurn).toHaveBeenCalledOnce();
  });

  it("switches a verified model only for the active session and recreates its agent", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const originalSession = {
      id: "session-1",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      model: "old-model",
      baseUrl: "https://provider.test/v1",
      contextCompaction: {
        version: 1,
        source: "deterministic",
        compactedAt: "2026-01-01T00:00:00.000Z",
        compactedMessageCount: 1,
        sourceNonSystemMessageCount: 2,
        messages: []
      },
      messages: [{ role: "user", content: "keep this transcript" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    backend.config = { model: "old-model", baseUrl: "https://provider.test/v1", providers: [] };
    backend.modelCatalog = { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", providers: {} };
    backend.currentSession = originalSession;
    backend.store = { save: vi.fn().mockResolvedValue(undefined) };
    backend.createAgent = vi.fn(() => ({ recreated: true }));
    backend.buildInitData = vi.fn(() => ({ model: "verified-model" }));
    backend.send = vi.fn();
    backend.setStatus = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "verified-model" }] }) }));

    await backend.switchModel("verified-model", backend.beginModelOperation("switch"));

    expect(backend.config.model).toBe("verified-model");
    expect(backend.config.baseUrl).toBe("https://provider.test/v1");
    expect(backend.currentSession.messages).toEqual(originalSession.messages);
    expect(backend.currentSession.contextCompaction).toEqual(originalSession.contextCompaction);
    expect(backend.currentSession.model).toBe("verified-model");
    expect(backend.store.save).toHaveBeenCalledWith(backend.currentSession);
    expect(backend.createAgent).toHaveBeenCalledWith(backend.currentSession);
    expect(backend.send).toHaveBeenCalledWith({ type: "reset", data: { model: "verified-model" } });
    expect(backend.setStatus).toHaveBeenCalledWith("Model switched to verified-model");
  });

  it("rejects a picker selection while a turn is active", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.busy = true;
    backend.switchModel = vi.fn();
    backend.setStatus = vi.fn();

    await backend.handleNativeEvent({ type: "select_model", id: "other-model" });

    expect(backend.switchModel).not.toHaveBeenCalled();
    expect(backend.setStatus).toHaveBeenCalledWith("Stop the active turn before switching models", true);
  });

  it("releases native input while discovery runs and cannot start a prompt on the old model", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const discovery = deferred<{ ok: boolean; json: () => Promise<{ data: Array<{ id: string }> }> }>();
    backend.config = { model: "old-model", baseUrl: "https://provider.test/v1", providers: [] };
    backend.modelCatalog = { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", providers: {} };
    backend.createAgent = vi.fn(() => ({ recreated: true }));
    backend.buildInitData = vi.fn(() => ({ model: "next-model" }));
    backend.store = { save: vi.fn().mockResolvedValue(undefined) };
    backend.send = vi.fn();
    backend.setStatus = vi.fn();
    backend.runPrompt = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => discovery.promise)
    );

    let switchInputReleased = false;
    const switching = backend.handleNativeEvent({ type: "submit", value: "/model next-model" }).then(() => {
      switchInputReleased = true;
    });
    await setImmediate();
    expect(switchInputReleased).toBe(true);

    await backend.handleNativeEvent({ type: "submit", value: "normal prompt" });
    expect(backend.runPrompt).not.toHaveBeenCalled();
    expect(backend.config.model).toBe("old-model");
    expect(backend.setStatus).toHaveBeenCalledWith("Model switch in progress — wait before sending a prompt");

    discovery.resolve({ ok: true, json: async () => ({ data: [{ id: "next-model" }] }) });
    await switching;
    await setImmediate();
    expect(backend.config.model).toBe("next-model");
  });

  it("does not open a late model picker after a prompt supersedes discovery", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const discovery = deferred<{ ok: boolean; json: () => Promise<{ data: Array<{ id: string }> }> }>();
    backend.config = { model: "old-model", baseUrl: "https://provider.test/v1", providers: [] };
    backend.modelCatalog = { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", providers: {} };
    backend.send = vi.fn();
    backend.setStatus = vi.fn();
    backend.runPrompt = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => discovery.promise)
    );

    await backend.handleNativeEvent({ type: "submit", value: "/model" });
    await setImmediate();
    await backend.handleNativeEvent({ type: "submit", value: "start work" });
    discovery.resolve({ ok: true, json: async () => ({ data: [{ id: "late-model" }] }) });
    await setImmediate();

    expect(backend.runPrompt).toHaveBeenCalledWith("start work");
    expect(backend.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "model_picker" }));
  });

  it("only publishes the latest model-picker discovery", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const first = deferred<{ ok: boolean; json: () => Promise<{ data: Array<{ id: string }> }> }>();
    const second = deferred<{ ok: boolean; json: () => Promise<{ data: Array<{ id: string }> }> }>();
    backend.config = { model: "old-model", baseUrl: "https://provider.test/v1", providers: [] };
    backend.modelCatalog = { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", providers: {} };
    backend.send = vi.fn();
    backend.setStatus = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));

    await backend.handleNativeEvent({ type: "submit", value: "/model" });
    await setImmediate();
    await backend.handleNativeEvent({ type: "submit", value: "/model" });
    await setImmediate();
    second.resolve({ ok: true, json: async () => ({ data: [{ id: "fresh-model" }] }) });
    await setImmediate();
    first.resolve({ ok: true, json: async () => ({ data: [{ id: "stale-model" }] }) });
    await setImmediate();

    expect(backend.send).toHaveBeenCalledTimes(1);
    expect(backend.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "model_picker", models: [expect.objectContaining({ id: "fresh-model" })] })
    );
  });

  it("does not publish a stale switch after a resume occurs during session persistence", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const saved = deferred<void>();
    const originalSession = {
      id: "original",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      model: "old-model",
      baseUrl: "https://provider.test/v1",
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    backend.config = { model: "old-model", baseUrl: "https://provider.test/v1", providers: [] };
    backend.currentSession = originalSession;
    backend.modelCatalog = { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", providers: {} };
    backend.store = { save: vi.fn(() => saved.promise) };
    backend.createAgent = vi.fn();
    backend.buildInitData = vi.fn(() => ({ model: "next-model" }));
    backend.send = vi.fn();
    backend.setStatus = vi.fn();
    backend.resumeSession = vi.fn(async () => {
      backend.currentSession = { ...originalSession, id: "resumed", model: "resumed-model" };
      backend.config = { ...backend.config, model: "resumed-model" };
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "next-model" }] }) }));

    await backend.handleNativeEvent({ type: "submit", value: "/model next-model" });
    await setImmediate();
    expect(backend.store.save).toHaveBeenCalledOnce();
    await backend.handleNativeEvent({ type: "resume_session", id: "resumed" });
    saved.resolve();
    await setImmediate();

    expect(backend.config.model).toBe("resumed-model");
    expect(backend.currentSession.id).toBe("resumed");
    expect(backend.createAgent).not.toHaveBeenCalled();
    expect(backend.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "reset" }));
  });

  it("does not publish a stale switch after quit occurs during session persistence", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const saved = deferred<void>();
    const session = {
      id: "session-1",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      model: "old-model",
      baseUrl: "https://provider.test/v1",
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    backend.config = { model: "old-model", baseUrl: "https://provider.test/v1", providers: [] };
    backend.currentSession = session;
    backend.modelCatalog = { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", providers: {} };
    backend.store = { save: vi.fn(() => saved.promise) };
    backend.createAgent = vi.fn();
    backend.buildInitData = vi.fn(() => ({ model: "next-model" }));
    backend.send = vi.fn();
    backend.setStatus = vi.fn();
    backend.resolveAllApprovals = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "next-model" }] }) }));

    await backend.handleNativeEvent({ type: "submit", value: "/model next-model" });
    await setImmediate();
    await backend.handleNativeEvent({ type: "quit" });
    saved.resolve();
    await setImmediate();

    expect(backend.config.model).toBe("old-model");
    expect(backend.createAgent).not.toHaveBeenCalled();
    expect(backend.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "reset" }));
  });
});

describe("native TUI shell escapes", () => {
  it("runs a bang command without invoking the model or writing session history", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.cwd = "/tmp/unchanged-cwd";
    backend.agent = { run: vi.fn() };
    backend.store = { save: vi.fn() };
    backend.send = vi.fn();
    backend.shellCommandRunner = vi.fn(async (_command: string, options: any) => {
      options.onOutput({ stream: "stdout", delta: "out" });
      options.onOutput({ stream: "stderr", delta: "err" });
      return {
        command: "printf out",
        output: "stdout:\nout\nstderr:\nerr",
        outputTruncated: false,
        exitCode: 7,
        signal: null,
        elapsedMs: 12,
        aborted: false
      };
    });

    await backend.submit("! printf out");
    await setImmediate();

    expect(backend.agent.run).not.toHaveBeenCalled();
    expect(backend.store.save).not.toHaveBeenCalled();
    expect(backend.cwd).toBe("/tmp/unchanged-cwd");
    expect(backend.shellCommandRunner).toHaveBeenCalledWith("printf out", expect.objectContaining({ cwd: "/tmp/unchanged-cwd" }));
    expect(backend.send).toHaveBeenCalledWith({ type: "shell_started", command: "printf out" });
    expect(backend.send).toHaveBeenCalledWith({ type: "shell_output", stream: "stdout", delta: "out" });
    expect(backend.send).toHaveBeenCalledWith({ type: "shell_output", stream: "stderr", delta: "err" });
    expect(backend.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "shell_completed",
        output: "stdout:\nout\nstderr:\nerr",
        exit_code: 7,
        elapsed_ms: 12
      })
    );
  });

  it("keeps a multiline command exact for the shell while emitting a compact display label", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const rawCommand = "printf first\n\tprintf second";
    backend.send = vi.fn();
    backend.shellCommandRunner = vi.fn().mockResolvedValue({
      command: rawCommand,
      output: "",
      outputTruncated: false,
      exitCode: 0,
      signal: null,
      elapsedMs: 1,
      aborted: false
    });

    await backend.runShellEscape(rawCommand);

    const displayCommand = "printf first ↵ printf second";
    expect(backend.shellCommandRunner).toHaveBeenCalledWith(rawCommand, expect.any(Object));
    expect(backend.send).toHaveBeenCalledWith({ type: "shell_started", command: displayCommand });
    expect(backend.send).toHaveBeenCalledWith(expect.objectContaining({ type: "shell_completed", command: displayCommand }));
    expect(JSON.stringify(backend.send.mock.calls)).not.toContain("\\n\\tprintf second");
  });

  it("rejects an empty bang without spawning or invoking the model", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.runPrompt = vi.fn();
    backend.runShellEscape = vi.fn();
    backend.commitError = vi.fn();
    backend.setStatus = vi.fn();

    await backend.submit("!   ");

    expect(backend.runPrompt).not.toHaveBeenCalled();
    expect(backend.runShellEscape).not.toHaveBeenCalled();
    expect(backend.commitError).toHaveBeenCalledWith("Usage: ! <command>");
    expect(backend.setStatus).toHaveBeenCalledWith("Command error");
  });

  it("releases native input while a shell command runs", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const running = deferred<any>();
    backend.shellCommandRunner = vi.fn(() => running.promise);
    backend.send = vi.fn();

    let inputHandled = false;
    const handling = backend.handleNativeEvent({ type: "submit", value: "!printf later" }).then(() => {
      inputHandled = true;
    });

    await setImmediate();
    expect(inputHandled).toBe(true);
    running.resolve({
      command: "printf later",
      output: "",
      outputTruncated: false,
      exitCode: 0,
      signal: null,
      elapsedMs: 1,
      aborted: false
    });
    await handling;
  });

  it("aborts a running shell command through the regular stop lifecycle", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    let receivedSignal: AbortSignal | undefined;
    backend.send = vi.fn();
    backend.shellCommandRunner = vi.fn(
      (_command: string, options: any) =>
        new Promise((resolve) => {
          receivedSignal = options.signal;
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                command: "wait",
                output: "stdout:\nready",
                outputTruncated: false,
                exitCode: null,
                signal: "SIGTERM",
                elapsedMs: 9,
                aborted: true
              }),
            { once: true }
          );
        })
    );

    await backend.handleNativeEvent({ type: "submit", value: "!wait" });
    await setImmediate();
    await backend.handleNativeEvent({ type: "stop" });
    await setImmediate();

    expect(receivedSignal?.aborted).toBe(true);
    expect(backend.send).toHaveBeenCalledWith(expect.objectContaining({ type: "shell_completed", stopped: true }));
    expect(backend.busy).toBe(false);
  });

  it("dispatches a queued bang as a shell command instead of a model prompt", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.busy = true;
    backend.send = vi.fn();
    backend.runPrompt = vi.fn();
    backend.runShellEscape = vi.fn().mockResolvedValue(undefined);

    await backend.submit("!printf queued");
    backend.finishForegroundRun();
    expect(backend.busy).toBe(true);
    await setImmediate();

    expect(backend.runShellEscape).toHaveBeenCalledWith("printf queued");
    expect(backend.runPrompt).not.toHaveBeenCalled();
  });

  it("does not launch a reserved queued shell command after quit", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.busy = true;
    backend.send = vi.fn();
    backend.resolveAllApprovals = vi.fn();
    backend.runShellEscape = vi.fn().mockResolvedValue(undefined);

    await backend.submit("!printf should-not-run");
    backend.finishForegroundRun();
    backend.exit();
    await setImmediate();

    expect(backend.runShellEscape).not.toHaveBeenCalled();
  });

  it("cancels only the reserved queued item and continues later FIFO work", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.busy = true;
    backend.send = vi.fn();
    backend.runShellEscape = vi.fn().mockResolvedValue(undefined);

    await backend.submit("!printf first");
    await backend.submit("!printf second");
    backend.finishForegroundRun();
    await backend.handleNativeEvent({ type: "stop" });
    await setImmediate();

    expect(backend.runShellEscape).toHaveBeenCalledTimes(1);
    expect(backend.runShellEscape).toHaveBeenCalledWith("printf second");
  });

  it("does not forward ANSI, OSC, or carriage-return control data to the native UI", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.send = vi.fn();
    backend.shellCommandRunner = vi.fn(async (_command: string, options: any) => {
      options.onOutput({ stream: "stdout", delta: "\u001b[31mcyan\u001b]0;title" });
      options.onOutput({ stream: "stdout", delta: "\u0007done\rnext\u001b[0m" });
      return {
        command: "ignored",
        output: "\u001b[31mcyan\u001b]0;title\u0007done\rnext\u001b[0m",
        outputTruncated: false,
        exitCode: 0,
        signal: null,
        elapsedMs: 1,
        aborted: false
      };
    });

    await backend.runShellEscape("printf '\u001b[31mcyan'");

    const serialized = JSON.stringify(backend.send.mock.calls);
    expect(serialized).not.toContain("\\u001b");
    expect(serialized).not.toContain("[31m");
    expect(serialized).toContain("cyan");
    expect(serialized).toContain("done\\nnext");
  });

  it("sanitizes shell startup errors before they reach the native protocol", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.send = vi.fn();
    backend.shellCommandRunner = vi.fn().mockRejectedValue(new Error("\u001b]0;unsafe title\u0007not found"));

    await backend.runShellEscape("missing-command");

    const failed = backend.send.mock.calls.find(([event]: any[]) => event.type === "shell_failed")?.[0];
    expect(failed).toEqual(expect.objectContaining({ type: "shell_failed", message: "not found" }));
  });
});

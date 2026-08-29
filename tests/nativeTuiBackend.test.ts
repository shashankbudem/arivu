import { setImmediate } from "node:timers/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/agent/taskWorktree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agent/taskWorktree.js")>()),
  syncTaskWorktreeWithOriginal: vi.fn(),
  continueTaskWorktreeConflict: vi.fn(),
  abortTaskWorktreeConflict: vi.fn()
}));
import type { AppConfig } from "../src/config.js";
import { configForSession, NativeTuiBackend } from "../src/tui/NativeTuiBackend.js";
import { AgentRunAbortedError } from "../src/agent/types.js";
import { createAgentTaskRun } from "../src/agent/taskRuns.js";
import type { NativeClientEvent } from "../src/tui/nativeProtocol.js";
import { parseNativeClientEvent } from "../src/tui/nativeProtocol.js";
import { abortTaskWorktreeConflict, continueTaskWorktreeConflict, syncTaskWorktreeWithOriginal } from "../src/agent/taskWorktree.js";

type BackendHarness = {
  handleNativeEvent(event: Exclude<NativeClientEvent, { type: "hello" }>): Promise<void>;
  runPrompt(value: string): Promise<void>;
  runShellEscape(command: string): Promise<void>;
  continueTurn(): Promise<void>;
  switchModel(model: string, operation?: unknown): Promise<void>;
  submit(value: string): Promise<void>;
  finishForegroundRun(): void;
  executeAgentTurn(runner: (signal: AbortSignal) => Promise<{ output: string; session: any }>): Promise<void>;
  runNativeAgentLoop(content: any, signal: AbortSignal): Promise<{ output: string; session: any }>;
  summarizeCurrentSession(): Promise<void>;
  resolveTaskRunId(session: any, value: string): any;
  exit(): void;
  stopRun(): void;
  applyWorktreeAction(action: string, taskRunId: string): Promise<void>;
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
  it("rejects malformed native approval and elicitation payloads before they can resolve a pending prompt", async () => {
    expect(parseNativeClientEvent({ type: "approval_response", id: "a", approved: "false" })).toBeUndefined();
    expect(parseNativeClientEvent({ type: "elicitation_response", id: "e", status: "answered", answers: {} })).toBeUndefined();
    expect(parseNativeClientEvent({ type: "elicitation_response", id: "e", status: "answered", answers: [null] })).toBeUndefined();
    expect(parseNativeClientEvent({ type: "elicitation_response", id: 1, status: "invalid" })).toBeUndefined();

    const backend = backendHarness() as MutableBackendHarness;
    backend.send = vi.fn();
    const approval = backend.confirm("approve?");
    const approvalId = backend.send.mock.calls[0][0].id;
    await backend.handleNativeEvent({ type: "approval_response", id: approvalId, approved: "false" } as any);
    expect(backend.approvalResolvers.has(approvalId)).toBe(true);
    backend.resolveAllApprovals(false);
    await expect(approval).resolves.toBe(false);

    const waiting = backend.elicit({ questions: [{ id: "answer", type: "text", label: "Answer" }] });
    const elicitationId = backend.send.mock.calls.at(-1)[0].id;
    await backend.handleNativeEvent({ type: "elicitation_response", id: elicitationId, status: "invalid", answers: [null] } as any);
    expect(backend.elicitationResolvers.has(elicitationId)).toBe(true);
    backend.resolveAllElicitations();
    await expect(waiting).resolves.toEqual(expect.objectContaining({ status: "declined" }));
  });

  it("keeps the current session model/provider and its env-only effective key after integration config reload", () => {
    const refreshed: any = {
      model: "global-model",
      baseUrl: "https://api.example.test/v1",
      apiKey: "env-only-key",
      providers: [
        {
          id: "current",
          name: "Current",
          model: "global-model",
          baseUrl: "https://api.example.test/v1/",
          toolCalling: "auto",
          imageInput: "auto"
        }
      ]
    };
    const effective = configForSession(refreshed, {
      id: "session",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      model: "session-model",
      baseUrl: "https://api.example.test/v1",
      selectedProviderId: "current",
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(effective).toEqual(
      expect.objectContaining({ model: "session-model", baseUrl: "https://api.example.test/v1", apiKey: "env-only-key" })
    );
  });

  it("pauses A+B after a queued startup failure and retries only when explicitly requested", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const a = { id: "a", content: "A", state: "queued" as const, createdAt: "2026-01-01T00:00:00.000Z" };
    const b = { id: "b", content: "B", state: "queued" as const, createdAt: "2026-01-01T00:00:01.000Z" };
    backend.currentSession = {
      id: "queue-recovery",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      messages: [],
      queuedPrompts: [a, b],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    backend.config = { model: "auto", baseUrl: "https://provider.test/v1", providers: [], trustMode: "ask" };
    backend.workspace = { root: "/tmp/arivu", dirty: false };
    backend.store = { save: vi.fn().mockResolvedValue(undefined) };
    const received: string[] = [];
    backend.createAgent = vi.fn(() => ({
      run: vi.fn(async (content: any) => {
        received.push(typeof content === "string" ? content : String(content));
        return { output: "done", session: backend.currentSession };
      })
    }));
    backend.send = vi.fn();
    backend.promptQueue.push(
      { kind: "prompt", content: a.content, queuedPromptId: a.id },
      { kind: "prompt", content: b.content, queuedPromptId: b.id }
    );
    backend.busy = true;

    backend.finishForegroundRun();
    for (let attempt = 0; attempt < 12 && backend.busy; attempt += 1) await setImmediate();

    expect(received).toEqual([]);
    expect(backend.currentSession.queuedPrompts.map((prompt: any) => prompt.id)).toEqual(["a", "b"]);
    expect(backend.promptQueue.map((input: any) => input.queuedPromptId)).toEqual(["a", "b"]);
    expect(backend.busy).toBe(false);
    expect(backend.send.mock.calls.filter(([event]: any[]) => event.type === "run_failed")).toHaveLength(1);

    await backend.submit("C");
    expect(backend.currentSession.queuedPrompts.map((prompt: any) => prompt.id)).toEqual(["a", "b", expect.any(String)]);
    expect(backend.promptQueue.map((input: any) => input.queuedPromptId)).toEqual(["a", "b", expect.any(String)]);
    expect(received).toEqual([]);

    backend.config.model = "recovered-model";
    backend.retryQueuedPrompts();
    for (let attempt = 0; attempt < 12 && backend.busy; attempt += 1) await setImmediate();

    expect(received).toEqual(["A", "B", "C"]);
    expect(backend.currentSession.queuedPrompts).toEqual([]);
    expect(backend.promptQueue).toEqual([]);
    expect(backend.busy).toBe(false);
    expect(backend.send.mock.calls.filter(([event]: any[]) => event.type === "commit" && event.entry.text === "A")).toHaveLength(1);
  });

  it("normalizes a preflight-failed steering prompt back to ordinary durable FIFO", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.currentSession = {
      id: "steering-recovery",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      messages: [],
      queuedPrompts: [{ id: "a", content: "A", state: "steering", createdAt: "2026-01-01T00:00:00.000Z" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    backend.store = { save: vi.fn().mockResolvedValue(undefined) };
    backend.send = vi.fn();
    backend.runPrompt = vi.fn().mockResolvedValue(false);

    await backend.runQueuedInput({ kind: "prompt", content: "A", queuedPromptId: "a" });

    expect(backend.currentSession.queuedPrompts).toEqual([expect.objectContaining({ id: "a", state: "queued" })]);
    expect(backend.promptQueue).toEqual([expect.objectContaining({ queuedPromptId: "a", content: "A" })]);
    expect(backend.busy).toBe(false);
  });

  it("records desktop-equivalent loop iteration evidence and inserts report remediation only once", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const taskRun = createAgentTaskRun({ userMessageIndex: 0, prompt: "repair this", now: "2026-01-01T00:00:00.000Z" });
    const session: any = {
      id: "loop-evidence",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      messages: [{ role: "user", content: "repair this", createdAt: "2026-01-01T00:00:00.000Z" }],
      taskRuns: [taskRun],
      agentLoop: {
        status: "running",
        goal: "repair this",
        iteration: 0,
        maxIterations: 2,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    backend.currentSession = session;
    backend.activeTaskRunId = taskRun.id;
    backend.store = { save: vi.fn().mockResolvedValue(undefined) };
    backend.agent = {
      run: vi.fn(async () => {
        taskRun.tools.push({
          id: "tool-event-1",
          toolCallId: "tool-1",
          name: "run_shell",
          capability: "run_command",
          status: "done",
          startedAt: "2026-01-01T00:00:01.000Z"
        });
        taskRun.artifacts.push({
          id: "failed-report",
          kind: "command_output",
          title: "npm test",
          createdAt: "2026-01-01T00:00:01.000Z",
          command: "npm test",
          testReports: [{ path: "junit.xml", kind: "junit", status: "failed", summary: "one failure" }]
        });
        session.messages.push({ role: "assistant", content: "Plan:\n1. Repair the failure\n\nLoop: continue" });
        return { output: "first", session };
      }),
      continue: vi.fn(async () => {
        session.messages.push({ role: "assistant", content: "Completed the repair.\n\nLoop: done" });
        return { output: "second", session };
      })
    };

    const result = await backend.runNativeAgentLoop("repair this", new AbortController().signal);

    expect(result.output).toBe("Completed the repair.");
    expect(taskRun.loop).toEqual(expect.objectContaining({ status: "completed", iteration: 2, lastDecision: "done" }));
    expect(taskRun.loop?.iterations).toEqual([
      expect.objectContaining({ iteration: 1, status: "continued", assistantMessageIndex: 1, toolCallCount: 1, artifactCount: 1 }),
      expect.objectContaining({ iteration: 2, status: "completed", assistantMessageIndex: 4, toolCallCount: 0, artifactCount: 0 })
    ]);
    expect(taskRun.plan).toEqual(expect.objectContaining({ sourceMessageIndex: 1 }));
    const remediation = session.messages.filter((message: any) =>
      String(message.content).includes("Arivu report remediation evidence artifact:")
    );
    expect(remediation).toHaveLength(1);
    expect(session.messages.map((message: any) => message.content)).toContain(
      "Agent loop continuation 2 of 2.\nContinue the same user task from the current transcript.\nReview what has already been done, take the next concrete step, and verify when practical.\nEnd the assistant response with exactly one control line: `Loop: continue`, `Loop: done`, or `Loop: blocked`."
    );
  });

  it("adds explicit stopped and max-iteration loop transcripts with matching final output", async () => {
    const runLoop = async (maxIterations: number, stopRequested: boolean) => {
      const backend = backendHarness() as MutableBackendHarness;
      const taskRun = createAgentTaskRun({ userMessageIndex: 0, prompt: "loop", now: "2026-01-01T00:00:00.000Z" });
      const session: any = {
        id: `loop-${maxIterations}-${stopRequested}`,
        cwd: "/tmp/arivu",
        trustMode: "ask",
        messages: [{ role: "user", content: "loop" }],
        taskRuns: [taskRun],
        agentLoop: {
          status: "running",
          goal: "loop",
          iteration: 0,
          maxIterations,
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
      backend.currentSession = session;
      backend.activeTaskRunId = taskRun.id;
      backend.store = { save: vi.fn().mockResolvedValue(undefined) };
      backend.agent = {
        run: vi.fn(async () => {
          if (stopRequested) session.agentLoop.stopRequested = true;
          session.messages.push({ role: "assistant", content: "Still working.\nLoop: continue" });
          return { output: "still working", session };
        })
      };
      return { result: await backend.runNativeAgentLoop("loop", new AbortController().signal), session, taskRun };
    };

    const stopped = await runLoop(3, true);
    expect(stopped.result.output).toBe("Loop stopped after the current iteration.");
    expect(stopped.taskRun.loop?.iterations?.[0]).toEqual(expect.objectContaining({ status: "stopped", assistantMessageIndex: 1 }));
    expect(stopped.session.messages.at(-1)).toEqual(expect.objectContaining({ role: "assistant", content: stopped.result.output }));

    const maxed = await runLoop(1, false);
    expect(maxed.result.output).toBe("Loop stopped after reaching 1 iterations.");
    expect(maxed.taskRun.loop?.iterations?.[0]).toEqual(expect.objectContaining({ status: "max_iterations", assistantMessageIndex: 1 }));
    expect(maxed.session.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: "Loop stopped after reaching 1 iterations. Review the latest result or continue manually."
      })
    );
  });

  it("labels continuation instructions with the next desktop iteration for two- and three-step loops", async () => {
    const continuationLabels = async (maxIterations: number) => {
      const backend = backendHarness() as MutableBackendHarness;
      const taskRun = createAgentTaskRun({ userMessageIndex: 0, prompt: "loop", now: "2026-01-01T00:00:00.000Z" });
      const session: any = {
        id: `labels-${maxIterations}`,
        cwd: "/tmp/arivu",
        trustMode: "ask",
        messages: [{ role: "user", content: "loop" }],
        taskRuns: [taskRun],
        agentLoop: {
          status: "running",
          goal: "loop",
          iteration: 0,
          maxIterations,
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
      const respond = () => {
        const decision = session.agentLoop.iteration >= maxIterations ? "done" : "continue";
        session.messages.push({ role: "assistant", content: `Step ${session.agentLoop.iteration}.\nLoop: ${decision}` });
        return { output: "step", session };
      };
      backend.currentSession = session;
      backend.activeTaskRunId = taskRun.id;
      backend.store = { save: vi.fn().mockResolvedValue(undefined) };
      backend.agent = { run: vi.fn(respond), continue: vi.fn(respond) };
      await backend.runNativeAgentLoop("loop", new AbortController().signal);
      return session.messages
        .filter((message: any) => message.role === "system" && String(message.content).startsWith("Agent loop continuation"))
        .map((message: any) => String(message.content).split("\n")[0]);
    };

    await expect(continuationLabels(2)).resolves.toEqual(["Agent loop continuation 2 of 2."]);
    await expect(continuationLabels(3)).resolves.toEqual(["Agent loop continuation 2 of 3.", "Agent loop continuation 3 of 3."]);
  });

  it("cancels the selected durable queued prompt before handing later prompts off", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.send = vi.fn();
    backend.store = { save: vi.fn().mockResolvedValue(undefined) };
    backend.currentSession = {
      id: "s",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      messages: [],
      queuedPrompts: [
        { id: "a", content: "A", state: "queued", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "b", content: "B", state: "queued", createdAt: "2026-01-01T00:00:01.000Z" }
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    backend.pendingQueuedInput = { kind: "prompt", content: "A", queuedPromptId: "a" };
    backend.promptQueue = [{ kind: "prompt", content: "B", queuedPromptId: "b" }];
    backend.busy = true;
    backend.finishForegroundRun = vi.fn();
    backend.stopRun();
    expect(backend.currentSession.queuedPrompts.map((prompt: { id: string }) => prompt.id)).toEqual(["b"]);
    expect(backend.finishForegroundRun).toHaveBeenCalled();
  });

  it("denies a pending approval before aborting a run", () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.runAbortController = new AbortController();
    backend.send = vi.fn();
    const resolve = vi.fn();
    backend.approvalResolvers = new Map([["approval", resolve]]);
    backend.stopRun();
    expect(resolve).toHaveBeenCalledWith(false);
    expect(backend.runAbortController.signal.aborted).toBe(true);
  });

  it("persists a worktree lifecycle failure instead of leaving stale conflict state unrecorded", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.store = { save: vi.fn().mockResolvedValue(undefined) };
    backend.send = vi.fn();
    const worktree = {
      enabled: true,
      status: "ready",
      conflict: { type: "sync", message: "Resolve me", files: [], detectedAt: "2026-01-01T00:00:00.000Z" },
      error: "old error",
      patchPreview: { text: "old", bytes: 3, lineCount: 1, truncated: false, updatedAt: "2026-01-01T00:00:00.000Z" },
      pullRequest: { title: "old" }
    };
    backend.currentSession = {
      id: "s",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      messages: [],
      taskRuns: [{ id: "run", status: "completed", worktree }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    await expect(backend.applyWorktreeAction("preview", "run")).rejects.toThrow(/Resolve or abort/);
    expect(worktree.error).toMatch(/Resolve or abort/);
    expect(backend.store.save).toHaveBeenCalled();
  });

  it("clears stale worktree state on sync and conflict lifecycle success", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.store = { save: vi.fn().mockResolvedValue(undefined) };
    backend.send = vi.fn();
    const stale = { type: "sync", message: "old", files: [], detectedAt: "2026-01-01T00:00:00.000Z" };
    const worktree: any = {
      enabled: true,
      status: "ready",
      conflict: stale,
      error: "old",
      patchPreview: { text: "old" },
      pullRequest: { title: "old" }
    };
    backend.currentSession = {
      id: "s",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      messages: [],
      taskRuns: [{ id: "run", status: "completed", worktree }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    vi.mocked(syncTaskWorktreeWithOriginal).mockResolvedValue({
      diff: { hasChanges: false, files: 0, additions: 0, deletions: 0, updatedAt: "now" },
      conflict: undefined
    } as any);
    await backend.applyWorktreeAction("sync", "run");
    expect(worktree.conflict).toBeUndefined();
    expect(worktree.patchPreview).toBeUndefined();
    expect(worktree.pullRequest).toBeUndefined();
    expect(worktree.error).toBeUndefined();
    worktree.conflict = stale;
    worktree.patchPreview = { text: "old" };
    worktree.pullRequest = { title: "old" };
    worktree.error = "old";
    vi.mocked(continueTaskWorktreeConflict).mockResolvedValue({
      diff: { hasChanges: false, files: 0, additions: 0, deletions: 0, updatedAt: "now" }
    } as any);
    await backend.applyWorktreeAction("continue", "run");
    expect(worktree.conflict).toBeUndefined();
    expect(worktree.patchPreview).toBeUndefined();
    expect(worktree.pullRequest).toBeUndefined();
    expect(worktree.error).toBeUndefined();
    worktree.conflict = stale;
    worktree.patchPreview = { text: "old" };
    worktree.pullRequest = { title: "old" };
    worktree.error = "old";
    vi.mocked(abortTaskWorktreeConflict).mockResolvedValue({
      diff: { hasChanges: false, files: 0, additions: 0, deletions: 0, updatedAt: "now" }
    } as any);
    await backend.applyWorktreeAction("abort", "run");
    expect(worktree.conflict).toBeUndefined();
    expect(worktree.patchPreview).toBeUndefined();
    expect(worktree.pullRequest).toBeUndefined();
    expect(worktree.error).toBeUndefined();
    expect(backend.store.save).toHaveBeenCalledTimes(3);
  });
  it("reserves the foreground slot before asynchronous prompt setup", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const saved = deferred<void>();
    backend.options.config = { model: "test-model", baseUrl: "https://provider.test/v1", trustMode: "ask", providers: [] };
    backend.config = backend.options.config;
    backend.workspace = { root: "/tmp/arivu", dirty: false };
    backend.store = { save: vi.fn(() => saved.promise) };
    backend.createAgent = vi.fn(() => ({ run: vi.fn(async () => ({ output: "done", session: backend.currentSession })) }));
    backend.send = vi.fn();

    const starting = backend.runPrompt("first");
    expect(backend.busy).toBe(true);
    const queued = backend.submit("second");
    await setImmediate();
    expect(backend.busy).toBe(true);
    saved.resolve();
    await queued;
    expect(backend.promptQueue).toEqual([
      expect.objectContaining({ kind: "prompt", content: "second", queuedPromptId: expect.any(String) })
    ]);
    await starting;
    expect(backend.currentSession.taskRuns[0]).toEqual(
      expect.objectContaining({ status: "completed", model: "test-model", modelSelectionReason: "manual model selected" })
    );
  });

  it("marks a created task run failed and clears reservation when setup fails", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.options.config = { model: "test-model", baseUrl: "https://provider.test/v1", trustMode: "ask", providers: [] };
    backend.config = backend.options.config;
    backend.workspace = { root: "/tmp/arivu", dirty: false };
    backend.store = { save: vi.fn().mockResolvedValue(undefined) };
    backend.createAgent = vi.fn(() => {
      throw new Error("agent startup failed");
    });
    backend.send = vi.fn();

    await backend.runPrompt("first");

    expect(backend.currentSession.taskRuns).toEqual([expect.objectContaining({ status: "failed", error: "agent startup failed" })]);
    expect(backend.activeTaskRunId).toBeUndefined();
    expect(backend.activeCheckpoint).toBeUndefined();
    expect(backend.busy).toBe(false);
    expect(backend.send).toHaveBeenCalledWith(expect.objectContaining({ type: "run_failed", message: "agent startup failed" }));
  });

  it("does not reserve a foreground turn when there is nothing to continue", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.send = vi.fn();
    backend.commitSystem = vi.fn();
    backend.setStatus = vi.fn();

    await backend.continueTurn();

    expect(backend.busy).toBe(false);
    expect(backend.runAbortController).toBeUndefined();
    expect(backend.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "run_started" }));
    expect(backend.setStatus).toHaveBeenCalledWith("Nothing to continue");
  });

  it("removes a steering FIFO entry only after the Agent consumes it", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const id = "steer-me";
    backend.busy = true;
    backend.currentSession = {
      id: "steering-session",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      messages: [{ role: "user", content: "active" }],
      queuedPrompts: [{ id, content: "please steer", state: "queued", createdAt: "2026-01-01T00:00:00.000Z" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    backend.promptQueue.push({ kind: "prompt", content: "please steer", queuedPromptId: id });
    backend.store = { save: vi.fn().mockResolvedValue(undefined) };
    backend.send = vi.fn();
    backend.commitSystem = vi.fn();
    backend.setStatus = vi.fn();

    await backend.steerQueuedPrompt(id);

    expect(backend.currentSession.queuedPrompts).toEqual([expect.objectContaining({ id, state: "steering" })]);
    expect(backend.promptQueue).toEqual([expect.objectContaining({ queuedPromptId: id })]);

    backend.currentSession.queuedPrompts = [];
    backend.dropConsumedQueuedInputs();
    expect(backend.promptQueue).toEqual([]);
  });

  it("falls a steering prompt back to foreground FIFO when the run ends before a safe boundary", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const id = "steer-fallback";
    backend.busy = true;
    backend.currentSession = {
      id: "steering-session",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      messages: [{ role: "user", content: "active" }],
      queuedPrompts: [{ id, content: "follow up", state: "queued", createdAt: "2026-01-01T00:00:00.000Z" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    backend.promptQueue.push({ kind: "prompt", content: "follow up", queuedPromptId: id });
    backend.store = { save: vi.fn().mockResolvedValue(undefined) };
    backend.send = vi.fn();
    backend.commitSystem = vi.fn();
    backend.setStatus = vi.fn();
    backend.runInBackground = vi.fn();
    backend.runPrompt = vi.fn().mockResolvedValue(undefined);

    await backend.steerQueuedPrompt(id);
    backend.finishForegroundRun();
    await setImmediate();

    expect(backend.currentSession.queuedPrompts).toEqual([]);
    expect(backend.runPrompt).toHaveBeenCalledWith("follow up");
    expect(backend.runInBackground).toHaveBeenCalledOnce();
    expect(backend.runInBackground.mock.calls[0][1]).toMatch(/queued prompt/);
  });

  it("restores a durable steering prompt after restarting without an active turn", () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.currentSession = {
      id: "restore-steering",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      messages: [],
      queuedPrompts: [{ id: "steering", content: "do not lose", state: "steering", createdAt: "2026-01-01T00:00:00.000Z" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    backend.restoreDurablePromptQueue();

    expect(backend.promptQueue).toEqual([expect.objectContaining({ queuedPromptId: "steering", content: "do not lose" })]);
  });

  it("keeps queued multimodal ChatContent intact through durable foreground handoff", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const content = [
      { type: "text" as const, text: "inspect this" },
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,AA==" }, name: "reference.png" }
    ];
    backend.currentSession = {
      id: "multimodal-queue",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      messages: [],
      queuedPrompts: [{ id: "image-prompt", content, state: "queued", createdAt: "2026-01-01T00:00:00.000Z" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    backend.store = { save: vi.fn().mockResolvedValue(undefined) };
    backend.runPrompt = vi.fn().mockResolvedValue(undefined);

    await backend.runQueuedInput({ kind: "prompt", content, queuedPromptId: "image-prompt" });

    expect(backend.runPrompt).toHaveBeenCalledWith(content);
  });

  it("attaches bounded workspace file and image context to the next durable prompt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arivu-tui-attachments-"));
    try {
      await writeFile(path.join(root, "notes with spaces.txt"), "workspace notes </workspace_file>");
      await writeFile(path.join(root, "reference.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const backend = backendHarness() as MutableBackendHarness;
      backend.workspace = { root, dirty: false };
      backend.send = vi.fn();
      backend.commitSystem = vi.fn();
      backend.setStatus = vi.fn();

      await backend.attachWorkspaceContext("file", "notes with spaces.txt");
      await backend.attachWorkspaceContext("image", "reference.png");
      const content = backend.composePromptContent("review these");

      expect(content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text" }),
          expect.objectContaining({ type: "image_url", name: "reference.png" })
        ])
      );
      expect((content as any[])[0].text).toContain('<workspace_file path="notes with spaces.txt"');
      expect((content as any[])[0].text).toContain("<\\/workspace_file>");
      await expect(backend.attachWorkspaceContext("file", "../outside.txt")).rejects.toThrow(/workspace root/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bridges typed ask_user requests and declines them when the native UI disconnects", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.send = vi.fn();
    const waiting = backend.elicit({
      title: "Deployment",
      questions: [{ id: "target", type: "select", label: "Where?", required: true, options: [{ value: "staging" }] }]
    });
    const request = backend.send.mock.calls[0][0];
    expect(request).toEqual(expect.objectContaining({ type: "elicitation", title: "Deployment" }));

    await backend.handleNativeEvent({
      type: "elicitation_response",
      id: request.id,
      status: "answered",
      answers: [{ id: "target", value: "staging" }]
    });
    await expect(waiting).resolves.toEqual({ status: "answered", answers: [{ id: "target", value: "staging" }] });

    const abandoned = backend.elicit({ questions: [{ id: "note", type: "text", label: "Note" }] });
    backend.handleNativeDisconnect();
    await expect(abandoned).resolves.toEqual(expect.objectContaining({ status: "declined" }));
  });

  it("validates native elicitation URL responses before returning them to the agent", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.send = vi.fn();
    backend.setStatus = vi.fn();
    const waiting = backend.elicit({ questions: [{ id: "url", type: "url", label: "Endpoint", required: true }] });
    const request = backend.send.mock.calls[0][0];

    await backend.handleNativeEvent({
      type: "elicitation_response",
      id: request.id,
      status: "answered",
      answers: [{ id: "url", value: "https://example.com:abc" }]
    });
    expect(backend.setStatus).toHaveBeenCalledWith("Enter a valid URL.", true);

    await backend.handleNativeEvent({
      type: "elicitation_response",
      id: request.id,
      status: "answered",
      answers: [{ id: "url", value: "https://example.com/path" }]
    });
    await expect(waiting).resolves.toEqual({ status: "answered", answers: [{ id: "url", value: "https://example.com/path" }] });
  });

  it("resolves only unique task-run prefixes", () => {
    const backend = backendHarness();
    const session = { taskRuns: [{ id: "abc-unique" }, { id: "abd-other" }] };

    expect(backend.resolveTaskRunId(session, "abc")).toEqual({ id: "abc-unique" });
    expect(() => backend.resolveTaskRunId(session, "ab")).toThrow(/ambiguous/);
    expect(backend.resolveTaskRunId(session, "missing")).toBeUndefined();
  });

  it("persists the partial session after a stopped agent turn", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    const taskRun = createAgentTaskRun({ userMessageIndex: 0, prompt: "keep this work", now: "2026-01-01T00:00:00.000Z" });
    const session = {
      id: "stopped-session",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      messages: [{ role: "user", content: "keep this work" }],
      taskRuns: [taskRun],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    backend.currentSession = session;
    backend.activeTaskRunId = taskRun.id;
    backend.store = { save: vi.fn().mockResolvedValue(undefined) };
    backend.send = vi.fn();
    backend.finishForegroundRun = vi.fn();

    await backend.executeAgentTurn(async () => {
      session.messages.push({ role: "system", content: "[Run recovery] resume safely" });
      throw new AgentRunAbortedError();
    });

    expect(backend.store.save).toHaveBeenCalledWith(session);
    expect(taskRun.status).toBe("stopped");
    expect(backend.send).toHaveBeenCalledWith(expect.objectContaining({ type: "run_stopped" }));
  });

  it("hands queued input off after /summarize completes", async () => {
    const backend = backendHarness() as MutableBackendHarness;
    backend.currentSession = {
      id: "summary-session",
      cwd: "/tmp/arivu",
      trustMode: "ask",
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    backend.createAgent = vi.fn(() => ({ summarizeContext: vi.fn().mockResolvedValue({ compacted: false }) }));
    backend.send = vi.fn();
    backend.finishForegroundRun = vi.fn();

    await backend.summarizeCurrentSession();

    expect(backend.finishForegroundRun).toHaveBeenCalledOnce();
  });

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

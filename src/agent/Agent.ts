import crypto from "node:crypto";
import type { ApprovalManager } from "../permissions/ApprovalManager.js";
import { createToolRegistry } from "../tools/registry.js";
import type { ChangeCheckpoint } from "../tools/changeCheckpoint.js";
import type { BrowserTaskModelConfig, BrowserToolController } from "../tools/browserControl.js";
import { detectWorkspace } from "../workspace.js";
import { chatContentToText, trimChatContent, type ChatContent } from "./content.js";
import { stripFencedCodeBlocks } from "./textualToolCalls.js";
import { applyModelSummary, compactMessagesForModelRequest, compactSessionMessages, messagesToSummarize } from "./contextCompaction.js";
import { discoverSkills, readSkill, skillsSystemMessage } from "./skills.js";
import { parseContextLimit } from "../models/contextLimitParser.js";
import { AgentRunAbortedError } from "./types.js";
import type { AgentRunOptions, AgentSession, ChatClient, ChatMessage, ChatRequest, ChatResponse, ToolCall } from "./types.js";
import type { AppConfig } from "../config.js";

const MAX_STEPS = 500;
const SYSTEM_PROMPT_VERSION = 2;
const SYSTEM_PROMPT_SIGNATURE = "You are Arivu";
const WEB_SEARCH_TOOL = "web_search";
const PARALLEL_TOOL_LIMIT = 5;
// Read-only tools with no side effects that are safe to run concurrently within one assistant turn.
// Writes, commands, browser, MCP, and web_search are intentionally excluded and stay sequential.
const PARALLEL_SAFE_TOOLS = new Set([
  "list",
  "read",
  "search",
  "git_status",
  "current_datetime",
  "current_location",
  "list_skills",
  "read_skill"
]);
const BROWSER_STATE_TOOL = "browser_state";
// The low-level browser_snapshot tool is disabled in the registry (agents are steered toward
// browser_task); the synthetic browser-evidence refresh uses browser_screenshot instead.
const BROWSER_SCREENSHOT_TOOL = "browser_screenshot";
const LOADED_SKILL_PREFIX = "Skill loaded into chat:";
// Models sometimes attempt a tool call as plain text: imitating our textified transcript
// format ("Local tool request:"), or leaking their own chat-template syntax (<tool_call>,
// <function=...>) when the provider fails to parse it server-side. The chat client recovers
// complete, well-formed textual calls into native ones (see textualToolCalls.ts); anything
// that still reaches this guard is unparseable or truncated, so retry with a corrective
// instruction instead of accepting it as a final answer.
const TOOL_MIMICRY_PATTERN = /^\s*Local tool requests?:|<tool_call>|<function=/m;
const MAX_TOOL_MIMICRY_RETRIES = 2;

export class Agent {
  private readonly session: AgentSession;

  constructor(
    private readonly options: {
      client: ChatClient;
      approvals: ApprovalManager;
      cwd: string;
      projectRoot?: string | null;
      model?: string;
      baseUrl?: string;
      tavilyApiKey?: string;
      mcpServers?: AppConfig["mcpServers"];
      scopePolicyRules?: AppConfig["workspacePolicies"][string]["scopeRules"];
      browser?: BrowserToolController;
      browserTaskModel?: BrowserTaskModelConfig;
      directEditReview?: boolean;
      contextWindowTokens?: number;
      /**
       * Called when a live request overflows the model's context and the provider names its real
       * limit. Lets the caller record the true window for free, with no extra API calls — the
       * scheduled catalog sync deliberately skips the active model most days.
       */
      onContextWindowObserved?: (tokens: number) => void | Promise<void>;
      checkpoint?: ChangeCheckpoint;
      session?: AgentSession;
    }
  ) {
    this.session =
      options.session ?? createSession(options.cwd, options.projectRoot, options.approvals.mode, options.model, options.baseUrl);
  }

  async run(prompt: ChatContent, runOptions: AgentRunOptions = {}): Promise<{ output: string; session: AgentSession }> {
    return this.runWithPreparedSession(prompt, runOptions, "prompt");
  }

  async continue(runOptions: AgentRunOptions = {}): Promise<{ output: string; session: AgentSession }> {
    return this.runWithPreparedSession("", runOptions, "continue");
  }

  /**
   * Model-generated summary compaction: ask the model to summarize the older conversation, then
   * replace it with that summary while keeping recent turns verbatim. Falls back to deterministic
   * compaction if the model call fails or produces nothing usable.
   */
  async summarizeContext(runOptions: AgentRunOptions = {}): Promise<{
    session: AgentSession;
    compacted: boolean;
    compactedMessageCount: number;
    source: "model" | "deterministic" | "none";
  }> {
    throwIfAborted(runOptions.signal);
    const older = messagesToSummarize(this.session.messages);
    if (older.length === 0) {
      return { session: this.session, compacted: false, compactedMessageCount: 0, source: "none" };
    }

    const tokenLimit = requestTokenLimitForContextWindow(this.options.contextWindowTokens);
    try {
      const summaryRequest = compactChatRequestForModel(
        {
          messages: [
            { role: "system", content: SUMMARY_INSTRUCTION },
            { role: "user", content: summaryTranscript(older) }
          ],
          tools: []
        },
        "default",
        tokenLimit
      );
      const response = await this.completeOnce(summaryRequest, { signal: runOptions.signal });
      const summary = chatContentToText(response.message.content).trim();
      if (!summary) {
        throw new Error("Model returned an empty summary.");
      }
      const result = applyModelSummary(this.session.messages, summary);
      if (result.compacted) {
        this.session.messages.splice(0, this.session.messages.length, ...result.messages);
        this.touch();
      }
      return {
        session: this.session,
        compacted: result.compacted,
        compactedMessageCount: result.compactedMessageCount,
        source: result.compacted ? "model" : "none"
      };
    } catch (error) {
      if (error instanceof AgentRunAbortedError) {
        throw error;
      }
      // Deterministic fallback keeps the feature reliable when a provider cannot summarize.
      const result = compactSessionMessages(this.session.messages);
      if (result.compacted) {
        this.session.messages.splice(0, this.session.messages.length, ...result.messages);
        this.touch();
      }
      return {
        session: this.session,
        compacted: result.compacted,
        compactedMessageCount: result.compactedMessageCount,
        source: result.compacted ? "deterministic" : "none"
      };
    }
  }

  private async runWithPreparedSession(
    prompt: ChatContent,
    runOptions: AgentRunOptions,
    mode: "prompt" | "continue"
  ): Promise<{ output: string; session: AgentSession }> {
    const rollbackMessages = cloneMessages(this.session.messages);
    const rollbackTaskRunIndexes = taskRunIndexSnapshot(this.session);
    const promptAlreadyInSession = runOptions.promptAlreadyInSession === true;
    const existingPromptMessage = promptAlreadyInSession ? this.session.messages.at(-1) : undefined;
    if (promptAlreadyInSession && mode !== "prompt") {
      throw new Error("A saved prompt can only be reused for prompt runs.");
    }
    if (promptAlreadyInSession) {
      if (existingPromptMessage?.role !== "user") {
        throw new Error("The saved prompt must be the last user message.");
      }
      existingPromptMessage.content = trimChatContent(existingPromptMessage.content);
    }
    const workspace = await detectWorkspace(this.options.cwd);
    const skills = await discoverSkills();
    const skillInstruction = skillsSystemMessage(skills);
    const availableSkillNames = skills.map((skill) => skill.name);
    const tools = createToolRegistry({
      workspaceRoot: workspace.root,
      approvals: this.options.approvals,
      tavilyApiKey: this.options.tavilyApiKey,
      mcpServers: this.options.mcpServers,
      scopePolicyRules: this.options.scopePolicyRules,
      browser: this.options.browser,
      browserTaskModel: this.options.browserTaskModel,
      onBrowserTaskProgress: (progress) => {
        void runOptions.onEvent?.({ type: "browser_task_progress", ...progress });
      },
      directEditReview: this.options.directEditReview,
      signal: runOptions.signal,
      checkpoint: this.options.checkpoint
    });

    const existingSystem = this.session.messages.find(
      (message) => message.role === "system" && chatContentToText(message.content).includes(SYSTEM_PROMPT_SIGNATURE)
    );
    if (!existingSystem) {
      this.session.messages.unshift({
        role: "system",
        content: systemPrompt(workspace.root)
      });
      shiftTaskRunMessageIndexes(this.session, 0, 1);
    } else {
      // Rebuild the base prompt from scratch each run so it stays at the current version and reflects
      // the active workspace, rather than accreting appended sentences forever. Separate system
      // messages (loop instructions, loaded skills) are untouched.
      existingSystem.content = systemPrompt(workspace.root);
    }

    const insertBeforeSavedPrompt = (message: ChatMessage) => {
      if (!promptAlreadyInSession || !existingPromptMessage) {
        this.session.messages.push(message);
        return;
      }
      const promptIndex = this.session.messages.indexOf(existingPromptMessage);
      const insertionIndex = promptIndex >= 0 ? promptIndex : this.session.messages.length;
      this.session.messages.splice(insertionIndex, 0, message);
      shiftTaskRunMessageIndexes(this.session, insertionIndex, 1);
    };

    const loadedSkillNames = loadedSkillNamesForSession(this.session.messages);
    const newlyLoadedSkillMessages = await skillMessagesForNames(runOptions.skillNames ?? [], availableSkillNames, loadedSkillNames);
    for (const message of newlyLoadedSkillMessages) {
      insertBeforeSavedPrompt(message);
      const name = loadedSkillNameFromMessage(message);
      if (name) {
        loadedSkillNames.add(name);
      }
    }

    const attachedSkillMessages = mode === "prompt" ? await skillMessagesForPrompt(prompt, availableSkillNames, loadedSkillNames) : [];
    if (mode === "prompt" && !promptAlreadyInSession) {
      this.session.messages.push({ role: "user", content: trimChatContent(prompt) });
    }

    try {
      throwIfAborted(runOptions.signal);
      let webSearchCalls = 0;

      const allowedToolNames = runOptions.allowedToolNames ? new Set(runOptions.allowedToolNames) : undefined;
      const toolSchemas = allowedToolNames ? tools.schemas.filter((tool) => allowedToolNames.has(tool.name)) : tools.schemas;
      const initiallyDisabled = await resolveDisabledToolNames(runOptions.disabledToolNames);
      if (
        shouldRefreshBrowserEvidence(prompt, mode, this.session.messages) &&
        !initiallyDisabled.has(BROWSER_STATE_TOOL) &&
        !initiallyDisabled.has(BROWSER_SCREENSHOT_TOOL) &&
        hasTool(toolSchemas, BROWSER_STATE_TOOL) &&
        hasTool(toolSchemas, BROWSER_SCREENSHOT_TOOL)
      ) {
        await refreshBrowserEvidence(tools, runOptions, this.session.messages);
      }

      let mimicryRetries = 0;
      for (let step = 0; step < MAX_STEPS; step += 1) {
        throwIfAborted(runOptions.signal);
        // Re-resolved every step so in-app tool toggles flipped mid-run take effect at the next
        // model request instead of waiting for the next prompt.
        const disabledToolNames = await resolveDisabledToolNames(runOptions.disabledToolNames);
        // After a web search we only withhold web_search itself (the transient instruction in
        // messagesForStep tells the model to answer from the results). Every other tool stays
        // available so a coding task that searched once can still read and edit files.
        const availableTools = toolSchemas.filter(
          (tool) => !disabledToolNames.has(tool.name) && (webSearchCalls === 0 || tool.name !== WEB_SEARCH_TOOL)
        );
        const response = await this.complete(
          {
            messages: messagesForStep(this.session.messages, webSearchCalls, [
              skillInstruction,
              ...attachedSkillMessages,
              toolMimicryInstruction(mimicryRetries)
            ]),
            tools: availableTools
          },
          runOptions
        );
        if (response.usage) {
          await runOptions.onUsage?.(response.usage);
        }
        const toolCalls = allowedToolCalls(response.message.toolCalls, availableTools);
        const message = toolCalls === response.message.toolCalls ? response.message : { ...response.message, toolCalls };
        this.session.messages.push(message);

        if (!toolCalls || toolCalls.length === 0) {
          const output = chatContentToText(message.content);
          if (output.trim().length === 0) {
            // Distinguish the two very different causes of an empty turn so the failure is
            // actionable: (a) the model DID call tools, but every one was filtered out because it
            // isn't available this step (disabled tool, hallucinated name, or web_search withheld
            // after a search) — nothing could run; versus (b) the provider genuinely returned no
            // content and no tool calls (a provider hiccup or a model that stopped early).
            const requestedCalls = response.message.toolCalls ?? [];
            if (requestedCalls.length > 0) {
              const availableNames = new Set(availableTools.map((tool) => tool.name));
              const droppedNames = [...new Set(requestedCalls.map((call) => call.name).filter((name) => !availableNames.has(name)))];
              throw new Error(
                `Model returned an empty assistant response: it only called tools that are not available this turn (${droppedNames.join(
                  ", "
                )}), so nothing ran. Those tools are disabled or were withheld for this step — ask the model to use an available tool or answer directly.`
              );
            }
            throw new Error(
              "Model returned an empty assistant response: the provider returned no content and no tool calls. This is usually a provider-side hiccup or a model that stopped early — retry, and check the API request log to see the raw response."
            );
          }
          // Only treat the pattern as mimicry when the model truly emitted no native tool
          // calls; a response whose calls were merely filtered out as disallowed is not one.
          // Fenced code is excluded so a final answer QUOTING tool-call syntax is not retried.
          if (
            !response.message.toolCalls?.length &&
            availableTools.length > 0 &&
            TOOL_MIMICRY_PATTERN.test(stripFencedCodeBlocks(output)) &&
            mimicryRetries < MAX_TOOL_MIMICRY_RETRIES
          ) {
            mimicryRetries += 1;
            // Drop the mimicking turn so neither the saved session nor the next request keeps
            // it; the transient corrective instruction handles the retry.
            this.session.messages.pop();
            continue;
          }
          this.touch();
          return {
            output,
            session: this.session
          };
        }

        webSearchCalls += await this.executeToolCalls(toolCalls, tools, runOptions);
      }

      const output = `Stopped after reaching the maximum tool-call depth (${MAX_STEPS} steps). Continue to resume from here.`;
      this.session.messages.push({ role: "assistant", content: output });
      this.touch();
      return {
        output,
        session: this.session
      };
    } catch (error) {
      this.session.messages.splice(0, this.session.messages.length, ...rollbackMessages);
      restoreTaskRunMessageIndexes(this.session, rollbackTaskRunIndexes);
      throw error;
    }
  }

  /**
   * Execute an assistant turn's tool calls, running consecutive read-only calls concurrently while
   * keeping writes, commands, and other side-effecting calls strictly sequential and ordered. Tool
   * result messages are always appended in the original call order to keep the tool protocol valid.
   * Returns the number of web_search calls executed.
   */
  private async executeToolCalls(
    toolCalls: NonNullable<ChatMessage["toolCalls"]>,
    tools: { execute(name: string, args: unknown): Promise<string> },
    runOptions: AgentRunOptions
  ): Promise<number> {
    let webSearchCalls = 0;
    let index = 0;
    while (index < toolCalls.length) {
      throwIfAborted(runOptions.signal);
      const start = index;
      if (isParallelSafeTool(toolCalls[start]!.name)) {
        while (index < toolCalls.length && isParallelSafeTool(toolCalls[index]!.name)) {
          index += 1;
        }
        const batch = toolCalls.slice(start, index);
        const results = await this.runToolCallBatch(batch, tools, runOptions);
        for (let offset = 0; offset < batch.length; offset += 1) {
          this.appendToolResult(batch[offset]!, results[offset]!);
        }
      } else {
        const call = toolCalls[start]!;
        const result = await this.runSingleToolCall(call, tools, runOptions);
        this.appendToolResult(call, result);
        if (call.name === WEB_SEARCH_TOOL) {
          webSearchCalls += 1;
        }
        index += 1;
      }
    }
    return webSearchCalls;
  }

  private async runToolCallBatch(
    batch: NonNullable<ChatMessage["toolCalls"]>,
    tools: { execute(name: string, args: unknown): Promise<string> },
    runOptions: AgentRunOptions
  ): Promise<string[]> {
    if (batch.length === 1) {
      return [await this.runSingleToolCall(batch[0]!, tools, runOptions)];
    }
    const results = new Array<string>(batch.length);
    let next = 0;
    const workerCount = Math.min(PARALLEL_TOOL_LIMIT, batch.length);
    const worker = async () => {
      for (;;) {
        const current = next;
        next += 1;
        if (current >= batch.length) {
          return;
        }
        results[current] = await this.runSingleToolCall(batch[current]!, tools, runOptions);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  private async runSingleToolCall(
    call: ToolCall,
    tools: { execute(name: string, args: unknown): Promise<string> },
    runOptions: AgentRunOptions
  ): Promise<string> {
    await runOptions.onEvent?.({ type: "tool_call", call });
    const result = await tools.execute(call.name, call.arguments);
    await runOptions.onEvent?.({ type: "tool_result", toolCallId: call.id, name: call.name, result });
    return result;
  }

  private appendToolResult(call: ToolCall, result: string) {
    this.session.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result });
  }

  private async complete(request: ChatRequest, runOptions: AgentRunOptions): Promise<ChatResponse> {
    const tokenLimit = requestTokenLimitForContextWindow(this.options.contextWindowTokens);
    const compactedRequest = compactChatRequestForModel(request, "default", tokenLimit);
    try {
      return await this.completeOnce(compactedRequest, runOptions);
    } catch (error) {
      if (!isContextLengthError(error)) {
        throw error;
      }
      // The provider just told us the model's real window in its rejection. Record it before
      // retrying: it is the only free, always-fresh source of truth for the active model.
      this.reportObservedContextWindow(error);
      return this.completeOnce(compactChatRequestForModel(request, "aggressive", tokenLimit), runOptions);
    }
  }

  private reportObservedContextWindow(error: unknown) {
    const sink = this.options.onContextWindowObserved;
    if (!sink) {
      return;
    }
    const tokens = parseContextLimit(error instanceof Error ? error.message : String(error));
    if (!tokens) {
      return;
    }
    // Never let bookkeeping break the retry that the user is actually waiting on.
    void Promise.resolve(sink(tokens)).catch(() => undefined);
  }

  private async completeOnce(request: ChatRequest, runOptions: AgentRunOptions): Promise<ChatResponse> {
    const callOptions = { signal: runOptions.signal };
    if (!this.options.client.stream) {
      return this.options.client.complete(request, callOptions);
    }

    return this.options.client.stream(
      request,
      async (event) => {
        if (event.type === "content_delta") {
          await runOptions.onEvent?.({
            type: "assistant_delta",
            delta: event.delta
          });
          return;
        }

        await runOptions.onEvent?.({
          type: "tool_call_delta",
          toolCallId: event.id,
          index: event.index,
          name: event.name,
          argumentsDelta: event.argumentsDelta,
          argumentsText: event.argumentsText
        });
      },
      callOptions
    );
  }

  private touch() {
    this.session.updatedAt = new Date().toISOString();
  }
}

function createSession(
  cwd: string,
  projectRoot: string | null | undefined,
  trustMode: AgentSession["trustMode"],
  model?: string,
  baseUrl?: string
): AgentSession {
  const now = new Date().toISOString();
  return {
    id: crypto.randomBytes(4).toString("hex"),
    cwd,
    projectRoot: projectRoot ?? null,
    trustMode,
    model,
    baseUrl,
    messages: [],
    createdAt: now,
    updatedAt: now
  };
}

function systemPrompt(workspaceRoot: string) {
  return [
    "You are Arivu, a local CLI coding agent.",
    `Today's date is ${new Date().toISOString().slice(0, 10)}.`,
    "Inspect the repo before editing. Prefer small, targeted changes.",
    "For current or recent information, use web_search once, then answer from the retrieved results.",
    "Use current_datetime for exact local date or time questions.",
    "Use current_location for approximate timezone-level location context; do not treat it as GPS or IP-based location.",
    "Read files before editing them. Use edit for exact string replacements in existing files.",
    "Use apply_patch for larger multi-hunk edits when possible.",
    "Use write_file only for new files or explicit full replacements.",
    "Run relevant tests or checks after edits when practical.",
    "For multi-step coding tasks, include a short `Plan:` section with 2-6 checklist or numbered items when it helps the user track the work.",
    "Use Arivu browser tools as hidden/background tools by default. Use visible browser mode only when the user explicitly asks to see a separate browser window.",
    "For screenshot or visual browser checks, prefer Chrome DevTools MCP through mcp_list_tools and mcp_call_tool when it is configured; fall back to browser_screenshot only when Chrome tooling is unavailable.",
    "To act on a page (click, type, fill, scroll, or select options), delegate to browser_task with a clear natural-language instruction; the low-level manual browser click/type/scroll tools are currently disabled.",
    "For current browser, latest page, active tab, or user-changed browser questions, call browser_state first, then inspect the active or intended tab with browser_screenshot in the same turn before answering. Do not answer from older browser evidence.",
    "Do not use emojis in assistant replies.",
    `The active workspace root is ${workspaceRoot}.`,
    `(Arivu system prompt v${SYSTEM_PROMPT_VERSION}.)`
  ].join("\n");
}

async function skillMessagesForNames(
  skillNames: string[],
  availableSkillNames: string[],
  alreadyLoadedSkillNames: Set<string>
): Promise<ChatMessage[]> {
  const available = new Set(availableSkillNames);
  const requested = Array.from(
    new Set(
      skillNames
        .map((name) => normalizeSkillRequestName(name))
        .filter((name): name is string => Boolean(name))
        .filter((name) => available.has(name))
        .filter((name) => !alreadyLoadedSkillNames.has(name))
    )
  );

  const messages = await Promise.all(
    requested.map(async (name) => {
      const skill = await readSkill(name);
      return {
        role: "system" as const,
        content: [`${LOADED_SKILL_PREFIX} ${skill.name}`, `Path: ${skill.path}`, skill.content].join("\n")
      };
    })
  );
  return messages;
}

async function skillMessagesForPrompt(
  prompt: ChatContent,
  availableSkillNames: string[],
  alreadyLoadedSkillNames = new Set<string>()
): Promise<ChatMessage[]> {
  const text = chatContentToText(prompt);
  const requested = new Set(
    Array.from(text.matchAll(/\$([a-zA-Z0-9._-]+)/g))
      .map((match) => match[1])
      .filter((name): name is string => Boolean(name) && availableSkillNames.includes(name))
      .filter((name) => !alreadyLoadedSkillNames.has(name))
  );

  const messages = await Promise.all(
    Array.from(requested).map(async (name) => {
      const skill = await readSkill(name);
      return {
        role: "system" as const,
        content: [`Skill attached: ${skill.name}`, `Path: ${skill.path}`, skill.content].join("\n")
      };
    })
  );
  return messages;
}

function normalizeSkillRequestName(value: string) {
  const name = value.trim().replace(/^[$/]+/, "");
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : "";
}

function loadedSkillNamesForSession(messages: ChatMessage[]) {
  return new Set(messages.map(loadedSkillNameFromMessage).filter((name): name is string => Boolean(name)));
}

function loadedSkillNameFromMessage(message: ChatMessage) {
  if (message.role !== "system") {
    return undefined;
  }
  const text = chatContentToText(message.content);
  const match = new RegExp(`^${escapeRegExp(LOADED_SKILL_PREFIX)}\\s+([^\\n]+)`).exec(text);
  return match?.[1]?.trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function taskRunIndexSnapshot(session: AgentSession) {
  return new Map((session.taskRuns ?? []).map((run) => [run.id, run.userMessageIndex]));
}

function shiftTaskRunMessageIndexes(session: AgentSession, insertionIndex: number, amount: number) {
  for (const run of session.taskRuns ?? []) {
    if (run.userMessageIndex >= insertionIndex) {
      run.userMessageIndex += amount;
    }
  }
}

function restoreTaskRunMessageIndexes(session: AgentSession, indexes: Map<string, number>) {
  for (const run of session.taskRuns ?? []) {
    const index = indexes.get(run.id);
    if (index !== undefined) {
      run.userMessageIndex = index;
    }
  }
}

function shouldRefreshBrowserEvidence(prompt: ChatContent, mode: "prompt" | "continue", messages: ChatMessage[]) {
  if (mode !== "prompt") {
    return false;
  }

  const text = chatContentToText(prompt).toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) {
    return false;
  }

  const hasBrowserSubject = /\b(browser|chrome|tab|tabs|website|web site|webpage|web page|portal)\b/.test(text);
  const hasCurrentPageSubject =
    /\b(current|latest|active|opened|open|visible|loaded)\s+(?:page|site)\b/.test(text) ||
    /\b(?:page|site)\s+(?:opened|open|visible|loaded)\b/.test(text);
  const browserTarget = "(?:browser|tab|tabs|website|web site|webpage|web page|portal)";
  const currentPageTarget = "(?:current|latest|active|opened|open|visible|loaded)\\s+(?:page|site)";
  const asksForCurrentBrowser =
    /\b(can you see|do you see|look at|what is on|what's on|what is in|what's in)\b/.test(text) ||
    new RegExp(`\\b(?:check|inspect)\\s+(?:the\\s+)?(?:current|latest|active|opened|open|visible|loaded)?\\s*${browserTarget}\\b`).test(
      text
    ) ||
    new RegExp(`\\b(?:check|inspect)\\s+(?:the\\s+)?${currentPageTarget}\\b`).test(text) ||
    /\b(current|latest|active|opened|open|visible|loaded)\s+(?:browser|tab|page|website|web site|webpage|web page|site|portal)\b/.test(
      text
    ) ||
    /\b(?:browser|tab|page|website|web site|webpage|web page|site|portal)\s+(?:opened|open|visible|loaded)\b/.test(text);
  if ((hasBrowserSubject || hasCurrentPageSubject) && asksForCurrentBrowser) {
    return true;
  }

  const browserTaskContinuation =
    /\b(logged in|i have logged|i'm logged|login|continue|proceed|done|fire up|request instance|open instance|instance)\b/.test(text);
  // These continuation words are noisy, so gate the synthetic refresh on there being recent browser
  // activity and on not having already spent a synthetic refresh in the last few messages.
  return browserTaskContinuation && hasRecentBrowserActivity(messages) && !hasRecentSyntheticBrowserRefresh(messages);
}

function hasRecentBrowserActivity(messages: ChatMessage[]) {
  return messages.slice(-16).some((message) => {
    if (message.role === "tool" && message.name?.startsWith("browser_")) {
      return true;
    }
    return message.toolCalls?.some((call) => call.name.startsWith("browser_")) ?? false;
  });
}

function hasRecentSyntheticBrowserRefresh(messages: ChatMessage[]) {
  return messages
    .slice(-8)
    .some(
      (message) =>
        message.role === "tool" &&
        (message.toolCallId?.startsWith(`${BROWSER_STATE_TOOL}_`) === true ||
          message.toolCallId?.startsWith(`${BROWSER_SCREENSHOT_TOOL}_`) === true)
    );
}

async function refreshBrowserEvidence(
  tools: { execute(name: string, args: unknown): Promise<string> },
  runOptions: AgentRunOptions,
  messages: ChatMessage[]
) {
  const stateResult = await executeSyntheticToolCall(tools, runOptions, messages, {
    id: syntheticToolCallId(BROWSER_STATE_TOOL),
    name: BROWSER_STATE_TOOL,
    arguments: {}
  });
  // If reading state failed, do not spend a second synthetic call chasing a screenshot.
  if (isToolErrorResult(stateResult)) {
    return;
  }
  await executeSyntheticToolCall(tools, runOptions, messages, {
    id: syntheticToolCallId(BROWSER_SCREENSHOT_TOOL),
    name: BROWSER_SCREENSHOT_TOOL,
    arguments: browserScreenshotArgsFromStateResult(stateResult)
  });
}

function isToolErrorResult(result: string) {
  return result.startsWith("Error:");
}

async function executeSyntheticToolCall(
  tools: { execute(name: string, args: unknown): Promise<string> },
  runOptions: AgentRunOptions,
  messages: ChatMessage[],
  call: ToolCall
) {
  messages.push({ role: "assistant", content: "", toolCalls: [call] });
  await runOptions.onEvent?.({ type: "tool_call", call });
  const result = await tools.execute(call.name, call.arguments);
  await runOptions.onEvent?.({
    type: "tool_result",
    toolCallId: call.id,
    name: call.name,
    result
  });
  messages.push({
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: result
  });
  return result;
}

function syntheticToolCallId(name: string) {
  return `${name}_${crypto.randomUUID()}`;
}

function browserScreenshotArgsFromStateResult(result: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const state = parseJsonRecord(result);
  const activeMode = stringField(state, "activeMode");
  if (activeMode === "visible") {
    args.mode = "visible";
    const visible = recordField(state, "visible");
    const tabId = stringField(visible, "activeTabId") ?? stringField(visible, "id") ?? firstBrowserTabId(visible);
    if (tabId) {
      args.tabId = tabId;
    }
  } else if (activeMode === "background") {
    args.mode = "background";
  }
  return args;
}

function parseJsonRecord(value: string) {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function recordField(record: Record<string, unknown> | undefined, key: string) {
  return asRecord(record?.[key]);
}

function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function firstBrowserTabId(record: Record<string, unknown> | undefined) {
  const tabs = record?.tabs;
  if (!Array.isArray(tabs)) {
    return undefined;
  }
  return tabs
    .map(asRecord)
    .map((tab) => stringField(tab, "id"))
    .find((id): id is string => Boolean(id));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function hasTool(tools: ChatRequest["tools"], name: string) {
  return tools.some((tool) => tool.name === name);
}

async function resolveDisabledToolNames(source: AgentRunOptions["disabledToolNames"]): Promise<Set<string>> {
  if (!source) {
    return new Set();
  }
  return new Set(typeof source === "function" ? await source() : source);
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw new AgentRunAbortedError();
  }
}

function isParallelSafeTool(name: string) {
  return PARALLEL_SAFE_TOOLS.has(name);
}

/** Share of a model's real context window the request may occupy before transient compaction. */
export const CONTEXT_BUDGET_FRACTION = 0.9;
/** Never leave the model less than this much room to answer, however small its window is. */
const MIN_RESPONSE_RESERVE_TOKENS = 1_024;
const MIN_REQUEST_TOKEN_LIMIT = 2_000;

/**
 * Converts a model's context window into the request-token budget that triggers transient compaction.
 *
 * The reserve is a clamp, not a floor. The previous `Math.max(4_000, …)` floor inverted the intent:
 * on a 4,096-token model it produced a 4,000-token budget — 97.6% of the window, leaving ~96 tokens
 * to answer with. Taking `min(fraction, window - reserve)` instead means the fraction is honored on
 * every real-world window and only tightens where the fraction is physically unsafe (below ~10k).
 */
function requestTokenLimitForContextWindow(contextWindowTokens: number | undefined): number | undefined {
  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return undefined;
  }
  const budget = Math.min(Math.floor(contextWindowTokens * CONTEXT_BUDGET_FRACTION), contextWindowTokens - MIN_RESPONSE_RESERVE_TOKENS);
  return Math.max(MIN_REQUEST_TOKEN_LIMIT, budget);
}

const SUMMARY_INSTRUCTION = [
  "You are compacting a coding-assistant conversation to free up context.",
  "Summarize the transcript below into a concise brief that preserves everything needed to continue the work:",
  "the user's goals and constraints, decisions made, files and commands touched, current state, and any open TODOs or blockers.",
  "Prefer a short set of bullet points over prose. Do not invent details or add commentary; only summarize what is present."
].join(" ");

function summaryTranscript(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === "tool") {
        return `Tool ${message.name ?? "result"}: ${chatContentToText(message.content)}`;
      }
      const text = chatContentToText(message.content).trim();
      const toolCalls = message.toolCalls?.length ? `\n[tool calls: ${message.toolCalls.map((call) => call.name).join(", ")}]` : "";
      const role = message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System";
      return `${role}: ${text}${toolCalls}`;
    })
    .join("\n\n");
}

function messagesForStep(
  messages: ChatMessage[],
  webSearchCalls: number,
  skillInstructions: Array<ChatMessage | undefined>
): ChatMessage[] {
  const transientInstructions = [...skillInstructions, webSearchInstruction(webSearchCalls)].filter((message): message is ChatMessage =>
    Boolean(message)
  );
  if (transientInstructions.length === 0) {
    return messages;
  }

  const firstNonSystem = messages.findIndex((message) => message.role !== "system");
  if (firstNonSystem === -1) {
    return [...messages, ...transientInstructions];
  }
  return [...messages.slice(0, firstNonSystem), ...transientInstructions, ...messages.slice(firstNonSystem)];
}

function toolMimicryInstruction(mimicryRetries: number): ChatMessage | undefined {
  if (mimicryRetries === 0) {
    return undefined;
  }

  return {
    role: "system",
    content: [
      'Your previous reply wrote a tool invocation as plain text (a "Local tool request:" block or <tool_call>/<function=...> template syntax). Text like that executes nothing and may have been truncated.',
      "Invoke the tool now with a real native tool call. Do not describe or narrate the call in text."
    ].join("\n")
  };
}

function webSearchInstruction(webSearchCalls: number): ChatMessage | undefined {
  if (webSearchCalls === 0) {
    return undefined;
  }

  return {
    role: "system",
    content: [
      "You already have web_search results for this user request.",
      "Answer now using those results and cite source names or URLs when relevant.",
      "Do not call web_search again for this request."
    ].join("\n")
  };
}

/**
 * Tool JSON-Schemas ride along on every request but are not part of `messages`, so the compaction
 * estimate never saw them. The old 40% headroom absorbed that silently; a 90% budget does not, so
 * they are charged against the budget explicitly. Same chars/4 heuristic the message estimator uses.
 */
function estimateToolSchemaTokens(tools: ChatRequest["tools"]): number {
  if (!tools || tools.length === 0) {
    return 0;
  }
  return Math.ceil(JSON.stringify(tools).length / 4);
}

function compactChatRequestForModel(request: ChatRequest, mode: "default" | "aggressive" = "default", tokenLimit?: number): ChatRequest {
  // Only chargeable against a real, known window. Leaving `undefined` alone preserves the
  // conservative 48k default that compactMessagesForModelRequest applies for unknown models.
  const messageTokenLimit =
    tokenLimit === undefined ? undefined : Math.max(MIN_REQUEST_TOKEN_LIMIT, tokenLimit - estimateToolSchemaTokens(request.tools));
  const result = compactMessagesForModelRequest(
    request.messages,
    mode === "aggressive"
      ? {
          force: true,
          recentMessageCount: 4,
          entryCharacterLimit: 350,
          recentEntryCharacterLimit: 3_000,
          activeUserMessageCharacterLimit: 16_000,
          tokenLimit: messageTokenLimit
        }
      : { tokenLimit: messageTokenLimit }
  );
  if (!result.compacted) {
    return request;
  }
  return {
    ...request,
    messages: result.messages
  };
}

function isContextLengthError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /(maximum context length|context length|reduce the length of the messages|too many tokens|exceeded[^.]*token|messages resulted in \d+ tokens)/i.test(
    message
  );
}

function allowedToolCalls(toolCalls: ChatMessage["toolCalls"], availableTools: ChatRequest["tools"]) {
  if (!toolCalls || toolCalls.length === 0) {
    return toolCalls;
  }
  const available = new Set(availableTools.map((tool) => tool.name));
  return toolCalls.filter((call) => available.has(call.name));
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: typeof message.content === "string" ? message.content : structuredClone(message.content),
    toolCalls: message.toolCalls?.map((call) => ({ ...call }))
  }));
}

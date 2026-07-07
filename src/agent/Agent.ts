import crypto from "node:crypto";
import type { ApprovalManager } from "../permissions/ApprovalManager.js";
import { createToolRegistry } from "../tools/registry.js";
import type { BrowserToolController } from "../tools/browserControl.js";
import { detectWorkspace } from "../workspace.js";
import { chatContentToText, trimChatContent, type ChatContent } from "./content.js";
import { compactMessagesForModelRequest } from "./contextCompaction.js";
import { discoverSkills, readSkill, skillsSystemMessage } from "./skills.js";
import type { AgentRunOptions, AgentSession, ChatClient, ChatMessage, ChatRequest, ChatResponse, ToolCall } from "./types.js";
import type { AppConfig } from "../config.js";

const MAX_STEPS = 20;
const WEB_SEARCH_TOOL = "web_search";
const BROWSER_STATE_TOOL = "browser_state";
const BROWSER_SNAPSHOT_TOOL = "browser_snapshot";
const LOADED_SKILL_PREFIX = "Skill loaded into chat:";

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
      directEditReview?: boolean;
      session?: AgentSession;
    }
  ) {
    this.session = options.session ?? createSession(options.cwd, options.projectRoot, options.approvals.mode, options.model, options.baseUrl);
  }

  async run(prompt: ChatContent, runOptions: AgentRunOptions = {}): Promise<{ output: string; session: AgentSession }> {
    return this.runWithPreparedSession(prompt, runOptions, "prompt");
  }

  async continue(runOptions: AgentRunOptions = {}): Promise<{ output: string; session: AgentSession }> {
    return this.runWithPreparedSession("", runOptions, "continue");
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
      directEditReview: this.options.directEditReview
    });

    const existingSystem = this.session.messages.find(
      (message) => message.role === "system" && chatContentToText(message.content).includes("You are Arivu")
    );
    if (!existingSystem) {
      this.session.messages.unshift({
        role: "system",
        content: systemPrompt(workspace.root)
      });
      shiftTaskRunMessageIndexes(this.session, 0, 1);
    } else {
      const existingSystemContent = chatContentToText(existingSystem.content);
      const additions = [
        !existingSystemContent.includes("Do not use emojis in assistant replies.") ? "Do not use emojis in assistant replies." : "",
        !existingSystemContent.includes("Use current_datetime for exact local date or time questions.")
          ? "Use current_datetime for exact local date or time questions."
          : "",
        !existingSystemContent.includes("Use current_location for approximate timezone-level location context")
          ? "Use current_location for approximate timezone-level location context; do not treat it as GPS or IP-based location."
          : "",
        !existingSystemContent.includes("Use visible browser mode only when the user explicitly asks to see a separate browser window.")
          ? "Use Arivu browser tools as hidden/background tools by default. Use visible browser mode only when the user explicitly asks to see a separate browser window."
          : "",
        !existingSystemContent.includes("For screenshot or visual browser checks, prefer Chrome DevTools MCP")
          ? "For screenshot or visual browser checks, prefer Chrome DevTools MCP through mcp_list_tools and mcp_call_tool when it is configured; fall back to browser_screenshot only when Chrome tooling is unavailable."
          : "",
        !existingSystemContent.includes("If browser_snapshot is empty but browser_screenshot returns visual elements")
          ? "If browser_snapshot is empty but browser_screenshot returns visual elements or a usable screenshot, continue with browser_click or browser_click_at; do not conclude the page is unloaded solely from an empty snapshot."
          : "",
        !existingSystemContent.includes("For current browser, latest page, active tab, or user-changed browser questions")
          ? "For current browser, latest page, active tab, or user-changed browser questions, call browser_state first, then inspect the active or intended tab with browser_snapshot or browser_screenshot in the same turn before answering. Do not answer from older browser evidence."
          : ""
      ].filter(Boolean);
      if (additions.length > 0) {
        existingSystem.content = `${existingSystemContent}\n${additions.join("\n")}`;
      }
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

    const attachedSkillMessages =
      mode === "prompt" ? await skillMessagesForPrompt(prompt, availableSkillNames, loadedSkillNames) : [];
    if (mode === "prompt" && !promptAlreadyInSession) {
      this.session.messages.push({ role: "user", content: trimChatContent(prompt) });
    }

    try {
      let webSearchCalls = 0;

      const allowedToolNames = runOptions.allowedToolNames ? new Set(runOptions.allowedToolNames) : undefined;
      const toolSchemas = allowedToolNames ? tools.schemas.filter((tool) => allowedToolNames.has(tool.name)) : tools.schemas;
      if (
        shouldRefreshBrowserEvidence(prompt, mode, this.session.messages) &&
        hasTool(toolSchemas, BROWSER_STATE_TOOL) &&
        hasTool(toolSchemas, BROWSER_SNAPSHOT_TOOL)
      ) {
        await refreshBrowserEvidence(tools, runOptions, this.session.messages);
      }

      for (let step = 0; step < MAX_STEPS; step += 1) {
        const availableTools = webSearchCalls > 0 ? [] : toolSchemas;
        const response = await this.complete({
          messages: messagesForStep(this.session.messages, webSearchCalls, [skillInstruction, ...attachedSkillMessages]),
          tools: availableTools
        }, runOptions);
        const toolCalls = allowedToolCalls(response.message.toolCalls, availableTools);
        const message = toolCalls === response.message.toolCalls ? response.message : { ...response.message, toolCalls };
        this.session.messages.push(message);

        if (!toolCalls || toolCalls.length === 0) {
          const output = chatContentToText(message.content);
          if (output.trim().length === 0) {
            throw new Error("Model returned an empty assistant response without tool calls.");
          }
          this.touch();
          return {
            output,
            session: this.session
          };
        }

        for (const call of toolCalls) {
          await runOptions.onEvent?.({ type: "tool_call", call });
          const result = await tools.execute(call.name, call.arguments);
          await runOptions.onEvent?.({
            type: "tool_result",
            toolCallId: call.id,
            name: call.name,
            result
          });
          this.session.messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: result
          });
          if (call.name === WEB_SEARCH_TOOL) {
            webSearchCalls += 1;
          }
        }
      }

      const output = "Stopped after reaching the maximum tool-call depth.";
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

  private async complete(request: ChatRequest, runOptions: AgentRunOptions): Promise<ChatResponse> {
    const compactedRequest = compactChatRequestForModel(request);
    try {
      return await this.completeOnce(compactedRequest, runOptions);
    } catch (error) {
      if (!isContextLengthError(error)) {
        throw error;
      }
      return this.completeOnce(compactChatRequestForModel(request, "aggressive"), runOptions);
    }
  }

  private async completeOnce(request: ChatRequest, runOptions: AgentRunOptions): Promise<ChatResponse> {
    if (!this.options.client.stream) {
      return this.options.client.complete(request);
    }

    return this.options.client.stream(request, async (event) => {
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
    });
  }

  private touch() {
    this.session.updatedAt = new Date().toISOString();
  }
}

function createSession(cwd: string, projectRoot: string | null | undefined, trustMode: AgentSession["trustMode"], model?: string, baseUrl?: string): AgentSession {
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
    "Use apply_patch for existing-file edits when possible.",
    "Use write_file only for new files or explicit full replacements.",
    "Run relevant tests or checks after edits when practical.",
    "For multi-step coding tasks, include a short `Plan:` section with 2-6 checklist or numbered items when it helps the user track the work.",
    "Use Arivu browser tools as hidden/background tools by default. Use visible browser mode only when the user explicitly asks to see a separate browser window.",
    "For screenshot or visual browser checks, prefer Chrome DevTools MCP through mcp_list_tools and mcp_call_tool when it is configured; fall back to browser_screenshot only when Chrome tooling is unavailable.",
    "If browser_snapshot is empty but browser_screenshot returns visual elements or a usable screenshot, continue with browser_click or browser_click_at; do not conclude the page is unloaded solely from an empty snapshot.",
    "For current browser, latest page, active tab, or user-changed browser questions, call browser_state first, then inspect the active or intended tab with browser_snapshot or browser_screenshot in the same turn before answering. Do not answer from older browser evidence.",
    "Do not use emojis in assistant replies.",
    `The active workspace root is ${workspaceRoot}.`
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
    /\b(current|latest|active|opened|open|visible|loaded)\s+(?:browser|tab|page|website|web site|webpage|web page|site|portal)\b/.test(text) ||
    /\b(?:browser|tab|page|website|web site|webpage|web page|site|portal)\s+(?:opened|open|visible|loaded)\b/.test(text);
  if ((hasBrowserSubject || hasCurrentPageSubject) && asksForCurrentBrowser) {
    return true;
  }

  const browserTaskContinuation = /\b(logged in|i have logged|i'm logged|login|continue|proceed|done|fire up|request instance|open instance|instance)\b/.test(
    text
  );
  return browserTaskContinuation && hasRecentBrowserActivity(messages);
}

function hasRecentBrowserActivity(messages: ChatMessage[]) {
  return messages.slice(-16).some((message) => {
    if (message.role === "tool" && message.name?.startsWith("browser_")) {
      return true;
    }
    return message.toolCalls?.some((call) => call.name.startsWith("browser_")) ?? false;
  });
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
  await executeSyntheticToolCall(tools, runOptions, messages, {
    id: syntheticToolCallId(BROWSER_SNAPSHOT_TOOL),
    name: BROWSER_SNAPSHOT_TOOL,
    arguments: browserSnapshotArgsFromStateResult(stateResult)
  });
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

function browserSnapshotArgsFromStateResult(result: string): Record<string, unknown> {
  const args: Record<string, unknown> = { maxLength: 12_000 };
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
  return tabs.map(asRecord).map((tab) => stringField(tab, "id")).find((id): id is string => Boolean(id));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function hasTool(tools: ChatRequest["tools"], name: string) {
  return tools.some((tool) => tool.name === name);
}

function messagesForStep(messages: ChatMessage[], webSearchCalls: number, skillInstructions: Array<ChatMessage | undefined>): ChatMessage[] {
  const transientInstructions = [...skillInstructions, webSearchInstruction(webSearchCalls)].filter(
    (message): message is ChatMessage => Boolean(message)
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

function compactChatRequestForModel(request: ChatRequest, mode: "default" | "aggressive" = "default"): ChatRequest {
  const result = compactMessagesForModelRequest(
    request.messages,
    mode === "aggressive"
      ? {
          force: true,
          recentMessageCount: 4,
          entryCharacterLimit: 350,
          recentEntryCharacterLimit: 3_000
        }
      : undefined
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

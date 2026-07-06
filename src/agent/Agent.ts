import crypto from "node:crypto";
import type { ApprovalManager } from "../permissions/ApprovalManager.js";
import { createToolRegistry } from "../tools/registry.js";
import type { BrowserToolController } from "../tools/browserControl.js";
import { detectWorkspace } from "../workspace.js";
import { chatContentToText, trimChatContent, type ChatContent } from "./content.js";
import { discoverSkills, readSkill, skillsSystemMessage } from "./skills.js";
import type { AgentRunOptions, AgentSession, ChatClient, ChatMessage, ChatRequest, ChatResponse } from "./types.js";
import type { AppConfig } from "../config.js";

const MAX_STEPS = 20;
const WEB_SEARCH_TOOL = "web_search";
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
      this.session.messages.splice(promptIndex >= 0 ? promptIndex : this.session.messages.length, 0, message);
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
          this.touch();
          return {
            output: chatContentToText(message.content),
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
      throw error;
    }
  }

  private async complete(request: ChatRequest, runOptions: AgentRunOptions): Promise<ChatResponse> {
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

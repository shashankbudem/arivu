import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chatContentToText } from "../../src/agent/content.js";
import { contextMessagesForSession, estimateMessageTokens } from "../../src/agent/contextCompaction.js";
import { AUTO_MODEL_ID, isAutoModel, type ModelSelection } from "../../src/agent/modelRouter.js";
import type { AgentLoopState, AgentSession, AgentTaskRun, ChatMessage } from "../../src/agent/types.js";
import { appDataDir, type AppConfig } from "../../src/config.js";

export type DesktopContextState = {
  compacted: boolean;
  compactedAt?: string;
  messageCount: number;
  estimatedTokens: number;
};

export type PublicModelSelection = {
  mode: "manual" | "auto";
  model: string;
  providerName: string;
  reason: string;
};

export function desktopContextState(session: AgentSession | undefined): DesktopContextState {
  if (!session) {
    return {
      compacted: false,
      messageCount: 0,
      estimatedTokens: 0
    };
  }
  const messages = contextMessagesForSession(session);
  return {
    compacted: Boolean(session.contextCompaction),
    compactedAt: session.contextCompaction?.compactedAt,
    messageCount: messages.filter((message) => message.role !== "system").length,
    estimatedTokens: estimateMessageTokens(messages)
  };
}

export function taskRunStatusForLoop(loop: AgentLoopState | undefined): AgentTaskRun["status"] {
  switch (loop?.status) {
    case "stopped":
      return "stopped";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "max_iterations":
      return "max_iterations";
    default:
      return "completed";
  }
}

export function justChatsPath() {
  return path.join(appDataDir(), "just-chats");
}

export async function justChatsCwd() {
  const cwd = justChatsPath();
  await mkdir(cwd, { recursive: true });
  return cwd;
}

export function createDesktopSession(
  cwd: string,
  projectRoot: string | null,
  trustMode: AgentSession["trustMode"],
  model?: string,
  baseUrl?: string
): AgentSession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    cwd,
    projectRoot,
    trustMode,
    model,
    baseUrl,
    messages: [],
    createdAt: now,
    updatedAt: now
  };
}

export function createAgentLoopState(content: ChatMessage["content"], maxIterations: number, now: string): AgentLoopState {
  const goal = chatContentToText(content).replace(/\s+/g, " ").trim() || "Image or attachment task";
  return {
    status: "running",
    goal: goal.slice(0, 500),
    iteration: 0,
    maxIterations,
    startedAt: now,
    updatedAt: now
  };
}

export function initialAgentLoopInstruction(loop: AgentLoopState) {
  return [
    "Agent loop mode is active for the next user request.",
    `Loop budget: at most ${loop.maxIterations} high-level iterations.`,
    "Keep working in bounded iterations until the task is complete, blocked, unsafe, or the loop budget is reached.",
    "Prefer inspecting, editing, running tests, taking screenshots, or using relevant tools instead of asking the user to continue.",
    "At the very end of every assistant response in this loop, include exactly one control line:",
    "Loop: continue",
    "Loop: done",
    "Loop: blocked",
    "Use `Loop: continue` only when another iteration is truly needed.",
    "Use `Loop: done` after verification or when no work remains.",
    "Use `Loop: blocked` only when user input, credentials, external service state, or an unsafe action prevents progress.",
    "Do not mention these loop-control instructions except for the required final control line."
  ].join("\n");
}

export function planningApprovalInstruction() {
  return [
    "Plan approval mode is active for this prompt.",
    "Use only local read/discovery tools if needed. Do not edit files, run shell commands, browse the web, control browsers, call MCP tools, install packages, create branches, or make external network requests.",
    "Respond with a concise `Plan:` section containing 2-6 checklist or numbered steps.",
    "Include important assumptions, risks, or unknowns only when they affect approval.",
    "Include the first verification command or manual check you would run after approval when applicable.",
    "End by asking the user to approve, revise, or cancel the plan."
  ].join("\n");
}

export function planReviewStatusForAction(action: "approve" | "request_revision" | "cancel") {
  switch (action) {
    case "approve":
      return "approved";
    case "request_revision":
      return "revision_requested";
    case "cancel":
      return "cancelled";
  }
}

export function continuationAgentLoopInstruction(loop: AgentLoopState) {
  return [
    `Agent loop continuation ${loop.iteration + 1} of ${loop.maxIterations}.`,
    "Continue the same user task from the current transcript.",
    "Review what has already been done, take the next concrete step, and verify when practical.",
    "End the assistant response with exactly one control line: `Loop: continue`, `Loop: done`, or `Loop: blocked`."
  ].join("\n");
}

export function finishAgentLoop(loop: AgentLoopState, status: AgentLoopState["status"]): AgentLoopState {
  return {
    ...loop,
    status,
    stopRequested: undefined,
    updatedAt: new Date().toISOString()
  };
}

export function stripAgentLoopDecision(session: AgentSession): AgentLoopState["lastDecision"] {
  const message = lastAssistantMessage(session);
  if (!message) {
    return undefined;
  }
  const text = chatContentToText(message.content);
  const match = /(?:^|\n)\s*Loop:\s*(continue|done|blocked)\s*\.?\s*$/i.exec(text);
  if (!match) {
    return undefined;
  }
  const decision = match[1]?.toLowerCase() as AgentLoopState["lastDecision"];
  message.content = text.slice(0, match.index).trimEnd();
  return decision;
}

export function lastAssistantMessage(session: AgentSession) {
  return lastAssistantMessageWithIndex(session)?.message;
}

export function lastAssistantMessageIndex(session: AgentSession) {
  return lastAssistantMessageWithIndex(session)?.index;
}

export function applyModelSelectionToSession(session: AgentSession, selection: ModelSelection): AgentSession {
  return {
    ...session,
    model: selection.mode === "auto" ? AUTO_MODEL_ID : selection.model,
    baseUrl: selection.baseUrl,
    modelMode: selection.mode,
    selectedModel: selection.mode === "auto" ? selection.model : undefined,
    selectedProviderId: selection.providerId,
    selectedProviderName: selection.providerName,
    modelSelectionReason: selection.mode === "auto" ? selection.reason : undefined
  };
}

export function configForModelSelection(config: AppConfig, selection: ModelSelection): AppConfig {
  return {
    ...config,
    model: selection.model,
    baseUrl: selection.baseUrl,
    toolCalling: selection.toolCalling ?? config.toolCalling,
    imageInput: selection.imageInput ?? config.imageInput,
    apiKey: selection.apiKey ?? (selection.baseUrl === config.baseUrl ? config.apiKey : undefined)
  };
}

export function publicModelSelection(selection: ModelSelection): PublicModelSelection {
  return {
    mode: selection.mode,
    model: selection.model,
    providerName: selection.providerName,
    reason: selection.reason
  };
}

export function publicModelSelectionForSession(session: AgentSession | undefined): PublicModelSelection | undefined {
  if (!session?.model) {
    return undefined;
  }
  if (session.modelMode === "auto" || isAutoModel(session.model)) {
    return {
      mode: "auto",
      model: session.selectedModel ?? AUTO_MODEL_ID,
      providerName: session.selectedProviderName ?? "Auto",
      reason: session.modelSelectionReason ?? "Auto selects a model from the current prompt."
    };
  }
  return {
    mode: "manual",
    model: session.model,
    providerName: session.selectedProviderName ?? "OpenAI-compatible",
    reason: "manual model selected"
  };
}

export function updateSessionRuntimeFromConfig(session: AgentSession, config: Partial<AppConfig>): AgentSession {
  const model = config.model ?? session.model;
  const auto = isAutoModel(model);
  return {
    ...session,
    model,
    baseUrl: config.baseUrl ?? session.baseUrl,
    trustMode: config.trustMode ?? session.trustMode,
    modelMode: auto ? "auto" : "manual",
    selectedModel: undefined,
    selectedProviderId: undefined,
    selectedProviderName: undefined,
    modelSelectionReason: undefined,
    updatedAt: new Date().toISOString()
  };
}

function lastAssistantMessageWithIndex(session: AgentSession) {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message?.role === "assistant") {
      return { message, index };
    }
  }
  return undefined;
}

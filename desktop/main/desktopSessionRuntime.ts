import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { contextMessagesForSession, estimateMessageTokens } from "../../src/agent/contextCompaction.js";
import { AUTO_MODEL_ID, isAutoModel, type ModelSelection } from "../../src/agent/modelRouter.js";
import type { AgentLoopState, AgentSession, AgentTaskRun, ChatMessage } from "../../src/agent/types.js";
import { appDataDir } from "../../src/config.js";
import {
  createAgentLoopState as sharedCreateAgentLoopState,
  finishAgentLoop as sharedFinishAgentLoop,
  stripAgentLoopDecision as sharedStripAgentLoopDecision
} from "../../src/harness/agentLoop.js";
export { continuationAgentLoopInstruction, initialAgentLoopInstruction, planningApprovalInstruction } from "../../src/harness/agentLoop.js";
export { applyModelSelectionToSession, configForModelSelection, updateSessionRuntimeFromConfig } from "../../src/harness/sessionRuntime.js";

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
  return sharedCreateAgentLoopState(content, maxIterations, now);
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

export function finishAgentLoop(loop: AgentLoopState, status: AgentLoopState["status"]): AgentLoopState {
  return sharedFinishAgentLoop(loop, status);
}

export function stripAgentLoopDecision(session: AgentSession): AgentLoopState["lastDecision"] {
  return sharedStripAgentLoopDecision(session);
}

export function lastAssistantMessage(session: AgentSession) {
  return lastAssistantMessageWithIndex(session)?.message;
}

export function lastAssistantMessageIndex(session: AgentSession) {
  return lastAssistantMessageWithIndex(session)?.index;
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

function lastAssistantMessageWithIndex(session: AgentSession) {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message?.role === "assistant") {
      return { message, index };
    }
  }
  return undefined;
}

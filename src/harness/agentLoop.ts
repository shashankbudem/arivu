import { chatContentToText, type ChatContent } from "../agent/content.js";
import type { AgentLoopState, AgentSession } from "../agent/types.js";
import { beginAgentLoopIteration, finishAgentLoopIteration } from "../agent/taskRuns.js";

export function createAgentLoopState(content: ChatContent, maxIterations: number, now = new Date().toISOString()): AgentLoopState {
  return {
    status: "running",
    goal: (chatContentToText(content).replace(/\s+/g, " ").trim() || "Task").slice(0, 500),
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

export function continuationAgentLoopInstruction(loop: AgentLoopState) {
  return [
    `Agent loop continuation ${loop.iteration + 1} of ${loop.maxIterations}.`,
    "Continue the same user task from the current transcript.",
    "Review what has already been done, take the next concrete step, and verify when practical.",
    "End the assistant response with exactly one control line: `Loop: continue`, `Loop: done`, or `Loop: blocked`."
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

export function finishAgentLoop(loop: AgentLoopState, status: AgentLoopState["status"]): AgentLoopState {
  return { ...loop, status, stopRequested: undefined, updatedAt: new Date().toISOString() };
}

export function stripAgentLoopDecision(session: AgentSession): AgentLoopState["lastDecision"] {
  const message = [...session.messages].reverse().find((entry) => entry.role === "assistant");
  if (!message) return undefined;
  const text = chatContentToText(message.content);
  const match = /(?:^|\n)\s*Loop:\s*(continue|done|blocked)\s*\.?\s*$/i.exec(text);
  if (!match) return undefined;
  message.content = text.slice(0, match.index).trimEnd();
  return match[1]!.toLowerCase() as AgentLoopState["lastDecision"];
}

export { beginAgentLoopIteration, finishAgentLoopIteration };

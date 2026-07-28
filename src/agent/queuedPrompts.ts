import type { AgentSession, ChatMessage, QueuedPrompt } from "./types.js";

export const MAX_QUEUED_PROMPTS = 50;

export function enqueuePrompt(session: AgentSession, prompt: QueuedPrompt): void {
  const queuedPrompts = session.queuedPrompts ?? [];
  if (queuedPrompts.length >= MAX_QUEUED_PROMPTS) {
    throw new Error(`A chat can queue at most ${MAX_QUEUED_PROMPTS} messages.`);
  }
  session.queuedPrompts = [...queuedPrompts, prompt];
}

export function markPromptForSteering(session: AgentSession, promptId: string): QueuedPrompt {
  const queuedPrompts = session.queuedPrompts ?? [];
  const index = queuedPrompts.findIndex((prompt) => prompt.id === promptId);
  if (index < 0) {
    throw new Error("Queued message was not found.");
  }
  const prompt = queuedPrompts[index]!;
  const steeringPrompt: QueuedPrompt = { ...prompt, state: "steering" };
  session.queuedPrompts = queuedPrompts.map((entry, entryIndex) => (entryIndex === index ? steeringPrompt : entry));
  return steeringPrompt;
}

export function takeSteeringMessages(session: AgentSession): ChatMessage[] {
  const queuedPrompts = session.queuedPrompts ?? [];
  const steeringPrompts = queuedPrompts.filter((prompt) => prompt.state === "steering");
  if (steeringPrompts.length === 0) {
    return [];
  }
  const steeringIds = new Set(steeringPrompts.map((prompt) => prompt.id));
  session.queuedPrompts = queuedPrompts.filter((prompt) => !steeringIds.has(prompt.id));
  return steeringPrompts.map((prompt) => ({
    role: "user",
    content: prompt.content,
    createdAt: prompt.createdAt
  }));
}

export function takeNextQueuedPrompt(session: AgentSession): QueuedPrompt | undefined {
  const prompt = session.queuedPrompts?.[0];
  if (!prompt) {
    return undefined;
  }
  session.queuedPrompts = session.queuedPrompts?.slice(1);
  return prompt;
}

export function restoreQueuedPrompt(session: AgentSession, prompt: QueuedPrompt): void {
  session.queuedPrompts = [prompt, ...(session.queuedPrompts ?? [])];
}

import { describe, expect, it } from "vitest";
import {
  enqueuePrompt,
  markPromptForSteering,
  MAX_QUEUED_PROMPTS,
  restoreQueuedPrompt,
  takeNextQueuedPrompt,
  takeSteeringMessages
} from "../src/agent/queuedPrompts.js";
import type { AgentSession, QueuedPrompt } from "../src/agent/types.js";

function session(): AgentSession {
  return {
    id: "session-1",
    cwd: "/tmp/project",
    trustMode: "ask",
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function prompt(id: string, state: QueuedPrompt["state"] = "queued"): QueuedPrompt {
  return {
    id,
    content: `message ${id}`,
    state,
    createdAt: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`
  };
}

describe("queued prompts", () => {
  it("keeps FIFO order and can restore a prompt after a failed start", () => {
    const target = session();
    enqueuePrompt(target, prompt("1"));
    enqueuePrompt(target, prompt("2"));

    const first = takeNextQueuedPrompt(target);
    expect(first?.id).toBe("1");
    expect(target.queuedPrompts?.map((entry) => entry.id)).toEqual(["2"]);

    restoreQueuedPrompt(target, first!);
    expect(target.queuedPrompts?.map((entry) => entry.id)).toEqual(["1", "2"]);
  });

  it("drains only messages marked for steering and preserves their timestamps", () => {
    const target = session();
    enqueuePrompt(target, prompt("1"));
    enqueuePrompt(target, prompt("2"));
    enqueuePrompt(target, prompt("3"));
    markPromptForSteering(target, "2");

    expect(takeSteeringMessages(target)).toEqual([
      {
        role: "user",
        content: "message 2",
        createdAt: "2026-01-01T00:00:02.000Z"
      }
    ]);
    expect(target.queuedPrompts?.map((entry) => entry.id)).toEqual(["1", "3"]);
  });

  it("enforces the per-chat queue limit", () => {
    const target = session();
    for (let index = 0; index < MAX_QUEUED_PROMPTS; index += 1) {
      enqueuePrompt(target, prompt(String(index)));
    }

    expect(() => enqueuePrompt(target, prompt("overflow"))).toThrow(`A chat can queue at most ${MAX_QUEUED_PROMPTS} messages.`);
  });
});

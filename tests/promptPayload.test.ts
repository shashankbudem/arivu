import { describe, expect, it } from "vitest";
import {
  normalizePromptLoopOptions,
  normalizePromptPayload,
  normalizePromptPlanOptions,
  normalizePromptReuseLastUserMessage,
  normalizePromptSkillNames,
  normalizePromptWorktreeOptions
} from "../src/agent/promptPayload.js";

describe("prompt payload normalization", () => {
  it("accepts legacy raw string prompts", () => {
    expect(normalizePromptPayload("  hello  ")).toBe("hello");
  });

  it("accepts rich content payloads from the renderer", () => {
    expect(
      normalizePromptPayload({
        content: [
          { type: "text", text: "  describe this  " },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "low" },
            name: "diagram.png",
            mimeType: "image/png",
            size: 5
          }
        ]
      })
    ).toEqual([
      { type: "text", text: "describe this" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "low" },
        name: "diagram.png",
        mimeType: "image/png",
        size: 5
      }
    ]);
  });

  it("accepts older text plus images payloads", () => {
    expect(
      normalizePromptPayload({
        text: "  look here  ",
        images: [
          {
            id: "image-1",
            name: "example.png",
            mimeType: "image/png",
            size: 5,
            dataUrl: "data:image/png;base64,aGVsbG8="
          }
        ]
      })
    ).toEqual([
      { type: "text", text: "look here" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "auto" },
        name: "example.png",
        mimeType: "image/png",
        size: 5
      }
    ]);
  });

  it("does not throw trim type errors for invalid event-like objects", () => {
    expect(normalizePromptPayload({ target: { value: "not a prompt payload" } })).toEqual([]);
    expect(() => normalizePromptPayload({ content: { text: "not an array" } })).toThrow(/text or content parts/);
  });

  it("normalizes selected skill names from prompt payloads", () => {
    expect(
      normalizePromptSkillNames({
        content: "review this",
        skills: ["$review", "/qa-check", "review", "bad name", 42]
      })
    ).toEqual(["review", "qa-check"]);
    expect(normalizePromptSkillNames("plain prompt")).toEqual([]);
  });

  it("normalizes retry prompt reuse intent from prompt payloads", () => {
    expect(normalizePromptReuseLastUserMessage({ content: "retry", reuseLastUserMessage: true })).toBe(true);
    expect(normalizePromptReuseLastUserMessage({ content: "retry", reuseLastUserMessage: false })).toBe(false);
    expect(normalizePromptReuseLastUserMessage("retry")).toBe(false);
  });

  it("normalizes bounded agent loop options", () => {
    expect(normalizePromptLoopOptions({ content: "fix this", loop: true })).toEqual({ enabled: true, maxIterations: 5 });
    expect(normalizePromptLoopOptions({ content: "fix this", loop: { enabled: true, maxIterations: 12 } })).toEqual({
      enabled: true,
      maxIterations: 10
    });
    expect(normalizePromptLoopOptions({ content: "fix this", loop: { enabled: false, maxIterations: 3 } })).toEqual({
      enabled: false,
      maxIterations: 3
    });
    expect(normalizePromptLoopOptions("fix this")).toEqual({ enabled: false, maxIterations: 5 });
  });

  it("normalizes plan approval options", () => {
    expect(normalizePromptPlanOptions({ content: "plan this", plan: true })).toEqual({ enabled: true });
    expect(normalizePromptPlanOptions({ content: "plan this", plan: { enabled: true } })).toEqual({ enabled: true });
    expect(normalizePromptPlanOptions({ content: "plan this", plan: { enabled: false } })).toEqual({ enabled: false });
    expect(normalizePromptPlanOptions("plan this")).toEqual({ enabled: false });
  });

  it("normalizes task worktree options", () => {
    expect(normalizePromptWorktreeOptions({ content: "fix this", worktree: true })).toEqual({ enabled: true });
    expect(normalizePromptWorktreeOptions({ content: "fix this", worktree: { enabled: true } })).toEqual({ enabled: true });
    expect(normalizePromptWorktreeOptions({ content: "fix this", worktree: { enabled: true, taskRunId: "run-123" } })).toEqual({
      enabled: true,
      taskRunId: "run-123"
    });
    expect(
      normalizePromptWorktreeOptions({
        content: "fix this",
        worktree: { enabled: true, taskRunId: "run-current", replayOfTaskRunId: "run-original", plannedFromTaskRunId: "run-plan" }
      })
    ).toEqual({
      enabled: true,
      taskRunId: "run-current",
      replayOfTaskRunId: "run-original",
      plannedFromTaskRunId: "run-plan"
    });
    expect(normalizePromptWorktreeOptions({ content: "fix this", worktree: { enabled: false } })).toEqual({ enabled: false });
    expect(normalizePromptWorktreeOptions("fix this")).toEqual({ enabled: false });
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent/Agent.js";
import type { ChatContent } from "../src/agent/content.js";
import { contextMessagesForSession } from "../src/agent/contextCompaction.js";
import { AgentRunAbortedError } from "../src/agent/types.js";
import type { AgentRunEvent, AgentSession, ChatClient, ChatMessage, ChatRequest, ChatResponse, ChatUsage } from "../src/agent/types.js";
import { createAgentTaskRun } from "../src/agent/taskRuns.js";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";
import type { BrowserToolController } from "../src/tools/browserControl.js";

let tempDir: string;
let skillsHome: string;
let previousSkillsHome: string | undefined;

describe("agent", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-agent-"));
    skillsHome = path.join(tempDir, "global-skills");
    previousSkillsHome = process.env.ARIVU_SKILLS_HOME;
    process.env.ARIVU_SKILLS_HOME = skillsHome;
    await writeFile(path.join(tempDir, "README.md"), "# Fixture\n", "utf8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (previousSkillsHome === undefined) {
      delete process.env.ARIVU_SKILLS_HOME;
    } else {
      process.env.ARIVU_SKILLS_HOME = previousSkillsHome;
    }
    vi.unstubAllGlobals();
  });

  it("can execute a tool call and return a final answer", async () => {
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read", arguments: { path: "README.md" } }]
        }
      },
      {
        message: {
          role: "assistant",
          content: "The readme says Fixture."
        }
      }
    ]);

    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    const result = await agent.run("summarize");
    expect(result.output).toBe("The readme says Fixture.");
    expect(result.session.messages.some((message) => message.role === "tool")).toBe(true);
    for (const message of result.session.messages.filter((message) => message.role === "user" || message.role === "assistant")) {
      expect(message.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("continues from a safe turn boundary when a steering message arrives during a final response", async () => {
    const client = new ScriptedClient([
      { message: { role: "assistant", content: "Initial answer." } },
      { message: { role: "assistant", content: "Updated answer with the new direction." } }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });
    const steeringMessage: ChatMessage = {
      role: "user",
      content: "Also include the migration risk.",
      createdAt: "2026-01-01T00:00:30.000Z"
    };
    let steeringChecks = 0;
    const onSteeringMessagesApplied = vi.fn();

    const result = await agent.run("Review this change.", {
      takeSteeringMessages: () => {
        steeringChecks += 1;
        return steeringChecks === 2 ? [steeringMessage] : [];
      },
      onSteeringMessagesApplied
    });

    expect(result.output).toBe("Updated answer with the new direction.");
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1]?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user", content: "Also include the migration risk." })])
    );
    expect(
      result.session.messages.filter((message) => message.role !== "system").map((message) => [message.role, message.content])
    ).toEqual([
      ["user", "Review this change."],
      ["assistant", "Initial answer."],
      ["user", "Also include the migration risk."],
      ["assistant", "Updated answer with the new direction."]
    ]);
    expect(onSteeringMessagesApplied).toHaveBeenCalledOnce();
    expect(onSteeringMessagesApplied).toHaveBeenCalledWith([steeringMessage]);
  });

  it("rejects a premature no-tool final in a multi-TODO browser run", async () => {
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "todo_1",
              name: "browser_task",
              arguments: { instruction: "Create and verify the catalog item.", mode: "background" }
            }
          ]
        }
      },
      {
        message: {
          role: "assistant",
          content: "TODO 1: complete — item created."
        }
      },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "todo_2",
              name: "browser_task",
              arguments: { instruction: "Add and verify the Approver choice.", mode: "background" }
            }
          ]
        }
      },
      {
        message: {
          role: "assistant",
          content: ["TODO 1: complete — item verified.", "TODO 2: complete — Approver choice verified."].join("\n")
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("trusted"),
      cwd: tempDir,
      browser: createFakeBrowser(),
      browserTaskModel: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" }
    });

    const result = await agent.run(
      ["TODO 1: Create the catalog item and verify it.", "TODO 2: Add the Approver choice and verify it."].join("\n")
    );

    expect(result.output).toContain("TODO 2: complete");
    expect(result.session.messages.some((message) => String(message.content) === "TODO 1: complete — item created.")).toBe(false);
    const retryRequest = client.requests[2]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    expect(retryRequest).toContain("previous no-tool reply was rejected");
    expect(retryRequest).toContain("TODO 2");
    expect(retryRequest).toContain("Original checklist excerpts");
  });

  it("inherits the browser checklist on Continue and rejects future-tense narration as a final", async () => {
    const session = createTestSession();
    session.messages.push(
      {
        role: "user",
        content: ["TODO 1: Create and verify the catalog item.", "TODO 2: Add and verify the remaining checkbox."].join("\n")
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "previous_browser", name: "browser_task", arguments: { instruction: "Create TODO 1." } }]
      },
      {
        role: "tool",
        toolCallId: "previous_browser",
        name: "browser_task",
        content: JSON.stringify({ success: true, data: "TODO 1 created.", stepCount: 3 })
      }
    );
    const client = new ScriptedClient([
      { message: { role: "assistant", content: "Let me create the remaining checkbox now." } },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "remaining_browser", name: "browser_task", arguments: { instruction: "Create and verify TODO 2." } }]
        }
      },
      {
        message: {
          role: "assistant",
          content: ["TODO 1: complete — catalog item verified.", "TODO 2: complete — checkbox verified."].join("\n")
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("trusted"),
      cwd: tempDir,
      session,
      browser: createFakeBrowser(),
      browserTaskModel: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" }
    });

    const result = await agent.run("Continue");

    expect(result.output).toContain("TODO 2: complete");
    expect(client.requests).toHaveLength(3);
    const firstRequest = client.requests[0]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    const correctiveRequest = client.requests[1]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    expect(firstRequest).toContain("Original browser completion gate: TODO 1, TODO 2");
    expect(correctiveRequest).toContain("only announced a future action");
    expect(result.session.messages.some((message) => message.content === "Let me create the remaining checkbox now.")).toBe(false);
  });

  it("accepts a completion line even when an earlier line marks the same TODO in progress", async () => {
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "todo_1", name: "browser_task", arguments: { instruction: "Create and verify the item.", mode: "background" } }]
        }
      },
      {
        message: {
          role: "assistant",
          // The first line mentioning TODO 1 is "in progress"; a later line completes it. The gate
          // must scan every matching line, not just the first, or it would reject this valid final.
          content: ["TODO 1: in progress — filling the form", "TODO 1: complete — verified the created item"].join("\n")
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("trusted"),
      cwd: tempDir,
      browser: createFakeBrowser(),
      browserTaskModel: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" }
    });

    const result = await agent.run("TODO 1: Create the catalog item and verify it.");

    // Accepted on the first final (no completion-retry), so exactly two model requests were made.
    expect(result.output).toContain("TODO 1: complete");
    expect(client.requests.length).toBe(2);
  });

  it("advertises global skills and attaches explicitly requested skills to the model", async () => {
    const skillDir = path.join(skillsHome, "review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      ["# Review Skill", "description: Use for careful code reviews.", "", "Read the changed files before commenting."].join("\n"),
      "utf8"
    );

    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "Ready to review."
        }
      }
    ]);

    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    await agent.run("$review this repo");

    const requestText = client.requests[0]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    expect(requestText).toContain("Global local skills are available");
    expect(requestText).toContain("review: Use for careful code reviews.");
    expect(requestText).toContain("review/SKILL.md");
    expect(requestText).toContain("Skill attached: review");
    expect(requestText).toContain("Read the changed files before commenting.");
    expect(client.requests[0]?.tools.map((tool) => tool.name)).toContain("list_skills");
    expect(client.requests[0]?.tools.map((tool) => tool.name)).toContain("read_skill");
  });

  it("loads selected skills into the chat context without duplicating them", async () => {
    const skillDir = path.join(skillsHome, "qa-check");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      ["# QA Check", "description: Verify the rendered workflow.", "", "Run the UI and capture evidence."].join("\n"),
      "utf8"
    );

    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "QA skill loaded."
        }
      },
      {
        message: {
          role: "assistant",
          content: "Still loaded."
        }
      }
    ]);

    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => true),
      cwd: tempDir
    });

    const first = await agent.run("check this change", { skillNames: ["$qa-check"] });
    const firstRequestText = client.requests[0]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    expect(firstRequestText).toContain("Skill loaded into chat: qa-check");
    expect(firstRequestText).toContain("Run the UI and capture evidence.");
    expect(first.session.messages.filter((message) => String(message.content).startsWith("Skill loaded into chat: qa-check"))).toHaveLength(
      1
    );

    const second = await agent.run("continue", { skillNames: ["qa-check"] });
    expect(
      second.session.messages.filter((message) => String(message.content).startsWith("Skill loaded into chat: qa-check"))
    ).toHaveLength(1);
  });

  it("can restrict advertised tools for plan approval runs", async () => {
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "Plan:\n1. Inspect the files.\n2. Patch the smallest area after approval."
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("trusted", async () => true),
      cwd: tempDir
    });

    await agent.run("plan the change", {
      allowedToolNames: ["list", "read", "search", "git_status", "current_datetime", "current_location", "list_skills", "read_skill"]
    });

    const toolNames = client.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(toolNames).toEqual([
      "list",
      "read",
      "search",
      "current_datetime",
      "current_location",
      "list_skills",
      "read_skill",
      "git_status"
    ]);
    expect(toolNames).not.toContain("apply_patch");
    expect(toolNames).not.toContain("write_file");
    expect(toolNames).not.toContain("run");
    expect(toolNames).not.toContain("web_search");
    expect(toolNames).not.toContain("browser_open");
    expect(toolNames).not.toContain("mcp_call_tool");
  });

  it("withholds user-disabled tools from the model", async () => {
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "Answered without the disabled tools."
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("trusted", async () => true),
      cwd: tempDir
    });

    await agent.run("do something", { disabledToolNames: ["write_file", "run", "web_search"] });

    const toolNames = client.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("apply_patch");
    expect(toolNames).not.toContain("write_file");
    expect(toolNames).not.toContain("run");
    expect(toolNames).not.toContain("web_search");
  });

  it("auto-summarizes an oversized working context without changing transcript history or task-run indexes", async () => {
    const now = new Date().toISOString();
    const filler = (marker: string) => `${marker} ${"x".repeat(3_000)}`;
    const messages: ChatMessage[] = [];
    for (let index = 0; index < 15; index += 1) {
      messages.push({ role: "user", content: filler(`early-user-${index}`) });
      messages.push({ role: "assistant", content: filler(`early-answer-${index}`) });
    }
    const lastSeededUserMessage = messages[28]!;
    const earlyRun = createAgentTaskRun({ userMessageIndex: 0, prompt: "early", now });
    const recentRun = createAgentTaskRun({ userMessageIndex: 28, prompt: "recent", now });
    const session: AgentSession = {
      id: "auto-summary-session",
      cwd: tempDir,
      projectRoot: tempDir,
      trustMode: "readonly",
      messages,
      taskRuns: [earlyRun, recentRun],
      createdAt: now,
      updatedAt: now
    };
    const client = new ScriptedClient([
      { message: { role: "assistant", content: "SUMMARY-BRIEF: polishing the parser; next step is running tests." } },
      { message: { role: "assistant", content: "Continuing from the brief." } }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      contextWindowTokens: 10_000,
      session
    });

    const result = await agent.run("wrap up");

    expect(result.output).toBe("Continuing from the brief.");
    // First request is the summary call (no tools), second is the step built on the brief.
    expect(client.requests[0]?.tools).toHaveLength(0);
    expect(String(client.requests[0]?.messages[0]?.content)).toContain("compacting a coding-assistant conversation");
    const stepText = client.requests[1]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    expect(stepText).toContain("SUMMARY-BRIEF");
    expect(stepText).not.toContain("early-user-0");
    const summary = session.contextCompaction?.messages.find(
      (message) => message.role === "system" && String(message.content).startsWith("Conversation summary (model-generated)")
    );
    expect(String(summary?.content)).toContain("SUMMARY-BRIEF");
    // Both task runs still anchor the canonical transcript; compaction only changes model input.
    expect(session.messages[earlyRun.userMessageIndex]?.role).toBe("user");
    expect(String(session.messages[earlyRun.userMessageIndex]?.content)).toContain("early-user-0");
    expect(recentRun.userMessageIndex).toBe(session.messages.indexOf(lastSeededUserMessage));
    expect(session.messages.indexOf(lastSeededUserMessage)).toBeGreaterThanOrEqual(0);
    expect(session.messages.some((message) => String(message.content).includes("early-answer-0"))).toBe(true);
  });

  it("falls back to transient request compaction when the auto-summary call times out", async () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [];
    for (let index = 0; index < 15; index += 1) {
      messages.push({ role: "user", content: `early-user-${index} ${"x".repeat(3_000)}` });
      messages.push({ role: "assistant", content: `early-answer-${index} ${"x".repeat(3_000)}` });
    }
    const session: AgentSession = {
      id: "auto-summary-timeout-session",
      cwd: tempDir,
      projectRoot: tempDir,
      trustMode: "readonly",
      messages,
      createdAt: now,
      updatedAt: now
    };
    const client = new HangingSummaryClient({ message: { role: "assistant", content: "Answered without a summary." } });
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      contextWindowTokens: 10_000,
      autoSummaryTimeoutMs: 25,
      session
    });

    const result = await agent.run("wrap up");

    expect(result.output).toBe("Answered without a summary.");
    expect(client.requests).toHaveLength(2);
    // The session was not summarized; the step request was still bounded by transient compaction.
    expect(session.messages.some((message) => String(message.content).startsWith("Conversation summary (model-generated)"))).toBe(false);
    const stepText = client.requests[1]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    expect(stepText).toContain("Context compacted locally");
  });

  it("does not auto-summarize a transcript that fits the request budget", async () => {
    const client = new ScriptedClient([{ message: { role: "assistant", content: "Done." } }]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      contextWindowTokens: 128_000,
      session: createTestSession()
    });

    await agent.run("quick question");

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.tools.length).toBeGreaterThan(0);
  });

  it("re-reads disabled tools before every step so mid-run toggles apply at the next model request", async () => {
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read", arguments: { path: "README.md" } }]
        }
      },
      {
        message: {
          role: "assistant",
          content: "Finished."
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    // Simulates the user flipping the "read" toggle off while step one is executing: every request
    // after the first is built with the tool withheld.
    const result = await agent.run("summarize", {
      disabledToolNames: () => (client.requests.length === 0 ? [] : ["read"])
    });

    expect(result.output).toBe("Finished.");
    expect(client.requests[0]?.tools.map((tool) => tool.name)).toContain("read");
    expect(client.requests[1]?.tools.map((tool) => tool.name)).not.toContain("read");
    expect(result.session.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("waits before a second normal request without delaying the final response", async () => {
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read", arguments: { path: "README.md" } }]
        }
      },
      { message: { role: "assistant", content: "Done." } }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      minStepIntervalMs: 120
    });

    const result = await agent.run("summarize");
    const completedAt = Date.now();

    expect(result.output).toBe("Done.");
    expect(client.requestTimes).toHaveLength(2);
    expect(client.requestTimes[1]! - client.requestTimes[0]!).toBeGreaterThanOrEqual(100);
    expect(completedAt - client.requestTimes[1]!).toBeLessThan(90);
  });

  it("disables the main-request throttle when minStepIntervalMs is zero", async () => {
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read", arguments: { path: "README.md" } }]
        }
      },
      { message: { role: "assistant", content: "Done." } }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      minStepIntervalMs: 0
    });

    await agent.run("summarize");

    expect(client.requestTimes).toHaveLength(2);
    expect(client.requestTimes[1]! - client.requestTimes[0]!).toBeLessThan(100);
  });

  it("aborts promptly while waiting before the next normal request", async () => {
    const controller = new AbortController();
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read", arguments: { path: "README.md" } }]
        }
      },
      { message: { role: "assistant", content: "Done." } }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      minStepIntervalMs: 150_000
    });

    const runPromise = agent.run("summarize", { signal: controller.signal });
    for (let index = 0; index < 200 && client.requests.length < 1; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const abortedAt = Date.now();
    controller.abort();

    await expect(runPromise).rejects.toThrow(AgentRunAbortedError);
    expect(Date.now() - abortedAt).toBeLessThan(500);
    expect(client.requests).toHaveLength(1);
  });

  it("answers from existing web results instead of offering repeated web searches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          `<?xml version="1.0" encoding="utf-8" ?>
          <rss version="2.0">
            <channel>
              <item>
                <title>India Cricket Update</title>
                <link>https://example.com/cricket</link>
                <description>Latest India cricket team update.</description>
              </item>
            </channel>
          </rss>`,
          { status: 200 }
        );
      })
    );

    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "web_search", arguments: { query: "Indian cricket team latest news", maxResults: 5 } }]
        }
      },
      {
        message: {
          role: "assistant",
          content: "India cricket update found."
        }
      }
    ]);

    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => true),
      cwd: tempDir
    });

    const result = await agent.run("latest cricket news");
    const secondRequestTools = client.requests[1]?.tools.map((tool) => tool.name);
    const secondRequestMessages = client.requests[1]?.messages.map((message) => message.content).join("\n");

    expect(result.output).toBe("India cricket update found.");
    expect(client.requests[0]?.tools.map((tool) => tool.name)).toContain("web_search");
    // After a search only web_search is withheld; other tools remain available for the rest of the run.
    expect(secondRequestTools).not.toContain("web_search");
    expect(secondRequestTools).toContain("read");
    expect(secondRequestTools).toContain("edit");
    expect(secondRequestMessages).toContain("You already have web_search results");
  });

  it("preserves read-only progress and a recovery note when a later model request fails", async () => {
    const session = createTestSession();
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read", arguments: { path: "README.md" } }]
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    await expect(agent.run("summarize")).rejects.toThrow("No scripted response.");

    expect(session.messages.some((message) => message.role === "user" && message.content === "summarize")).toBe(true);
    expect(session.messages.some((message) => message.role === "tool" && message.toolCallId === "call_1")).toBe(true);
    expect(
      session.messages.some(
        (message) =>
          message.role === "system" && String(message.content).includes("Run recovery note: The immediately preceding agent run failed")
      )
    ).toBe(true);
  });

  it("keeps the transcript when a run fails after a side-effecting tool already ran", async () => {
    const session = createTestSession();
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "write1", name: "write_file", arguments: { path: "kept.txt", content: "kept", mode: "create" } }]
        }
      }
      // No second response: the next model request throws mid-run, AFTER the write happened.
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("trusted", async () => true),
      cwd: tempDir,
      session
    });

    await expect(agent.run("write the file")).rejects.toThrow("No scripted response.");

    // The write actually happened; a rollback would have erased its record, so a retry would redo it.
    await expect(readFile(path.join(tempDir, "kept.txt"), "utf8")).resolves.toBe("kept");
    const assistant = session.messages.find((message) => message.role === "assistant" && message.toolCalls?.length);
    expect(assistant?.toolCalls?.[0]?.id).toBe("write1");
    // Transcript stays a valid tool protocol: the assistant's tool call has a matching result.
    const toolResult = session.messages.find((message) => message.role === "tool" && message.toolCallId === "write1");
    expect(toolResult).toBeDefined();
    expect(session.messages.filter((message) => message.role === "user").some((message) => message.content === "write the file")).toBe(
      true
    );
    expect(session.messages.at(-1)?.role).toBe("system");
    expect(String(session.messages.at(-1)?.content)).toContain("durable partial-work evidence");
  });

  it("preserves the original browser TODO requirements in the recovery note", async () => {
    const session = createTestSession();
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "todo_browser", name: "browser_task", arguments: { instruction: "Create TODO 1." } }]
        }
      }
      // The next model request fails after browser work completed, matching the long-session timeout.
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("trusted"),
      cwd: tempDir,
      session,
      browser: createFakeBrowser(),
      browserTaskModel: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" }
    });

    await expect(
      agent.run(["TODO 1: Create Laptop Type with four exact choices.", "TODO 2: Create the Mandatory checkbox at order 20."].join("\n"))
    ).rejects.toThrow("No scripted response.");

    const note = String(session.messages.find((message) => String(message.content).startsWith("Run recovery note:"))?.content);
    expect(note).toContain("Original browser completion scope remains: TODO 1, TODO 2");
    expect(note).toContain("Create Laptop Type with four exact choices");
    expect(note).toContain("Create the Mandatory checkbox at order 20");
  });

  it("persists a completed tool result before an event-recorder failure, and stays sendable", async () => {
    const session = createTestSession();
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "write1", name: "write_file", arguments: { path: "dangles.txt", content: "hi", mode: "create" } }]
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("trusted", async () => true),
      cwd: tempDir,
      session
    });

    // Throw while Desktop is recording the result event. The transcript result must already exist,
    // because that same event is the persistence boundary used by the app.
    await expect(
      agent.run("write the file", {
        onEvent: async (event) => {
          if (event.type === "tool_result" && event.name === "write_file") {
            throw new Error("event sink exploded");
          }
        }
      })
    ).rejects.toThrow("event sink exploded");

    await expect(readFile(path.join(tempDir, "dangles.txt"), "utf8")).resolves.toBe("hi");
    const toolResult = session.messages.find((message) => message.role === "tool" && message.toolCallId === "write1");
    expect(toolResult).toBeDefined();
    expect(String(toolResult?.content)).not.toContain("did not finish");

    // Prove the kept transcript is actually sendable: a follow-up run must not hit a protocol error.
    const followUp = new ScriptedClient([{ message: { role: "assistant", content: "Resumed cleanly." } }]);
    const resumeAgent = new Agent({
      client: followUp,
      approvals: new ApprovalManager("trusted", async () => true),
      cwd: tempDir,
      session
    });
    expect(session.messages.some((message) => String(message.content).startsWith("Run recovery note:"))).toBe(true);
    const resumed = await resumeAgent.continue();
    expect(resumed.output).toBe("Resumed cleanly.");
    expect(session.messages.some((message) => String(message.content).startsWith("Run recovery note:"))).toBe(false);
    const sentMessages = followUp.requests[0]?.messages ?? [];
    const sentAssistant = sentMessages.find((message) => message.role === "assistant" && message.toolCalls?.length);
    const sentResultIds = new Set(sentMessages.filter((message) => message.role === "tool").map((message) => message.toolCallId));
    for (const call of sentAssistant?.toolCalls ?? []) {
      expect(sentResultIds.has(call.id)).toBe(true);
    }
  });

  it("records the browser result when Stop interrupts the tool itself", async () => {
    const controller = new AbortController();
    const session = createTestSession();
    const browser = createFakeBrowser();
    let browserTaskStarted = false;
    browser.task = async () => {
      browserTaskStarted = true;
      controller.abort();
      throw new AgentRunAbortedError();
    };
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "interrupted_browser", name: "browser_task", arguments: { instruction: "Create the record." } }]
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("trusted"),
      cwd: tempDir,
      session,
      browser,
      browserTaskModel: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" }
    });

    await expect(agent.run("Create the record", { signal: controller.signal })).rejects.toThrow(AgentRunAbortedError);

    expect(browserTaskStarted).toBe(true);
    const interrupted = session.messages.find((message) => message.role === "tool" && message.toolCallId === "interrupted_browser");
    expect(String(interrupted?.content)).toContain("Error: Run stopped.");
    expect(String(session.messages.at(-1)?.content)).toContain("was stopped by the user");
  });

  it("repairs a tool call whose dispatch event is interrupted before execution", async () => {
    const session = createTestSession();
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "never_dispatched", name: "read", arguments: { path: "README.md" } }]
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    await expect(
      agent.run("read the file", {
        onEvent: (event) => {
          if (event.type === "tool_call") {
            throw new AgentRunAbortedError();
          }
        }
      })
    ).rejects.toThrow(AgentRunAbortedError);

    const repaired = session.messages.find((message) => message.role === "tool" && message.toolCallId === "never_dispatched");
    expect(String(repaired?.content)).toContain("did not finish");
  });

  it("continues from a pre-saved user prompt without duplicating it", async () => {
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: "pre-saved-session",
      cwd: tempDir,
      projectRoot: tempDir,
      trustMode: "readonly",
      messages: [{ role: "user", content: "summarize" }],
      createdAt: now,
      updatedAt: now
    };
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "Summary complete."
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    const result = await agent.run("summarize", { promptAlreadyInSession: true });

    expect(result.output).toBe("Summary complete.");
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
  });

  it("keeps task-run user message indexes aligned when inserting the base system prompt", async () => {
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: "pre-saved-task-run-session",
      cwd: tempDir,
      projectRoot: tempDir,
      trustMode: "readonly",
      messages: [{ role: "user", content: "summarize" }],
      taskRuns: [createAgentTaskRun({ userMessageIndex: 0, prompt: "summarize", now })],
      createdAt: now,
      updatedAt: now
    };
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "Summary complete."
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    await agent.run("summarize", { promptAlreadyInSession: true });

    expect(session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
    expect(session.taskRuns?.[0]?.userMessageIndex).toBe(1);
  });

  it("keeps task-run user message indexes aligned when a failed turn is preserved", async () => {
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: "failed-pre-saved-task-run-session",
      cwd: tempDir,
      projectRoot: tempDir,
      trustMode: "readonly",
      messages: [{ role: "user", content: "summarize" }],
      taskRuns: [createAgentTaskRun({ userMessageIndex: 0, prompt: "summarize", now })],
      createdAt: now,
      updatedAt: now
    };
    const emptyResponse = {
      message: {
        role: "assistant" as const,
        content: "   "
      }
    };
    const client = new ScriptedClient([emptyResponse, emptyResponse, emptyResponse, emptyResponse]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session,
      emptyResponseRetryDelayMs: 0
    });

    await expect(agent.run("summarize", { promptAlreadyInSession: true })).rejects.toThrow("empty assistant response");

    expect(session.messages.map((message) => message.role)).toEqual(["system", "user", "system"]);
    expect(String(session.messages.at(-1)?.content)).toContain("Run recovery note:");
    expect(session.taskRuns?.[0]?.userMessageIndex).toBe(1);
    expect(session.messages[session.taskRuns?.[0]?.userMessageIndex ?? -1]).toEqual({ role: "user", content: "summarize" });
  });

  it("removes resolved recovery guidance without shifting the continuation task-run anchor", async () => {
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: "resolved-recovery-session",
      cwd: tempDir,
      projectRoot: tempDir,
      trustMode: "readonly",
      messages: [
        { role: "user", content: "Original task" },
        {
          role: "system",
          content: "Run recovery note: The immediately preceding agent run failed before it finished.\nResume only unfinished work."
        },
        { role: "user", content: "Continue" }
      ],
      taskRuns: [createAgentTaskRun({ userMessageIndex: 2, prompt: "Continue", now })],
      createdAt: now,
      updatedAt: now
    };
    const client = new ScriptedClient([{ message: { role: "assistant", content: "Continuation completed." } }]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    await agent.run("Continue", { promptAlreadyInSession: true });

    expect(session.messages.some((message) => String(message.content).startsWith("Run recovery note:"))).toBe(false);
    const userMessageIndex = session.taskRuns?.[0]?.userMessageIndex ?? -1;
    expect(session.messages[userMessageIndex]).toEqual({ role: "user", content: "Continue" });
  });

  it("keeps task-run user message indexes aligned when loading skills before a saved prompt", async () => {
    const skillDir = path.join(skillsHome, "qa-check");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      ["# QA Check", "description: Verify the rendered workflow.", "", "Run the UI and capture evidence."].join("\n"),
      "utf8"
    );
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: "pre-saved-skill-task-run-session",
      cwd: tempDir,
      projectRoot: tempDir,
      trustMode: "readonly",
      messages: [{ role: "user", content: "check this" }],
      taskRuns: [createAgentTaskRun({ userMessageIndex: 0, prompt: "check this", now })],
      createdAt: now,
      updatedAt: now
    };
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "QA complete."
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    await agent.run("check this", { promptAlreadyInSession: true, skillNames: ["qa-check"] });

    expect(session.messages.map((message) => message.role)).toEqual(["system", "system", "user", "assistant"]);
    expect(String(session.messages[1]?.content)).toContain("Skill loaded into chat: qa-check");
    expect(session.taskRuns?.[0]?.userMessageIndex).toBe(2);
  });

  it("continues an existing transcript without adding a synthetic user message", async () => {
    const session = createTestSession();
    session.messages.push({ role: "system", content: "Agent loop continuation 2 of 5. Continue the same task." });
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "Continued work."
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    const result = await agent.continue();

    expect(result.output).toBe("Continued work.");
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", content: "Continued work." });
    expect(session.messages.at(-1)?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps the base Arivu system prompt when loop instructions are already present", async () => {
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: "loop-session",
      cwd: tempDir,
      projectRoot: tempDir,
      trustMode: "readonly",
      messages: [
        { role: "system", content: "Agent loop mode is active for the next user request." },
        { role: "user", content: "fix this" }
      ],
      createdAt: now,
      updatedAt: now
    };
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "Done."
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    await agent.run("fix this", { promptAlreadyInSession: true });

    const requestText = client.requests[0]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    expect(requestText).toContain("You are Arivu");
    expect(requestText).toContain("Agent loop mode is active");
  });

  it("runs independent read-only tool calls in one turn and preserves result order", async () => {
    await writeFile(path.join(tempDir, "a.txt"), "AAA\n", "utf8");
    await writeFile(path.join(tempDir, "b.txt"), "BBB\n", "utf8");
    await writeFile(path.join(tempDir, "c.txt"), "CCC\n", "utf8");
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "r1", name: "read", arguments: { path: "a.txt" } },
            { id: "r2", name: "read", arguments: { path: "b.txt" } },
            { id: "r3", name: "read", arguments: { path: "c.txt" } }
          ]
        }
      },
      { message: { role: "assistant", content: "read all three" } }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    const result = await agent.run("read all three files");

    const toolMessages = result.session.messages.filter((message) => message.role === "tool");
    expect(toolMessages.map((message) => message.toolCallId)).toEqual(["r1", "r2", "r3"]);
    expect(String(toolMessages[0]?.content)).toContain("AAA");
    expect(String(toolMessages[1]?.content)).toContain("BBB");
    expect(String(toolMessages[2]?.content)).toContain("CCC");
  });

  it("keeps a write sequential and correctly ordered among read-only calls", async () => {
    await writeFile(path.join(tempDir, "x.txt"), "x\n", "utf8");
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "read1", name: "read", arguments: { path: "x.txt" } },
            { id: "write1", name: "write_file", arguments: { path: "y.txt", content: "y", mode: "create" } },
            { id: "read2", name: "read", arguments: { path: "x.txt" } }
          ]
        }
      },
      { message: { role: "assistant", content: "done" } }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("trusted", async () => true),
      cwd: tempDir
    });

    const result = await agent.run("mixed calls");

    const ids = result.session.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId);
    expect(ids).toEqual(["read1", "write1", "read2"]);
    await expect(readFile(path.join(tempDir, "y.txt"), "utf8")).resolves.toBe("y");
  });

  it("rebuilds the base system prompt instead of accreting appended sentences", async () => {
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: "rebuild-session",
      cwd: tempDir,
      projectRoot: tempDir,
      trustMode: "readonly",
      messages: [
        { role: "system", content: "You are Arivu, a local CLI coding agent.\nOld appended sentence one.\nOld appended sentence two." },
        { role: "user", content: "hi" }
      ],
      createdAt: now,
      updatedAt: now
    };
    const client = new ScriptedClient([{ message: { role: "assistant", content: "Done." } }]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    await agent.run("hi", { promptAlreadyInSession: true });

    const baseMessages = session.messages.filter(
      (message) => message.role === "system" && String(message.content).includes("You are Arivu")
    );
    expect(baseMessages).toHaveLength(1);
    expect(String(baseMessages[0]?.content)).toContain("Arivu system prompt v");
    expect(String(baseMessages[0]?.content)).toContain('header action labeled "Create favorite for ..."');
    expect(String(baseMessages[0]?.content)).toContain("complete required field/value checklist");
    expect(String(baseMessages[0]?.content)).toContain("Do not copy numeric DOM element indices");
    expect(String(baseMessages[0]?.content)).toContain('pass mode:"visible" plus that visible tabId');
    expect(String(baseMessages[0]?.content)).toContain("cannot control the address bar");
    expect(String(baseMessages[0]?.content)).toContain("Catalog items use sc_cat_item.do");
    expect(String(baseMessages[0]?.content)).toContain("Never feed browser_open a guessed or constructed endpoint");
    expect(String(baseMessages[0]?.content)).toContain("For ServiceNow Question Choices");
    expect(String(baseMessages[0]?.content)).toContain('Never ask the browser agent to click the "Question Choices" menu');
    expect(String(baseMessages[0]?.content)).toContain("For a variable inside an existing ServiceNow Multi-Row Variable Set");
    expect(String(baseMessages[0]?.content)).not.toContain("Old appended sentence");
  });

  it("ignores tool calls that were not advertised for the current step", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          `<?xml version="1.0" encoding="utf-8" ?>
          <rss version="2.0">
            <channel>
              <item>
                <title>India Cricket Update</title>
                <link>https://example.com/cricket</link>
                <description>Latest India cricket team update.</description>
              </item>
            </channel>
          </rss>`,
          { status: 200 }
        );
      })
    );

    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "web_search", arguments: { query: "Indian cricket team latest news", maxResults: 5 } }]
        }
      },
      {
        message: {
          role: "assistant",
          content: "Answer without another search.",
          toolCalls: [{ id: "call_2", name: "web_search", arguments: { query: "repeat search", maxResults: 5 } }]
        }
      }
    ]);

    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    const result = await agent.run("latest cricket news");

    expect(result.output).toBe("Answer without another search.");
    expect(result.session.messages.filter((message) => message.role === "tool")).toHaveLength(1);
  });

  it("refreshes browser evidence before answering current browser prompts", async () => {
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "The browser is showing the fake ServiceNow page."
        }
      }
    ]);
    const browser = createFakeBrowser();
    const events: AgentRunEvent[] = [];
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      browser
    });

    const result = await agent.run("Can you see the website opened in the browser?", {
      onEvent: (event) => {
        events.push(event);
      }
    });

    expect(result.output).toBe("The browser is showing the fake ServiceNow page.");
    expect(events.flatMap((event) => (event.type === "tool_call" ? [event.call.name] : []))).toEqual([
      "browser_state",
      "browser_screenshot"
    ]);
    expect(result.session.messages.filter((message) => message.role === "tool").map((message) => message.name)).toEqual([
      "browser_state",
      "browser_screenshot"
    ]);
    expect(client.requests[0]?.messages.filter((message) => message.role === "tool").map((message) => message.name)).toEqual([
      "browser_state",
      "browser_screenshot"
    ]);
    expect(browser.screenshotCalls).toEqual([{ mode: "visible", tabId: "visible-tab-1" }]);
  });

  it("does not spend a synthetic screenshot before an explicit browser_task request", async () => {
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "I will delegate the requested browser task."
        }
      }
    ]);
    const browser = createFakeBrowser();
    const events: AgentRunEvent[] = [];
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      browser
    });

    await agent.run("On the active browser tab, call browser_task exactly once to inspect the form.", {
      onEvent: (event) => {
        events.push(event);
      }
    });

    expect(events.flatMap((event) => (event.type === "tool_call" ? [event.call.name] : []))).toEqual([]);
    expect(browser.screenshotCalls).toEqual([]);
  });

  it("does not refresh browser evidence for ordinary page-code prompts", async () => {
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "I will inspect the page component source."
        }
      }
    ]);
    const browser = createFakeBrowser();
    const events: AgentRunEvent[] = [];
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      browser
    });

    await agent.run("check the page component code", {
      onEvent: (event) => {
        events.push(event);
      }
    });

    expect(events.flatMap((event) => (event.type === "tool_call" ? [event.call.name] : []))).toEqual([]);
    expect(browser.screenshotCalls).toEqual([]);
  });

  it("does not re-spend a synthetic browser refresh when one is already recent", async () => {
    const session = createTestSession();
    // A synthetic refresh already ran in this session (synthetic ids are prefixed with the tool name).
    session.messages.push(
      { role: "assistant", content: "", toolCalls: [{ id: "browser_state_prev", name: "browser_state", arguments: {} }] },
      { role: "tool", toolCallId: "browser_state_prev", name: "browser_state", content: "{}" }
    );
    const client = new ScriptedClient([{ message: { role: "assistant", content: "Continuing the task." } }]);
    const browser = createFakeBrowser();
    const events: AgentRunEvent[] = [];
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session,
      browser
    });

    await agent.run("I have logged in, continue", {
      onEvent: (event) => {
        events.push(event);
      }
    });

    expect(events.flatMap((event) => (event.type === "tool_call" ? [event.call.name] : []))).toEqual([]);
    expect(browser.screenshotCalls).toEqual([]);
  });

  it("retries when the model writes a tool call as transcript text instead of calling it", async () => {
    const mimicry = "I will inspect the page.\n\nLocal tool request:\n- current_datetime: {}";
    const client = new ScriptedClient([
      { message: { role: "assistant", content: mimicry } },
      { message: { role: "assistant", content: "", toolCalls: [{ id: "call_dt", name: "current_datetime", arguments: {} }] } },
      { message: { role: "assistant", content: "It is noon." } }
    ]);
    const events: AgentRunEvent[] = [];
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    const result = await agent.run("what time is it", {
      onEvent: (event) => {
        events.push(event);
      }
    });

    expect(result.output).toBe("It is noon.");
    expect(events.flatMap((event) => (event.type === "tool_call" ? [event.call.name] : []))).toEqual(["current_datetime"]);
    // The mimicking turn is dropped from the session entirely.
    expect(result.session.messages.some((message) => String(message.content).includes("Local tool request"))).toBe(false);
    // The retry request carries a transient corrective instruction; the first request does not.
    const secondRequestText = client.requests[1]?.messages
      .filter((message) => message.role === "system")
      .map((message) => String(message.content))
      .join("\n");
    expect(secondRequestText).toContain("real native tool call");
    expect(
      client.requests[0]?.messages
        .filter((message) => message.role === "system")
        .map((message) => String(message.content))
        .join("\n")
    ).not.toContain("real native tool call");
  });

  it("retries a MiniMax tool invocation truncated mid-tag instead of completing the run", async () => {
    const truncated = ["Adding the choice now.", "<minimax:tool_call>", '<invoke name="current_datetime">', '<parameter name="time'].join(
      "\n"
    );
    const client = new ScriptedClient([
      { message: { role: "assistant", content: truncated } },
      { message: { role: "assistant", content: "", toolCalls: [{ id: "call_dt_minimax", name: "current_datetime", arguments: {} }] } },
      { message: { role: "assistant", content: "Recovered." } }
    ]);
    const events: AgentRunEvent[] = [];
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    const result = await agent.run("continue the task", {
      onEvent: (event) => {
        events.push(event);
      }
    });

    expect(result.output).toBe("Recovered.");
    expect(events.flatMap((event) => (event.type === "tool_call" ? [event.call.name] : []))).toEqual(["current_datetime"]);
    expect(result.session.messages.some((message) => String(message.content).includes("<minimax:tool_call>"))).toBe(false);
    const retryInstruction = client.requests[1]?.messages
      .filter((message) => message.role === "system")
      .map((message) => String(message.content))
      .join("\n");
    expect(retryInstruction).toContain("<minimax:tool_call>");
    expect(retryInstruction).toContain("real native tool call");
  });

  it("does not retry final answers that merely quote tool-call syntax inside code fences", async () => {
    const answer = "The qwen template looks like:\n```\n<tool_call>\n<function=browser_task>\n</function>\n</tool_call>\n```\nThat is all.";
    const client = new ScriptedClient([{ message: { role: "assistant", content: answer } }]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    const result = await agent.run("explain the qwen tool-call template");

    expect(client.requests.length).toBe(1);
    expect(result.output).toBe(answer);
  });

  it("accepts transcript-format text as the final answer once the mimicry retry budget is spent", async () => {
    const mimicry = "Local tool request:\n- browser_task: {}";
    const client = new ScriptedClient([
      { message: { role: "assistant", content: mimicry } },
      { message: { role: "assistant", content: mimicry } },
      { message: { role: "assistant", content: mimicry } }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    const result = await agent.run("do the thing");

    expect(client.requests.length).toBe(3);
    expect(result.output).toBe(mimicry);
    // Only the finally-accepted assistant message remains; the popped retries left no trace.
    expect(result.session.messages.filter((message) => message.role === "assistant").length).toBe(1);
  });

  it("steers the model after it repeats a tool call that keeps failing with the identical error", async () => {
    // The benchmarked failure mode: browser_task re-issued with direct-URL instructions — a
    // different URL each time, but the identical guard rejection every time.
    const rejectedCall = (id: string, url: string) => ({
      id,
      name: "browser_task",
      arguments: { instruction: `Navigate to ${url} and continue the work there.`, mode: "background" }
    });
    const client = new ScriptedClient([
      {
        message: { role: "assistant", content: "", toolCalls: [rejectedCall("url_1", "https://dev425223.service-now.com/sc_cat_item.do")] }
      },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [rejectedCall("url_2", "https://dev425223.service-now.com/item_option_new.do")]
        }
      },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [rejectedCall("url_3", "https://dev425223.service-now.com/question_choice.do")]
        }
      },
      { message: { role: "assistant", content: "Switching to browser_open instead." } },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "open_1", name: "browser_open", arguments: { url: "https://dev425223.service-now.com/" } }]
        }
      },
      { message: { role: "assistant", content: "Opened the ServiceNow home page with the corrected approach." } }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("trusted"),
      cwd: tempDir,
      browser: createFakeBrowser(),
      browserTaskModel: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" }
    });

    const result = await agent.run("Create the catalog item and its variables.");

    const toolResults = result.session.messages
      .filter((message) => message.role === "tool" && message.name === "browser_task")
      .map((message) => String(message.content));
    expect(toolResults).toHaveLength(3);
    expect(toolResults.every((content) => content.startsWith("Error: browser_task cannot navigate"))).toBe(true);
    // The first failure passes through untouched; the identical repeats carry an inline notice
    // even though each call used a different URL.
    expect(toolResults[0]).not.toContain("Repeated failure:");
    expect(toolResults[1]).toContain("Repeated failure: browser_task has returned this exact error 2 times");
    expect(toolResults[2]).toContain("3 times");
    // From the step after the second identical failure, every request carries the transient
    // corrective instruction; earlier requests do not.
    const systemText = (index: number) =>
      client.requests[index]?.messages
        .filter((message) => message.role === "system")
        .map((message) => String(message.content))
        .join("\n") ?? "";
    expect(systemText(0)).not.toContain("Repeated failing tool calls");
    expect(systemText(1)).not.toContain("Repeated failing tool calls");
    expect(systemText(2)).toContain("Repeated failing tool calls detected in this run");
    expect(systemText(2)).toContain("browser_task failed 2 times with the identical error");
    expect(systemText(3)).toContain("browser_task failed 3 times with the identical error");
    expect(systemText(4)).toContain("previous no-tool reply only announced a future action");
    // The instruction is transient: it rides the request, never the saved session.
    expect(result.session.messages.some((message) => String(message.content).includes("Repeated failing tool calls"))).toBe(false);
  });

  it("does not flag repeated failures when the errors differ", async () => {
    const client = new ScriptedClient([
      { message: { role: "assistant", content: "", toolCalls: [{ id: "miss_a", name: "read", arguments: { path: "missing-a.txt" } }] } },
      { message: { role: "assistant", content: "", toolCalls: [{ id: "miss_b", name: "read", arguments: { path: "missing-b.txt" } }] } },
      { message: { role: "assistant", content: "Neither file exists." } }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    const result = await agent.run("read both candidate files");

    const toolResults = result.session.messages.filter((message) => message.role === "tool").map((message) => String(message.content));
    expect(toolResults).toHaveLength(2);
    expect(toolResults.every((content) => content.startsWith("Error:"))).toBe(true);
    expect(toolResults.some((content) => content.includes("Repeated failure:"))).toBe(false);
    expect(
      client.requests.some((request) => request.messages.some((message) => String(message.content).includes("Repeated failing tool calls")))
    ).toBe(false);
  });

  it("counts identical failures cumulatively across the run, not just consecutively", async () => {
    const client = new ScriptedClient([
      { message: { role: "assistant", content: "", toolCalls: [{ id: "miss_1", name: "read", arguments: { path: "missing.txt" } }] } },
      { message: { role: "assistant", content: "", toolCalls: [{ id: "ok_1", name: "read", arguments: { path: "README.md" } }] } },
      { message: { role: "assistant", content: "", toolCalls: [{ id: "miss_2", name: "read", arguments: { path: "missing.txt" } }] } },
      { message: { role: "assistant", content: "Giving up on missing.txt." } }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    const result = await agent.run("compare the two files");

    const toolResults = result.session.messages.filter((message) => message.role === "tool").map((message) => String(message.content));
    expect(toolResults).toHaveLength(3);
    // The successful read in between does not reset the count for the failing one.
    expect(toolResults[2]).toContain("Repeated failure: read has returned this exact error 2 times");
    const finalRequestText =
      client.requests[3]?.messages
        .filter((message) => message.role === "system")
        .map((message) => String(message.content))
        .join("\n") ?? "";
    expect(finalRequestText).toContain("read failed 2 times with the identical error");
  });

  it("retries a genuinely empty assistant response up to 3 times, 2.5 minutes apart, before giving up", async () => {
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: "test-session",
      cwd: tempDir,
      projectRoot: tempDir,
      trustMode: "readonly",
      messages: [],
      createdAt: now,
      updatedAt: now
    };
    const emptyResponse = { message: { role: "assistant" as const, content: "   " } };
    const client = new ScriptedClient([emptyResponse, emptyResponse, emptyResponse, emptyResponse]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session,
      // Real 2.5-minute spacing is a production concern, not something this test needs to
      // observe -- only that a retry happens. Collapsing the delay to 0 lets the run proceed
      // on real timers instead of coordinating with fake ones.
      emptyResponseRetryDelayMs: 0
    });

    await expect(agent.run("summarize")).rejects.toThrow("empty assistant response 4 times in a row");

    expect(client.requests.length).toBe(4);
    // Empty assistant shells are dropped, but the user's turn and a durable failure explanation
    // remain so a later Continue is not detached from the request that failed.
    expect(session.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    expect(session.messages.some((message) => message.role === "user" && message.content === "summarize")).toBe(true);
    expect(String(session.messages.at(-1)?.content)).toContain("empty assistant response 4 times in a row");
  });

  it("recovers if a later attempt returns a real response after an empty one", async () => {
    const emptyResponse = { message: { role: "assistant" as const, content: "" } };
    const answer = { message: { role: "assistant" as const, content: "Here you go." } };
    const client = new ScriptedClient([emptyResponse, answer]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      emptyResponseRetryDelayMs: 0
    });

    const result = await agent.run("summarize");

    expect(result.output).toBe("Here you go.");
    expect(client.requests.length).toBe(2);
  });

  it("gives a later empty-response incident its own fresh retry budget after real progress", async () => {
    const empty = { message: { role: "assistant" as const, content: "" } };
    const client = new ScriptedClient([
      empty,
      {
        message: {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: "call_1", name: "read", arguments: { path: "README.md" } }]
        }
      },
      // A second incident of 3 empty responses only fits within the retry budget if the tool
      // call above reset the counter -- a shared, never-reset budget would throw on this trio
      // since only 2 retries would remain from the first incident.
      empty,
      empty,
      empty,
      { message: { role: "assistant" as const, content: "Recovered." } }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      emptyResponseRetryDelayMs: 0
    });

    const result = await agent.run("summarize");

    expect(result.output).toBe("Recovered.");
    expect(client.requests.length).toBe(6);
  });

  it("aborts promptly instead of waiting out the empty-response retry delay", async () => {
    const controller = new AbortController();
    const emptyResponse = { message: { role: "assistant" as const, content: "" } };
    const client = new ScriptedClient([emptyResponse, emptyResponse, emptyResponse, emptyResponse]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      // Real production delay -- if abort didn't pre-empt the wait, this test would hang until
      // the suite's own timeout instead of failing fast, so a passing run proves the signal path.
      emptyResponseRetryDelayMs: 150_000
    });

    const runPromise = agent.run("summarize", { signal: controller.signal });
    // Abort only once the first empty response has actually been consumed -- aborting
    // immediately would just hit the loop's own pre-step check and never touch delay()'s
    // abort handling, the thing this test exists to cover.
    for (let i = 0; i < 200 && client.requests.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(client.requests.length).toBeGreaterThanOrEqual(1);
    controller.abort();

    await expect(runPromise).rejects.toThrow(AgentRunAbortedError);
  });

  it("auto-compacts oversized model requests without rewriting saved chat history", async () => {
    const session = createTestSession();
    const oversizedSnapshot = "x".repeat(260_000);
    session.messages.push(
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_browser", name: "browser_snapshot", arguments: { mode: "visible", maxLength: 200000 } }]
      },
      {
        role: "tool",
        toolCallId: "call_browser",
        name: "browser_snapshot",
        content: oversizedSnapshot
      }
    );
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "The browser context was handled."
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    await agent.run("continue with the browser state");

    const requestText = client.requests[0]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    expect(requestText).toContain("Context compacted locally");
    expect(requestText).toContain("Local tool result from browser_snapshot");
    expect(requestText).not.toContain("x".repeat(10_000));
    expect(JSON.stringify(client.requests[0]?.messages).length).toBeLessThan(80_000);
    expect(session.messages.some((message) => message.role === "tool" && message.content === oversizedSnapshot)).toBe(true);
  });

  it("preserves multimodal active prompts when a later tool result triggers compaction", async () => {
    const imageUrl = "data:image/png;base64,aGVsbG8=";
    const promptContent: ChatContent = [
      { type: "text", text: `Inspect this screenshot and continue.\n${"details ".repeat(200)}` },
      { type: "image_url", image_url: { url: imageUrl, detail: "low" }, name: "screen.png", mimeType: "image/png", size: 128 }
    ];
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_browser", name: "browser_screenshot", arguments: { mode: "visible" } }]
        }
      },
      {
        message: {
          role: "assistant",
          content: "Screenshot handled."
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session: createTestSession(),
      browser: createFakeBrowser("x".repeat(260_000))
    });

    await agent.run(promptContent);

    const secondRequest = client.requests[1];
    const pinnedPrompt = secondRequest?.messages.find((message) => message.role === "user" && Array.isArray(message.content));
    const pinnedParts = Array.isArray(pinnedPrompt?.content) ? pinnedPrompt.content : [];

    expect(secondRequest?.messages.map((message) => String(message.content)).join("\n")).toContain("Context compacted locally");
    expect(pinnedParts).toContainEqual({
      type: "image_url",
      image_url: { url: imageUrl, detail: "low" },
      name: "screen.png",
      mimeType: "image/png",
      size: 128
    });
    expect(pinnedParts.find((part) => part.type === "text")?.text).toContain("Inspect this screenshot");
    expect(JSON.stringify(secondRequest?.messages)).not.toContain("x".repeat(10_000));
  });

  it("compacts model requests against a small per-model context window", async () => {
    const session = createTestSession();
    session.messages.push({ role: "assistant", content: "y".repeat(30_000) });
    const client = new ScriptedClient([{ message: { role: "assistant", content: "Handled." } }]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session,
      contextWindowTokens: 8_000
    });

    await agent.run("continue");

    const requestText = client.requests[0]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    expect(requestText).toContain("Context compacted locally");
    expect(requestText).not.toContain("y".repeat(20_000));
  });

  it("leaves the same request uncompacted without a small context window", async () => {
    const session = createTestSession();
    session.messages.push({ role: "assistant", content: "y".repeat(30_000) });
    const client = new ScriptedClient([{ message: { role: "assistant", content: "Handled." } }]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    await agent.run("continue");

    const requestText = client.requests[0]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    expect(requestText).not.toContain("Context compacted locally");
  });

  it("budgets a large window at 90% instead of compacting prematurely", async () => {
    const session = createTestSession();
    // ~50k estimated tokens: far above the old 48k default, far below 90% of a 512k window.
    session.messages.push({ role: "assistant", content: "y".repeat(200_000) });
    const client = new ScriptedClient([{ message: { role: "assistant", content: "Handled." } }]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session,
      contextWindowTokens: 524_288
    });

    await agent.run("continue");

    const requestText = client.requests[0]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    expect(requestText).not.toContain("Context compacted locally");
    expect(requestText).toContain("y".repeat(20_000));
  });

  it("reserves reply headroom on a tiny context window instead of claiming almost all of it", async () => {
    const session = createTestSession();
    // 3,200 estimated tokens. The old Math.max(4_000, ...) floor gave a 4,096-token model a 4,000
    // budget (97.6% of its window), so this was NOT compacted and left ~96 tokens to answer with.
    session.messages.push({ role: "assistant", content: "y".repeat(12_800) });
    const client = new ScriptedClient([{ message: { role: "assistant", content: "Handled." } }]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session,
      contextWindowTokens: 4_096
    });

    await agent.run("continue");

    const requestText = client.requests[0]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    expect(requestText).toContain("Context compacted locally");
  });

  it("reports the real context window when the provider rejects an oversized request", async () => {
    const observed: number[] = [];
    const client = new ContextLengthRetryClient();
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session: createTestSession(),
      onContextWindowObserved: (tokens) => {
        observed.push(tokens);
      }
    });

    await agent.run("continue");
    await new Promise((resolve) => setImmediate(resolve));

    // The rejection names the model's real window; learning it here costs no extra API call.
    expect(observed).toEqual([196_608]);
  });

  it("retries context-length failures with aggressive request compaction", async () => {
    const client = new ContextLengthRetryClient();
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session: createTestSession()
    });

    const result = await agent.run("summarize");

    expect(result.output).toBe("Recovered after compaction.");
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]?.messages.map((message) => String(message.content)).join("\n")).not.toContain("Context compacted locally");
    expect(client.requests[1]?.messages.map((message) => String(message.content)).join("\n")).toContain("Context compacted locally");
  });

  it("does not start a run whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const session = createTestSession();
    const originalMessages = structuredClone(session.messages);
    const client = new ScriptedClient([{ message: { role: "assistant", content: "Should not run." } }]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    await expect(agent.run("summarize", { signal: controller.signal })).rejects.toThrow(AgentRunAbortedError);
    expect(client.requests).toHaveLength(0);
    expect(session.messages).toEqual(originalMessages);
  });

  it("stops mid-run while preserving completed progress for Continue", async () => {
    const controller = new AbortController();
    const session = createTestSession();
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read", arguments: { path: "README.md" } }]
        }
      },
      { message: { role: "assistant", content: "Should not reach the second step." } }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    await expect(
      agent.run("summarize", {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "tool_result") {
            controller.abort();
          }
        }
      })
    ).rejects.toThrow(AgentRunAbortedError);

    expect(client.requests).toHaveLength(1);
    expect(session.messages.some((message) => message.role === "user" && message.content === "summarize")).toBe(true);
    expect(session.messages.some((message) => message.role === "tool" && message.toolCallId === "call_1")).toBe(true);
    expect(String(session.messages.at(-1)?.content)).toContain("was stopped by the user");
    expect(String(session.messages.at(-1)?.content)).toContain("resume only unfinished work");
  });

  it("reports provider token usage to onUsage", async () => {
    const usages: ChatUsage[] = [];
    const client = new ScriptedClient([
      {
        message: { role: "assistant", content: "Done." },
        usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17 }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    await agent.run("summarize", {
      onUsage: (usage) => {
        usages.push(usage);
      }
    });

    expect(usages).toEqual([{ promptTokens: 12, completionTokens: 5, totalTokens: 17 }]);
  });

  it("summarizes older context with the model and keeps recent turns verbatim", async () => {
    const session = sessionWithManyTurns();
    const transcriptBefore = structuredClone(session.messages);
    const client = new ScriptedClient([{ message: { role: "assistant", content: "- Goal: ship feature X\n- Touched: a.ts" } }]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    const result = await agent.summarizeContext();

    expect(result.source).toBe("model");
    expect(result.compacted).toBe(true);
    const summary = session.contextCompaction?.messages.find(
      (message) => message.role === "system" && String(message.content).includes("Conversation summary (model-generated)")
    );
    expect(String(summary?.content)).toContain("Goal: ship feature X");
    expect(session.messages.some((message) => String(message.content) === "turn 11")).toBe(true);
    expect(session.messages.some((message) => String(message.content) === "turn 0")).toBe(true);
    expect(session.messages).toEqual(transcriptBefore);
    expect(contextMessagesForSession(session).some((message) => String(message.content) === "turn 0")).toBe(false);
  });

  it("falls back to deterministic compaction when the model summary fails", async () => {
    const session = sessionWithManyTurns();
    const client = new ScriptedClient([]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    const result = await agent.summarizeContext();

    expect(result.source).toBe("deterministic");
    expect(result.compacted).toBe(true);
    expect(session.messages.some((message) => String(message.content) === "turn 0")).toBe(true);
    expect(session.contextCompaction?.messages.some((message) => String(message.content).startsWith("Context compacted locally"))).toBe(
      true
    );
  });

  it("saves a visible assistant message when max tool depth is reached", async () => {
    const client = new ScriptedClient(
      Array.from({ length: 500 }, (_entry, index) => ({
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: `call_${index}`, name: "read", arguments: { path: "README.md" } }]
        }
      }))
    );
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    const result = await agent.run("loop forever");
    const lastMessage = result.session.messages.at(-1);

    expect(result.output).toContain("Stopped after reaching the maximum tool-call depth");
    expect(result.output).toContain("500 steps");
    expect(result.output).toContain("Continue to resume");
    expect(lastMessage).toMatchObject({ role: "assistant", content: result.output });
    expect(lastMessage?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

class ScriptedClient implements ChatClient {
  private index = 0;
  readonly requests: ChatRequest[] = [];
  readonly requestTimes: number[] = [];

  constructor(private readonly responses: ChatResponse[]) {}

  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    this.requestTimes.push(Date.now());
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) {
      throw new Error("No scripted response.");
    }
    return response;
  }
}

/** Hangs the first (summary) call until its signal aborts, then answers normally. */
class HangingSummaryClient implements ChatClient {
  readonly requests: ChatRequest[] = [];

  constructor(private readonly answer: ChatResponse) {}

  async complete(request: ChatRequest, options?: { signal?: AbortSignal }): Promise<ChatResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new Error("Request aborted."));
        if (options?.signal?.aborted) {
          abort();
          return;
        }
        options?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return this.answer;
  }
}

class ContextLengthRetryClient implements ChatClient {
  readonly requests: ChatRequest[] = [];

  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      throw new Error(
        'Model request failed (400): {"error":{"message":"This model\'s maximum context length is 196608 tokens. However, your messages resulted in 238262 tokens. Please reduce the length of the messages.","type":"Bad Request","code":400}}'
      );
    }
    return {
      message: {
        role: "assistant",
        content: "Recovered after compaction."
      }
    };
  }
}

function createTestSession(): AgentSession {
  const now = new Date().toISOString();
  return {
    id: "test-session",
    cwd: tempDir,
    projectRoot: tempDir,
    trustMode: "readonly",
    messages: [
      {
        role: "system",
        content: "Existing system prompt. Do not use emojis in assistant replies."
      },
      {
        role: "user",
        content: "Earlier prompt"
      },
      {
        role: "assistant",
        content: "Earlier answer"
      }
    ],
    createdAt: now,
    updatedAt: now
  };
}

function sessionWithManyTurns(): AgentSession {
  const now = new Date().toISOString();
  const messages: ChatMessage[] = [{ role: "system", content: "You are Arivu, a local CLI coding agent." }];
  for (let index = 0; index < 12; index += 1) {
    messages.push({ role: index % 2 === 0 ? "user" : "assistant", content: `turn ${index}` });
  }
  return {
    id: "summary-session",
    cwd: tempDir,
    projectRoot: tempDir,
    trustMode: "readonly",
    messages,
    createdAt: now,
    updatedAt: now
  };
}

function createFakeBrowser(
  snapshotText = "Fake ServiceNow page"
): BrowserToolController & { snapshotCalls: Array<Record<string, unknown>>; screenshotCalls: Array<Record<string, unknown>> } {
  const snapshotCalls: Array<Record<string, unknown>> = [];
  const screenshotCalls: Array<Record<string, unknown>> = [];
  return {
    snapshotCalls,
    screenshotCalls,
    getState() {
      return {
        paneOpen: true,
        defaultMode: "background",
        activeMode: "visible",
        visible: {
          id: "visible-tab-1",
          mode: "visible",
          url: "https://developer.servicenow.com/dev.do#!/manage-instance",
          title: "ServiceNow Developers",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          activeTabId: "visible-tab-1",
          tabs: [
            {
              id: "visible-tab-1",
              url: "https://developer.servicenow.com/dev.do#!/manage-instance",
              title: "ServiceNow Developers",
              loading: false,
              canGoBack: false,
              canGoForward: false
            }
          ]
        },
        background: {
          id: "background",
          mode: "background",
          url: "",
          title: "",
          loading: false,
          canGoBack: false,
          canGoForward: false
        }
      };
    },
    async selectTab(args) {
      return {
        mode: "visible",
        activeTabId: args.tabId,
        tabId: args.tabId,
        url: "https://developer.servicenow.com/dev.do#!/manage-instance",
        title: "ServiceNow Developers"
      };
    },
    async open(args) {
      return {
        mode: args.mode ?? "background",
        url: args.url,
        title: "Opened"
      };
    },
    async screenshot(args) {
      screenshotCalls.push({ ...args });
      return {
        mode: args.mode ?? "visible",
        tabId: args.tabId,
        screenshotPath: "/tmp/arivu-fake-browser.png",
        visibleText: snapshotText
      };
    },
    async snapshot(args) {
      snapshotCalls.push({ ...args });
      return {
        mode: args.mode ?? "visible",
        tabId: args.tabId,
        snapshot: { text: snapshotText }
      };
    },
    async console(args) {
      return {
        mode: args.mode ?? "visible",
        tabId: args.tabId,
        logs: []
      };
    },
    async click(args) {
      return {
        mode: args.mode ?? "visible",
        tabId: args.tabId,
        target: args.target,
        ok: true
      };
    },
    async clickAt(args) {
      return {
        mode: args.mode ?? "visible",
        tabId: args.tabId,
        x: args.x,
        y: args.y,
        ok: true
      };
    },
    async type(args) {
      return {
        mode: args.mode ?? "visible",
        tabId: args.tabId,
        target: args.target,
        text: args.text,
        ok: true
      };
    },
    async task(args) {
      return {
        mode: args.mode ?? "visible",
        tabId: args.tabId,
        success: true,
        data: "Fake browser task completed.",
        stepCount: 1,
        stopped: false,
        navigationCount: 0,
        durationMs: 10
      };
    },
    async scroll(args) {
      return {
        mode: args.mode ?? "visible",
        tabId: args.tabId,
        ok: true
      };
    },
    async selectOption(args) {
      return {
        mode: args.mode ?? "visible",
        tabId: args.tabId,
        index: args.index,
        optionText: args.optionText,
        ok: true
      };
    },
    async executeJavaScript(args) {
      return {
        mode: args.mode ?? "visible",
        tabId: args.tabId,
        ok: true,
        result: `ran: ${args.script}`
      };
    }
  };
}

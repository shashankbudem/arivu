import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent/Agent.js";
import type { ChatContent } from "../src/agent/content.js";
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

  it("auto-summarizes an oversized transcript before the next step and remaps task-run indexes", async () => {
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
    const summaryIndex = session.messages.findIndex(
      (message) => message.role === "system" && String(message.content).startsWith("Conversation summary (model-generated)")
    );
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    // The early run's user message was folded into the summary; the recent run's survived by reference.
    expect(earlyRun.userMessageIndex).toBe(summaryIndex);
    expect(recentRun.userMessageIndex).toBe(session.messages.indexOf(lastSeededUserMessage));
    expect(session.messages.indexOf(lastSeededUserMessage)).toBeGreaterThanOrEqual(0);
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

  it("rolls back unsaved messages when a run fails", async () => {
    const session = createTestSession();
    const originalMessages = structuredClone(session.messages);
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

    expect(session.messages).toEqual(originalMessages);
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

  it("restores task-run user message indexes when system-prompt insertion rolls back", async () => {
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
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "   "
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    await expect(agent.run("summarize", { promptAlreadyInSession: true })).rejects.toThrow("empty assistant response");

    expect(session.messages).toEqual([{ role: "user", content: "summarize" }]);
    expect(session.taskRuns?.[0]?.userMessageIndex).toBe(0);
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
    expect(session.messages.at(-1)).toEqual({ role: "assistant", content: "Continued work." });
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

  it("does not accept empty assistant responses without tool calls as completed runs", async () => {
    const session = createTestSession();
    const originalMessages = structuredClone(session.messages);
    const client = new ScriptedClient([
      {
        message: {
          role: "assistant",
          content: "   "
        }
      }
    ]);
    const agent = new Agent({
      client,
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir,
      session
    });

    await expect(agent.run("summarize")).rejects.toThrow("empty assistant response");

    expect(session.messages).toEqual(originalMessages);
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

  it("stops mid-run when the signal aborts and rolls the session back", async () => {
    const controller = new AbortController();
    const session = createTestSession();
    const originalMessages = structuredClone(session.messages);
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
    expect(session.messages).toEqual(originalMessages);
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
    const summary = session.messages.find(
      (message) => message.role === "system" && String(message.content).includes("Conversation summary (model-generated)")
    );
    expect(String(summary?.content)).toContain("Goal: ship feature X");
    expect(session.messages.some((message) => String(message.content) === "turn 11")).toBe(true);
    expect(session.messages.some((message) => String(message.content) === "turn 0")).toBe(false);
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
    expect(session.messages.some((message) => String(message.content).startsWith("Context compacted locally"))).toBe(true);
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
    expect(lastMessage).toEqual({ role: "assistant", content: result.output });
  });
});

class ScriptedClient implements ChatClient {
  private index = 0;
  readonly requests: ChatRequest[] = [];

  constructor(private readonly responses: ChatResponse[]) {}

  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
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
    }
  };
}

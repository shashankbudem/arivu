import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent/Agent.js";
import type { AgentSession, ChatClient, ChatRequest, ChatResponse } from "../src/agent/types.js";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";

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
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    const first = await agent.run("check this change", { skillNames: ["$qa-check"] });
    const firstRequestText = client.requests[0]?.messages.map((message) => String(message.content)).join("\n") ?? "";
    expect(firstRequestText).toContain("Skill loaded into chat: qa-check");
    expect(firstRequestText).toContain("Run the UI and capture evidence.");
    expect(first.session.messages.filter((message) => String(message.content).startsWith("Skill loaded into chat: qa-check"))).toHaveLength(1);

    const second = await agent.run("continue", { skillNames: ["qa-check"] });
    expect(second.session.messages.filter((message) => String(message.content).startsWith("Skill loaded into chat: qa-check"))).toHaveLength(1);
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
      approvals: new ApprovalManager("readonly", async () => false),
      cwd: tempDir
    });

    const result = await agent.run("latest cricket news");
    const secondRequestTools = client.requests[1]?.tools.map((tool) => tool.name);
    const secondRequestMessages = client.requests[1]?.messages.map((message) => message.content).join("\n");

    expect(result.output).toBe("India cricket update found.");
    expect(client.requests[0]?.tools.map((tool) => tool.name)).toContain("web_search");
    expect(secondRequestTools).toHaveLength(0);
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

  it("saves a visible assistant message when max tool depth is reached", async () => {
    const client = new ScriptedClient(
      Array.from({ length: 20 }, (_entry, index) => ({
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

    expect(result.output).toBe("Stopped after reaching the maximum tool-call depth.");
    expect(lastMessage).toEqual({ role: "assistant", content: "Stopped after reaching the maximum tool-call depth." });
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

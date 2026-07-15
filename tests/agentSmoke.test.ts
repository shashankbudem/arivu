import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/Agent.js";
import type { ChatClient, ChatRequest, ChatResponse } from "../src/agent/types.js";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";

// End-to-end smoke test: a scripted ChatClient drives the agent through the real tool registry
// (read -> edit -> final answer) against a fixture repo, and we assert the on-disk effect.
let tempDir: string;
let previousSkillsHome: string | undefined;

describe("agent smoke", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-smoke-"));
    previousSkillsHome = process.env.ARIVU_SKILLS_HOME;
    process.env.ARIVU_SKILLS_HOME = path.join(tempDir, "global-skills");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (previousSkillsHome === undefined) {
      delete process.env.ARIVU_SKILLS_HOME;
    } else {
      process.env.ARIVU_SKILLS_HOME = previousSkillsHome;
    }
  });

  it("reads a file and applies a real edit end-to-end", async () => {
    await writeFile(path.join(tempDir, "greeting.txt"), "hello world\n", "utf8");

    const client = new FixtureClient([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_read", name: "read", arguments: { path: "greeting.txt" } }]
        }
      },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_edit",
              name: "edit",
              arguments: { path: "greeting.txt", oldString: "hello world", newString: "goodbye world" }
            }
          ]
        }
      },
      { message: { role: "assistant", content: "Replaced the greeting." } }
    ]);

    const agent = new Agent({
      client,
      approvals: new ApprovalManager("trusted", async () => true),
      cwd: tempDir
    });

    const result = await agent.run("swap the greeting");

    expect(result.output).toBe("Replaced the greeting.");
    await expect(readFile(path.join(tempDir, "greeting.txt"), "utf8")).resolves.toBe("goodbye world\n");
    const toolNames = result.session.messages.filter((message) => message.role === "tool").map((message) => message.name);
    expect(toolNames).toEqual(["read", "edit"]);
  });
});

class FixtureClient implements ChatClient {
  private index = 0;

  constructor(private readonly responses: ChatResponse[]) {}

  async complete(request: ChatRequest): Promise<ChatResponse> {
    void request;
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) {
      throw new Error("FixtureClient ran out of scripted responses.");
    }
    return response;
  }
}

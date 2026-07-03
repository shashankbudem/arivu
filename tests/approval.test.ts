import { describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";
import type { AgentTaskRunApprovalEvent } from "../src/agent/types.js";

describe("approval manager", () => {
  it("can require approval for repo reads with a workspace override", async () => {
    let prompted = false;
    const approvals = new ApprovalManager(
      "trusted",
      async (message) => {
        prompted = true;
        expect(message).toContain("Repo read: read file");
        expect(message).toContain("Path: README.md");
        return true;
      },
      { read_repo: "prompt" }
    );

    await expect(approvals.require({ type: "read", summary: "read file", path: "README.md" })).resolves.toBeUndefined();
    expect(prompted).toBe(true);
  });

  it("prompts for shell commands even in trusted mode", async () => {
    const approvals = new ApprovalManager("trusted", async () => false);
    await expect(approvals.require({ type: "shell", command: "npm test" })).rejects.toThrow(/denied/);
  });

  it("prompts for destructive commands even in trusted mode", async () => {
    const approvals = new ApprovalManager("trusted", async () => false);
    await expect(approvals.require({ type: "shell", command: "rm -rf dist" })).rejects.toThrow(/denied/);
  });

  it("allows non-risky workspace writes in trusted mode", async () => {
    let prompted = false;
    const approvals = new ApprovalManager("trusted", async () => {
      prompted = true;
      return false;
    });

    await expect(approvals.require({ type: "write", summary: "create note" })).resolves.toBeUndefined();
    expect(prompted).toBe(false);
  });

  it("can require approval for trusted workspace writes with a workspace override", async () => {
    let prompted = false;
    const approvals = new ApprovalManager(
      "trusted",
      async (message) => {
        prompted = true;
        expect(message).toContain("Write: create note");
        return true;
      },
      { write_workspace: "prompt" }
    );

    await expect(approvals.require({ type: "write", summary: "create note" })).resolves.toBeUndefined();
    expect(prompted).toBe(true);
  });

  it("emits approval audit events for prompted decisions", async () => {
    const events: AgentTaskRunApprovalEvent[] = [];
    const approvals = new ApprovalManager(
      "ask",
      async () => false,
      {},
      (event) => {
        events.push(event);
      }
    );

    await expect(approvals.require({ type: "shell", command: "npm test" })).rejects.toThrow(/denied/);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      actionType: "shell",
      capability: "run_command",
      status: "requested",
      trustMode: "ask",
      effect: "prompt",
      summary: "npm test",
      scope: {
        kind: "command",
        label: "Command",
        value: "npm test"
      },
      message: "Shell command: npm test"
    });
    expect(events[1]).toMatchObject({
      id: events[0]?.id,
      actionType: "shell",
      capability: "run_command",
      status: "denied",
      effect: "prompt",
      summary: "npm test",
      scope: {
        kind: "command",
        label: "Command",
        value: "npm test"
      }
    });
  });

  it("emits compact approval scopes for each action type", async () => {
    const events: AgentTaskRunApprovalEvent[] = [];
    const approvals = new ApprovalManager(
      "trusted",
      async () => true,
      {},
      (event) => {
        events.push(event);
      }
    );

    await expect(approvals.require({ type: "read", summary: "read file", path: "README.md" })).resolves.toBeUndefined();
    await expect(approvals.require({ type: "write", summary: "create note", path: "notes.md", mode: "create" })).resolves.toBeUndefined();
    await expect(approvals.require({ type: "shell", command: "npm test", cwd: "/workspace" })).resolves.toBeUndefined();
    await expect(
      approvals.require({ type: "network", summary: "fetch docs", destination: "https://example.com/docs", query: "sdk" })
    ).resolves.toBeUndefined();
    await expect(approvals.require({ type: "mcp", server: "github", tool: "list_pull_requests" })).resolves.toBeUndefined();
    await expect(
      approvals.require({ type: "browser", action: "open", target: "https://developer.example.com/start", mode: "visible" })
    ).resolves.toBeUndefined();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionType: "read",
          scope: expect.objectContaining({ kind: "path", label: "Read path", value: "README.md" })
        }),
        expect.objectContaining({
          actionType: "write",
          scope: expect.objectContaining({ kind: "path", label: "Write path", value: "notes.md", detail: "mode: create" })
        }),
        expect.objectContaining({
          actionType: "shell",
          scope: expect.objectContaining({ kind: "command", label: "Command", value: "npm test", detail: "cwd: /workspace" })
        }),
        expect.objectContaining({
          actionType: "network",
          scope: expect.objectContaining({ kind: "network", label: "Network target", value: "example.com", detail: "query: sdk" })
        }),
        expect.objectContaining({
          actionType: "mcp",
          scope: expect.objectContaining({ kind: "mcp", label: "MCP tool", value: "github/list_pull_requests" })
        }),
        expect.objectContaining({
          actionType: "browser",
          scope: expect.objectContaining({ kind: "browser", label: "Browser target", value: "developer.example.com", detail: "open - visible" })
        })
      ])
    );
  });

  it("can block trusted browser actions with a workspace override", async () => {
    let prompted = false;
    const approvals = new ApprovalManager(
      "trusted",
      async () => {
        prompted = true;
        return true;
      },
      { browser_control: "deny" }
    );

    await expect(
      approvals.require({
        type: "browser",
        action: "click",
        target: "Local button",
        mode: "background"
      })
    ).rejects.toThrow(/workspace policy override/);
    expect(prompted).toBe(false);
  });

  it("emits approval audit events for automatic allow and block decisions", async () => {
    const events: AgentTaskRunApprovalEvent[] = [];
    const trusted = new ApprovalManager(
      "trusted",
      async () => false,
      {},
      (event) => {
        events.push(event);
      }
    );
    await expect(trusted.require({ type: "read", summary: "read file", path: "README.md" })).resolves.toBeUndefined();
    await expect(trusted.require({ type: "write", summary: "create note" })).resolves.toBeUndefined();

    const readonly = new ApprovalManager(
      "readonly",
      async () => true,
      {},
      (event) => {
        events.push(event);
      }
    );
    await expect(readonly.require({ type: "write", summary: "edit file" })).rejects.toThrow(/readonly/);

    expect(events).toMatchObject([
      {
        actionType: "read",
        capability: "read_repo",
        status: "allowed",
        trustMode: "trusted",
        effect: "allow",
        summary: "read file - README.md"
      },
      {
        actionType: "write",
        capability: "write_workspace",
        status: "allowed",
        trustMode: "trusted",
        effect: "allow",
        summary: "create note"
      },
      {
        actionType: "write",
        capability: "write_workspace",
        status: "blocked",
        trustMode: "readonly",
        effect: "deny",
        summary: "edit file"
      }
    ]);
  });

  it("prompts for risky workspace writes in trusted mode", async () => {
    const approvals = new ApprovalManager("trusted", async () => false);
    await expect(approvals.require({ type: "write", summary: "delete generated output", destructive: true })).rejects.toThrow(/denied/);
  });

  it("allows browser actions without prompting in default trust modes", async () => {
    for (const mode of ["readonly", "ask", "trusted"] as const) {
      let prompted = false;
      const approvals = new ApprovalManager(mode, async () => {
        prompted = true;
        return false;
      });

      await expect(
        approvals.require({
          type: "browser",
          action: "open",
          target: "https://example.com",
          mode: "background",
          destructive: true
        })
      ).resolves.toBeUndefined();
      expect(prompted).toBe(false);
    }
  });

  it("prompts for MCP tools in trusted mode", async () => {
    const approvals = new ApprovalManager("trusted", async () => false);
    await expect(approvals.require({ type: "mcp", server: "fake", tool: "list" })).rejects.toThrow(/denied/);
  });

  it("blocks writes in readonly mode", async () => {
    const approvals = new ApprovalManager("readonly", async () => true);
    await expect(approvals.require({ type: "write", summary: "edit file" })).rejects.toThrow(/readonly/);
  });

  it("can block browser actions in readonly mode with a workspace override", async () => {
    let prompted = false;
    const approvals = new ApprovalManager(
      "readonly",
      async () => {
        prompted = true;
        return false;
      },
      { browser_control: "deny" }
    );

    await expect(
      approvals.require({
        type: "browser",
        action: "open",
        target: "https://example.com",
        mode: "visible",
        destructive: true
      })
    ).rejects.toThrow(/workspace policy override/);
    expect(prompted).toBe(false);
  });

  it("does not let workspace overrides weaken readonly blocks", async () => {
    let prompted = false;
    const approvals = new ApprovalManager(
      "readonly",
      async () => {
        prompted = true;
        return true;
      },
      { run_command: "prompt" }
    );

    await expect(approvals.require({ type: "shell", command: "npm test" })).rejects.toThrow(/readonly/);
    expect(prompted).toBe(false);
  });

  it("prompts for network requests in readonly mode", async () => {
    const approvals = new ApprovalManager("readonly", async (message) => {
      expect(message).toContain("Network request: web_search");
      expect(message).toContain("Query: private query");
      return true;
    });

    await expect(
      approvals.require({
        type: "network",
        summary: "web_search",
        destination: "Bing RSS",
        query: "private query",
        destructive: true
      })
    ).resolves.toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";
import { scopePolicySummariesForTool, scopePolicySummaryItems } from "../src/permissions/scopePolicy.js";
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

  it("denies blocked path and network scopes before prompting", async () => {
    const events: AgentTaskRunApprovalEvent[] = [];
    let prompted = false;
    const approvals = new ApprovalManager(
      "trusted",
      async () => {
        prompted = true;
        return true;
      },
      {},
      (event) => {
        events.push(event);
      },
      {
        blockedPathPrefixes: ["secrets"],
        allowedNetworkDomains: ["api.tavily.com"],
        allowedMcpServers: ["github"],
        allowedBrowserTargetClasses: ["background", "local"]
      }
    );

    await expect(approvals.require({ type: "read", summary: "read file", path: "secrets/token.txt" })).rejects.toThrow(
      /workspace scope rule blocks path/
    );
    await expect(
      approvals.require({
        type: "network",
        summary: "web_search",
        destination: "https://www.bing.com/search",
        query: "news"
      })
    ).rejects.toThrow(/workspace network allowlist blocks www\.bing\.com/);
    await expect(approvals.require({ type: "mcp", server: "browser", tool: "snapshot" })).rejects.toThrow(
      /workspace MCP server allowlist blocks browser/
    );
    await expect(
      approvals.require({
        type: "browser",
        action: "open",
        target: "https://example.com/",
        url: "https://example.com/",
        mode: "background"
      })
    ).rejects.toThrow(/workspace browser target-class allowlist blocks public/);
    await expect(
      approvals.require({
        type: "browser",
        action: "open",
        target: "http://localhost:5173/",
        url: "http://localhost:5173/",
        mode: "visible"
      })
    ).rejects.toThrow(/workspace browser target-class allowlist blocks visible/);

    expect(prompted).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionType: "read",
          status: "blocked",
          effect: "deny",
          label: "Blocked by workspace scope",
          override: "deny",
          scope: expect.objectContaining({ kind: "path", value: "secrets/token.txt" })
        }),
        expect.objectContaining({
          actionType: "network",
          status: "blocked",
          effect: "deny",
          label: "Blocked by workspace scope",
          override: "deny",
          scope: expect.objectContaining({ kind: "network", value: "www.bing.com" })
        }),
        expect.objectContaining({
          actionType: "mcp",
          status: "blocked",
          effect: "deny",
          label: "Blocked by workspace scope",
          override: "deny",
          scope: expect.objectContaining({ kind: "mcp", value: "browser/snapshot" })
        }),
        expect.objectContaining({
          actionType: "browser",
          status: "blocked",
          effect: "deny",
          label: "Blocked by workspace scope",
          override: "deny",
          scope: expect.objectContaining({ kind: "browser", value: "example.com" })
        }),
        expect.objectContaining({
          actionType: "browser",
          status: "blocked",
          effect: "deny",
          label: "Blocked by workspace scope",
          override: "deny",
          scope: expect.objectContaining({ kind: "browser", value: "localhost" })
        })
      ])
    );
  });

  it("summarizes workspace scope rules for settings and tool rows", () => {
    const rules = {
      blockedPathPrefixes: [".env", "private", "secrets", "tmp"],
      allowedNetworkDomains: ["api.tavily.com"],
      allowedMcpServers: ["chrome-devtools", "github"],
      allowedBrowserTargetClasses: ["background" as const, "local" as const]
    };

    expect(scopePolicySummaryItems(rules)).toEqual([
      { label: "Blocked paths", value: ".env, private, secrets +1 more" },
      { label: "Network domains", value: "api.tavily.com" },
      { label: "MCP servers", value: "chrome-devtools, github" },
      { label: "Browser classes", value: "background, local" }
    ]);
    expect(scopePolicySummariesForTool("read", rules)).toEqual(["Blocked paths: .env, private, secrets +1 more"]);
    expect(scopePolicySummariesForTool("web_search", rules)).toEqual(["Allowed domains: api.tavily.com"]);
    expect(scopePolicySummariesForTool("mcp_call_tool", rules)).toEqual(["Allowed MCP: chrome-devtools, github"]);
    expect(scopePolicySummariesForTool("browser_open", rules)).toEqual(["Allowed browser: background, local"]);
    expect(scopePolicySummariesForTool("current_datetime", rules)).toEqual([]);
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

  it("labels large direct edit reviews without calling them destructive", async () => {
    let prompt = "";
    const approvals = new ApprovalManager("trusted", async (message) => {
      prompt = message;
      return true;
    });

    await expect(
      approvals.require({
        type: "write",
        summary: "large direct patch",
        paths: ["README.md"],
        diff: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
        destructive: true,
        changeSummary: "1 file, +1/-1",
        reviewReason: "Large direct patch (120 changed lines) needs review before applying."
      })
    ).resolves.toBeUndefined();

    expect(prompt).toContain("Write review: large direct patch");
    expect(prompt).toContain("Review boundary: Large direct patch");
    expect(prompt).toContain("Change summary: 1 file, +1/-1");
    expect(prompt).not.toContain("Destructive write");
  });

  it("records structured patch previews on write approval audits", async () => {
    const events: AgentTaskRunApprovalEvent[] = [];
    const approvals = new ApprovalManager(
      "trusted",
      async () => false,
      {},
      (event) => {
        events.push(event);
      }
    );

    await expect(
      approvals.require({
        type: "write",
        summary: "patch file",
        paths: ["src/example.ts"],
        diff: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n"
      })
    ).resolves.toBeUndefined();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "allowed",
      actionType: "write",
      changePreview: {
        kind: "patch",
        title: "Patch preview",
        changedPaths: ["src/example.ts"],
        additions: 1,
        deletions: 1,
        lineCount: 5
      }
    });
    expect(events[0]?.changePreview?.diff).toContain("+new");
  });

  it("records structured file-write previews on prompted write decisions", async () => {
    const events: AgentTaskRunApprovalEvent[] = [];
    const approvals = new ApprovalManager(
      "ask",
      async () => true,
      {},
      (event) => {
        events.push(event);
      }
    );

    await expect(
      approvals.require({
        type: "write",
        summary: "replace config",
        path: "config.json",
        mode: "replace",
        original: "{\"old\":true}\n",
        content: "{\"new\":true}\n"
      })
    ).resolves.toBeUndefined();

    expect(events.map((event) => event.status)).toEqual(["requested", "approved"]);
    expect(events[0]?.changePreview).toMatchObject({
      kind: "file_change",
      title: "File replacement preview",
      path: "config.json",
      writeMode: "replace",
      lineCount: 1
    });
    expect(events[0]?.changePreview?.original).toContain("\"old\"");
    expect(events[0]?.changePreview?.content).toContain("\"new\"");
    expect(events[1]?.changePreview).toEqual(events[0]?.changePreview);
  });

  it("keeps write previews when a prompted write is denied", async () => {
    const events: AgentTaskRunApprovalEvent[] = [];
    const approvals = new ApprovalManager(
      "ask",
      async () => false,
      {},
      (event) => {
        events.push(event);
      }
    );

    await expect(
      approvals.require({
        type: "write",
        summary: "create note",
        path: "notes/todo.md",
        mode: "create",
        content: "- review\n"
      })
    ).rejects.toThrow(/denied/);

    expect(events.map((event) => event.status)).toEqual(["requested", "denied"]);
    expect(events[1]?.changePreview).toMatchObject({
      kind: "file_change",
      path: "notes/todo.md",
      writeMode: "create",
      content: "- review\n"
    });
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

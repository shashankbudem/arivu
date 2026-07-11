import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createSkill, readSkill } from "../src/agent/skills.js";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";
import type { WorkspaceScopePolicyRules } from "../src/permissions/scopePolicy.js";
import type { BrowserToolController } from "../src/tools/browserControl.js";
import { ChangeCheckpoint } from "../src/tools/changeCheckpoint.js";
import { DIRECT_EDIT_REVIEW_CHANGED_LINE_THRESHOLD } from "../src/tools/directEditReview.js";
import { createToolRegistry } from "../src/tools/registry.js";

describe("createToolRegistry", () => {
  it("includes current date/time and location tools", () => {
    const registry = createRegistry();
    const names = registry.schemas.map((schema) => schema.name);

    expect(names).toContain("current_datetime");
    expect(names).toContain("current_location");
    expect(names).toContain("mcp_list_tools");
    expect(names).toContain("mcp_call_tool");
  });

  it("registers browser tools only when a browser controller is provided", async () => {
    const withoutBrowser = createRegistry();
    expect(withoutBrowser.schemas.map((schema) => schema.name)).not.toContain("browser_open");

    const browser = createFakeBrowser();
    const withBrowser = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("trusted"),
      browser
    });
    const names = withBrowser.schemas.map((schema) => schema.name);

    expect(names).toContain("browser_open");
    expect(names).toContain("browser_state");
    expect(names).toContain("browser_select_tab");
    expect(names).toContain("browser_screenshot");
    expect(names).toContain("browser_task");

    const result = JSON.parse(await withBrowser.execute("browser_open", { url: "localhost:5173" })) as Record<string, unknown>;
    expect(result.action).toBe("open");
    expect(result.mode).toBe("background");
    expect(result.url).toBe("http://localhost:5173/");

    const searchResult = JSON.parse(await withBrowser.execute("browser_open", { url: "service now developer portal" })) as Record<
      string,
      unknown
    >;
    expect(searchResult.url).toBe("https://www.google.com/search?q=service+now+developer+portal");

    const visibleResult = JSON.parse(await withBrowser.execute("browser_open", { url: "localhost:5173", mode: "visible" })) as Record<
      string,
      unknown
    >;
    expect(visibleResult.mode).toBe("visible");

    const stateResult = JSON.parse(await withBrowser.execute("browser_state", {})) as Record<string, unknown>;
    expect(stateResult.action).toBe("state");
    expect(stateResult.activeMode).toBe("visible");
    expect(stateResult.visible).toMatchObject({
      activeTabId: "visible-tab-1",
      tabs: expect.arrayContaining([
        expect.objectContaining({
          id: "visible-tab-1",
          lastSnapshotAt: "2026-07-06T21:00:00.000Z"
        })
      ])
    });

    const selectResult = JSON.parse(await withBrowser.execute("browser_select_tab", { tabId: "visible-tab-1" })) as Record<string, unknown>;
    expect(selectResult.action).toBe("select_tab");
    expect(selectResult.mode).toBe("visible");
    expect(selectResult.activeTabId).toBe("visible-tab-1");
  });

  it("disables the low-level manual browser tools to steer toward browser_task", async () => {
    const browser = createFakeBrowser();
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("trusted"),
      browser
    });
    const names = registry.schemas.map((schema) => schema.name);

    for (const disabled of [
      "browser_snapshot",
      "browser_click",
      "browser_click_at",
      "browser_type",
      "browser_scroll",
      "browser_select_option"
    ]) {
      expect(names).not.toContain(disabled);
      await expect(registry.execute(disabled, {})).rejects.toThrow(/Unknown tool/);
    }
  });

  it("allows browser actions in readonly mode without prompting", async () => {
    const browser = createFakeBrowser();
    let prompted = false;
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("readonly", async () => {
        prompted = true;
        return false;
      }),
      browser
    });

    await expect(registry.execute("browser_open", { url: "https://example.com" })).resolves.toMatch(/"action": "open"/);
    await expect(registry.execute("browser_state", {})).resolves.toMatch(/"action": "state"/);
    expect(prompted).toBe(false);
  });

  it("registers browser_task only when a browser controller is provided", () => {
    const withoutBrowser = createRegistry();
    expect(withoutBrowser.schemas.map((schema) => schema.name)).not.toContain("browser_task");

    const withBrowser = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("trusted"),
      browser: createFakeBrowser(),
      browserTaskModel: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" }
    });
    expect(withBrowser.schemas.map((schema) => schema.name)).toContain("browser_task");
  });

  it("gates browser_task behind approval as a destructive action and forwards instruction/budgets", async () => {
    const browser = createFakeBrowser();
    let prompted = false;
    let requestedLabel: string | undefined;
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager(
        "trusted",
        async (label) => {
          prompted = true;
          requestedLabel = label;
          return true;
        },
        { browser_control: "prompt" }
      ),
      browser,
      browserTaskModel: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: "real-secret-key" }
    });

    const result = JSON.parse(
      await registry.execute("browser_task", { instruction: "fill out the form", maxSteps: 12, timeoutMs: 45_000 })
    ) as Record<string, unknown>;

    expect(prompted).toBe(true);
    expect(requestedLabel).toContain("Autonomous browser task: fill out the form");
    expect(result.action).toBe("task");
    expect(result.success).toBe(true);
    expect(result.data).toBe("Completed: fill out the form");
    expect(result.maxSteps).toBe(12);
    expect(result.timeoutMs).toBe(600_000);
    expect(result.modelConfig).toMatchObject({ baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" });
  });

  it("raises undersized browser_task budgets so paced provider calls can finish", async () => {
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("trusted"),
      browser: createFakeBrowser(),
      browserTaskModel: { baseUrl: "https://integrate.api.nvidia.com/v1", model: "deepseek-ai/deepseek-v4-flash" }
    });

    const result = JSON.parse(
      await registry.execute("browser_task", { instruction: "complete a multi-step form", timeoutMs: 120_000 })
    ) as Record<string, unknown>;

    expect(result.timeoutMs).toBe(600_000);
  });

  it("leaves JavaScript execution off unless allowJavaScript is explicitly set", async () => {
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("trusted"),
      browser: createFakeBrowser(),
      browserTaskModel: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" }
    });

    const defaultResult = JSON.parse(await registry.execute("browser_task", { instruction: "fill out the form" })) as Record<
      string,
      unknown
    >;
    expect(defaultResult.allowJavaScript).toBeUndefined();

    const optedInResult = JSON.parse(
      await registry.execute("browser_task", { instruction: "compute a value the DOM can't expose", allowJavaScript: true })
    ) as Record<string, unknown>;
    expect(optedInResult.allowJavaScript).toBe(true);
  });

  it("surfaces browser_task denial as text instead of throwing", async () => {
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("trusted", async () => false, { browser_control: "prompt" }),
      browser: createFakeBrowser(),
      browserTaskModel: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" }
    });

    await expect(registry.execute("browser_task", { instruction: "do something" })).resolves.toMatch(/denied browser/);
  });

  it("fails browser_task cleanly when no model is configured for the run", async () => {
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("trusted"),
      browser: createFakeBrowser()
    });

    await expect(registry.execute("browser_task", { instruction: "do something" })).resolves.toMatch(
      /Error: browser_task has no model configured/
    );
  });

  it("rejects incompatible browser_task mode and tab targets before execution", async () => {
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("trusted"),
      browser: createFakeBrowser(),
      browserTaskModel: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" }
    });

    await expect(registry.execute("browser_task", { instruction: "do something", mode: "visible", tabId: "background" })).resolves.toMatch(
      /cannot use tabId "background" in visible mode/
    );
    await expect(
      registry.execute("browser_task", { instruction: "do something", mode: "background", tabId: "visible-tab-1" })
    ).resolves.toMatch(/cannot target a visible tab id in background mode/);
  });

  it("forwards an aborted run signal into browser_task", async () => {
    const controller = new AbortController();
    controller.abort();
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("trusted"),
      browser: createFakeBrowser(),
      browserTaskModel: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" },
      signal: controller.signal
    });

    const result = JSON.parse(await registry.execute("browser_task", { instruction: "do something" })) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.stopped).toBe(true);
    expect(result.stopReason).toBe("cancelled");
  });

  it("honors workspace browser control overrides", async () => {
    const browser = createFakeBrowser();
    let prompted = false;
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager(
        "readonly",
        async () => {
          prompted = true;
          return false;
        },
        { browser_control: "deny" }
      ),
      browser
    });

    await expect(registry.execute("browser_open", { url: "https://example.com" })).resolves.toMatch(/workspace policy override/);
    expect(prompted).toBe(false);
  });

  it("rejects browser file URLs that escape the workspace through symlinks", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-browser-file-"));
    try {
      const workspace = path.join(tempDir, "workspace");
      const outside = path.join(tempDir, "outside");
      await mkdir(workspace);
      await mkdir(outside);
      await symlink(outside, path.join(workspace, "link"));
      const browser = createFakeBrowser();
      const registry = createToolRegistry({
        workspaceRoot: workspace,
        approvals: new ApprovalManager("trusted", async () => true),
        browser
      });

      const url = pathToFileURL(path.join(workspace, "link", "secret.txt")).toString();
      await expect(registry.execute("browser_open", { url })).resolves.toMatch(/symlink/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires approval before web search leaves the machine", async () => {
    let prompted = false;
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("readonly", async () => {
        prompted = true;
        return false;
      })
    });

    await expect(registry.execute("web_search", { query: "sensitive private query" })).resolves.toMatch(/denied network/);
    expect(prompted).toBe(true);
  });

  it("enforces workspace read policy overrides for repo read tools", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-read-policy-"));
    try {
      await writeFile(path.join(tempDir, "README.md"), "hello\n", "utf8");
      let prompted = false;
      const registry = createToolRegistry({
        workspaceRoot: tempDir,
        approvals: new ApprovalManager(
          "trusted",
          async () => {
            prompted = true;
            return false;
          },
          { read_repo: "deny" }
        )
      });

      await expect(registry.execute("list", { path: "." })).resolves.toMatch(/workspace policy override/);
      await expect(registry.execute("read", { path: "README.md" })).resolves.toMatch(/workspace policy override/);
      await expect(registry.execute("search", { query: "hello", path: "." })).resolves.toMatch(/workspace policy override/);
      await expect(registry.execute("git_status", {})).resolves.toMatch(/workspace policy override/);
      expect(prompted).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces workspace scope rules for paths, patch targets, and network destinations", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-scope-policy-"));
    try {
      await mkdir(path.join(tempDir, "secrets"));
      await writeFile(path.join(tempDir, "secrets", "token.txt"), "secret\n", "utf8");
      let prompted = false;
      const registry = createToolRegistry({
        workspaceRoot: tempDir,
        approvals: new ApprovalManager(
          "trusted",
          async () => {
            prompted = true;
            return true;
          },
          {},
          undefined,
          {
            blockedPathPrefixes: ["secrets"],
            allowedNetworkDomains: ["api.tavily.com"]
          }
        )
      });

      await expect(registry.execute("read", { path: "secrets/token.txt" })).resolves.toMatch(/workspace scope rule blocks path/);
      await expect(
        registry.execute("apply_patch", {
          diff: ["--- a/secrets/token.txt", "+++ b/secrets/token.txt", "@@ -1 +1 @@", "-secret", "+updated"].join("\n")
        })
      ).resolves.toMatch(/workspace scope rule blocks path/);
      await expect(registry.execute("web_search", { query: "current docs" })).resolves.toMatch(
        /workspace network allowlist blocks www\.bing\.com/
      );
      expect(prompted).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces MCP server scope rules while listing only allowed server tools", async () => {
    const scopePolicyRules = { allowedMcpServers: ["allowed"] };
    let prompts = 0;
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager(
        "trusted",
        async () => {
          prompts += 1;
          return true;
        },
        {},
        undefined,
        scopePolicyRules
      ),
      mcpServers: {
        allowed: {
          command: "definitely-not-started-allowed",
          args: [],
          env: {},
          disabled: false
        },
        blocked: {
          command: "definitely-not-started-blocked",
          args: [],
          env: {},
          disabled: false
        }
      },
      scopePolicyRules
    });

    const listResult = await registry.execute("mcp_list_tools", {});
    expect(prompts).toBe(1);
    expect(listResult).toContain('"server": "allowed"');
    expect(listResult).not.toContain('"server": "blocked"');

    await expect(registry.execute("mcp_call_tool", { server: "blocked", tool: "read", args: {} })).resolves.toMatch(
      /workspace MCP server allowlist blocks blocked/
    );
    expect(prompts).toBe(1);
  });

  it("enforces browser target-class scope rules for navigation and browser reads", async () => {
    const browser = createFakeBrowser();
    const scopePolicyRules: WorkspaceScopePolicyRules = { allowedBrowserTargetClasses: ["background", "local"] };
    let prompted = false;
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager(
        "trusted",
        async () => {
          prompted = true;
          return true;
        },
        {},
        undefined,
        scopePolicyRules
      ),
      browser,
      scopePolicyRules
    });

    await expect(registry.execute("browser_open", { url: "localhost:5173" })).resolves.toMatch(/"action": "open"/);
    await expect(registry.execute("browser_open", { url: "https://example.com" })).resolves.toMatch(
      /workspace browser target-class allowlist blocks public/
    );
    await expect(registry.execute("browser_screenshot", { mode: "visible" })).resolves.toMatch(
      /workspace browser target-class allowlist blocks visible/
    );
    expect(prompted).toBe(false);
  });

  it("can prompt before repo reads when workspace policy requires it", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-read-prompt-"));
    try {
      await writeFile(path.join(tempDir, "README.md"), "hello\n", "utf8");
      const prompts: string[] = [];
      const registry = createToolRegistry({
        workspaceRoot: tempDir,
        approvals: new ApprovalManager(
          "trusted",
          async (message) => {
            prompts.push(message);
            return true;
          },
          { read_repo: "prompt" }
        )
      });

      await expect(registry.execute("read", { path: "README.md" })).resolves.toBe("1\thello");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Repo read: read file");
      expect(prompts[0]).toContain("Path: README.md");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires review before large direct patches in trusted mode", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-large-patch-"));
    const lineCount = Math.ceil(DIRECT_EDIT_REVIEW_CHANGED_LINE_THRESHOLD / 2);
    const original = Array.from({ length: lineCount }, (_value, index) => `old-${index}`);
    const updated = Array.from({ length: lineCount }, (_value, index) => `new-${index}`);
    const diff = largeReplacementDiff("README.md", original, updated);
    const prompts: string[] = [];
    try {
      await writeFile(path.join(tempDir, "README.md"), `${original.join("\n")}\n`, "utf8");
      const registry = createToolRegistry({
        workspaceRoot: tempDir,
        approvals: new ApprovalManager("trusted", async (message) => {
          prompts.push(message);
          return true;
        })
      });

      await registry.execute("read", { path: "README.md" });
      await expect(registry.execute("apply_patch", { diff })).resolves.toContain("Applied patch");
      await expect(readFile(path.join(tempDir, "README.md"), "utf8")).resolves.toBe(`${updated.join("\n")}\n`);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Write review:");
      expect(prompts[0]).toContain("Large direct patch");
      expect(prompts[0]).toContain(`${lineCount * 2} changed lines`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("can skip large direct edit review when another execution boundary owns review", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-worktree-patch-"));
    const lineCount = Math.ceil(DIRECT_EDIT_REVIEW_CHANGED_LINE_THRESHOLD / 2);
    const original = Array.from({ length: lineCount }, (_value, index) => `old-${index}`);
    const updated = Array.from({ length: lineCount }, (_value, index) => `new-${index}`);
    const diff = largeReplacementDiff("README.md", original, updated);
    let prompted = false;
    try {
      await writeFile(path.join(tempDir, "README.md"), `${original.join("\n")}\n`, "utf8");
      const registry = createToolRegistry({
        workspaceRoot: tempDir,
        approvals: new ApprovalManager("trusted", async () => {
          prompted = true;
          return false;
        }),
        directEditReview: false
      });

      await registry.execute("read", { path: "README.md" });
      await expect(registry.execute("apply_patch", { diff })).resolves.toContain("Applied patch");
      await expect(readFile(path.join(tempDir, "README.md"), "utf8")).resolves.toBe(`${updated.join("\n")}\n`);
      expect(prompted).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires approval before listing configured MCP tools", async () => {
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("ask", async () => false),
      mcpServers: {
        fake: {
          command: "definitely-not-started",
          args: [],
          env: {},
          disabled: false
        }
      }
    });

    await expect(registry.execute("mcp_list_tools", {})).resolves.toMatch(/denied mcp/);
  });

  it("records host execution profile metadata for shell commands", async () => {
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("ask", async () => true)
    });

    const result = await registry.execute("run", { command: "printf profile-ok" });
    expect(result).toContain(`executionProfile: host\nexecutionIsolation: local host process\nworkingDirectory: ${process.cwd()}`);
    expect(result).toContain("commandRisk: low");
    expect(result).toContain("commandAnalysis: low risk - commands: printf");
    expect(result).toContain("exitCode: 0\nstdout:\nprofile-ok");
  });

  it("runs structured argv commands without shell parsing", async () => {
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("ask", async () => true)
    });

    const result = await registry.execute("run", {
      argv: [process.execPath, "-e", "process.stdout.write(process.argv[1])", "argv-ok && echo shell-ran"]
    });
    expect(result).toContain("commandMode: argv");
    expect(result).toContain("commandRisk: low");
    expect(result).toContain("commandAnalysis: low risk - commands: node");
    expect(result).toContain("exitCode: 0\nstdout:\nargv-ok && echo shell-ran");
    expect(result).not.toContain("shell-ran\n");
  });

  it("records timeout metadata for commands that exceed their limit", async () => {
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("ask", async () => true)
    });

    const result = await registry.execute("run", {
      argv: [process.execPath, "-e", "process.stdout.write('start'); setTimeout(() => {}, 2000)"],
      timeoutMs: 1000
    });

    expect(result).toContain("commandMode: argv");
    expect(result).toContain("timeoutMs: 1000");
    expect(result).toContain("timedOut: true");
    expect(result).toContain("signal: SIGTERM");
    expect(result).toContain("stdout:\nstart");
    expect(result).not.toContain("exitCode:");
  });

  it("rejects unconfigured command execution profiles before approval", async () => {
    let prompted = false;
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("ask", async () => {
        prompted = true;
        return true;
      })
    });

    await expect(registry.execute("run", { command: "printf should-not-run", executionProfile: "sandbox" })).resolves.toContain(
      "sandbox execution is not configured yet"
    );
    expect(prompted).toBe(false);
  });

  it("previews large reads without marking the whole file safe to overwrite", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-large-read-"));
    try {
      const filePath = path.join(tempDir, "large.txt");
      await writeFile(filePath, "a".repeat(30_000), "utf8");
      const registry = createRegistry(tempDir);

      const readResult = await registry.execute("read", { path: "large.txt" });
      expect(readResult.length).toBeLessThan(21_000);
      expect(readResult).toContain("truncated");
      await expect(registry.execute("write_file", { path: "large.txt", content: "new", mode: "replace" })).resolves.toMatch(
        /has not been read/
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("truncates broad search output before returning it to the transcript", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-search-"));
    try {
      await writeFile(path.join(tempDir, "matches.txt"), Array.from({ length: 5000 }, (_, index) => `needle ${index}`).join("\n"), "utf8");
      const registry = createRegistry(tempDir);

      const result = await registry.execute("search", { query: "needle", path: ".", maxResults: 2000 });
      expect(result.length).toBeLessThanOrEqual(60_012);
      expect(result).toContain("[truncated]");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads files with line numbers and pages through them with offset and limit", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-read-lines-"));
    try {
      const lines = Array.from({ length: 10 }, (_value, index) => `line ${index + 1}`);
      await writeFile(path.join(tempDir, "code.txt"), `${lines.join("\n")}\n`, "utf8");
      const registry = createRegistry(tempDir);

      const full = await registry.execute("read", { path: "code.txt" });
      expect(full).toContain(" 1\tline 1");
      expect(full).toContain("10\tline 10");

      const page = await registry.execute("read", { path: "code.txt", offset: 3, limit: 2 });
      expect(page).toContain("3\tline 3");
      expect(page).toContain("4\tline 4");
      expect(page).not.toContain("line 5");
      expect(page).toContain("Showing lines 3-4 of 10");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("edits an exact unique string and supports replaceAll", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-edit-"));
    try {
      await writeFile(path.join(tempDir, "app.ts"), "const a = 1;\nconst b = 1;\n", "utf8");
      const registry = createRegistry(tempDir);
      await registry.execute("read", { path: "app.ts" });

      await expect(registry.execute("edit", { path: "app.ts", oldString: "const a = 1;", newString: "const a = 2;" })).resolves.toContain(
        "Edited app.ts"
      );
      await expect(readFile(path.join(tempDir, "app.ts"), "utf8")).resolves.toBe("const a = 2;\nconst b = 1;\n");

      await registry.execute("read", { path: "app.ts" });
      await expect(registry.execute("edit", { path: "app.ts", oldString: "= ", newString: "= x", replaceAll: true })).resolves.toContain(
        "2 occurrences"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous, missing, and unread edits", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-edit-guard-"));
    try {
      await writeFile(path.join(tempDir, "app.ts"), "x = 1;\nx = 1;\n", "utf8");
      const registry = createRegistry(tempDir);

      await expect(registry.execute("edit", { path: "app.ts", oldString: "x = 1;", newString: "x = 2;" })).resolves.toMatch(
        /has not been read/
      );

      await registry.execute("read", { path: "app.ts" });
      await expect(registry.execute("edit", { path: "app.ts", oldString: "x = 1;", newString: "x = 2;" })).resolves.toMatch(
        /matches 2 times/
      );
      await expect(registry.execute("edit", { path: "app.ts", oldString: "missing", newString: "x" })).resolves.toMatch(
        /oldString not found/
      );
      await expect(registry.execute("edit", { path: "new.ts", oldString: "a", newString: "b" })).resolves.toMatch(/does not exist/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("searches with context lines and a glob filter", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-search-opts-"));
    try {
      await writeFile(path.join(tempDir, "a.ts"), "before\nNEEDLE here\nafter\n", "utf8");
      await writeFile(path.join(tempDir, "b.md"), "NEEDLE in markdown\n", "utf8");
      const registry = createRegistry(tempDir);

      const scoped = await registry.execute("search", { query: "NEEDLE", path: ".", glob: "*.ts", contextLines: 1 });
      expect(scoped).toContain("a.ts");
      expect(scoped).toContain("before");
      expect(scoped).toContain("after");
      expect(scoped).not.toContain("markdown");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("truncates very large command output at the tool boundary", async () => {
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("ask", async () => true)
    });

    const result = await registry.execute("run", {
      argv: [process.execPath, "-e", "process.stdout.write('a'.repeat(100000))"]
    });

    expect(result).toContain("characters truncated");
    expect(result.length).toBeLessThan(60_000);
  });

  it("checkpoints direct edits so a run's changes can be reverted", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-checkpoint-"));
    try {
      await writeFile(path.join(tempDir, "keep.ts"), "original\n", "utf8");
      const checkpoint = new ChangeCheckpoint();
      const registry = createToolRegistry({
        workspaceRoot: tempDir,
        approvals: new ApprovalManager("trusted", async () => true),
        checkpoint
      });

      await registry.execute("read", { path: "keep.ts" });
      await registry.execute("edit", { path: "keep.ts", oldString: "original", newString: "modified" });
      await registry.execute("write_file", { path: "new.ts", content: "created\n", mode: "create" });

      expect(new Set(checkpoint.changedPaths())).toEqual(new Set([path.join(tempDir, "keep.ts"), path.join(tempDir, "new.ts")]));
      await expect(readFile(path.join(tempDir, "keep.ts"), "utf8")).resolves.toBe("modified\n");

      const reverted = await checkpoint.revert();
      expect(reverted.length).toBe(2);
      await expect(readFile(path.join(tempDir, "keep.ts"), "utf8")).resolves.toBe("original\n");
      await expect(readFile(path.join(tempDir, "new.ts"), "utf8")).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports an empty MCP configuration without throwing", async () => {
    const registry = createRegistry();
    const result = await registry.execute("mcp_list_tools", {});

    expect(result).toBe("No MCP servers configured.");
  });

  it("returns current date/time from the system clock", async () => {
    const registry = createRegistry();
    const result = JSON.parse(await registry.execute("current_datetime", {})) as Record<string, unknown>;

    expect(result.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.localTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(result.utc).toEqual(expect.any(String));
    expect(result.timeZone).toEqual(expect.any(String));
    expect(result.utcOffset).toMatch(/^(?:[+-]\d{2}:\d{2}|GMT.*)$/);
  });

  it("returns timezone-level location without network or precise location lookup", async () => {
    const registry = createRegistry();
    const result = JSON.parse(await registry.execute("current_location", {})) as Record<string, unknown>;

    expect(result.timeZone).toEqual(expect.any(String));
    expect(result.source).toBe("system_timezone");
    expect(result.precision).toBe("timezone");
    expect(result.note).toContain("GPS, IP lookup, and network location were not used");
  });

  it("lists and reads global skills", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-skills-"));
    const previousSkillsHome = process.env.ARIVU_SKILLS_HOME;
    try {
      const skillsHome = path.join(tempDir, "global-skills");
      process.env.ARIVU_SKILLS_HOME = skillsHome;
      const skillDir = path.join(skillsHome, "fix-tests");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        "# Fix Tests\ndescription: Debug and fix failing tests.\n\nRun the focused test first.\n",
        "utf8"
      );

      const registry = createRegistry(tempDir);
      const result = await registry.execute("list_skills", {});
      const content = await registry.execute("read_skill", { name: "fix-tests" });

      expect(result).toContain("fix-tests: Debug and fix failing tests.");
      expect(result).toContain("fix-tests/SKILL.md");
      expect(content).toContain("Path: fix-tests/SKILL.md");
      expect(content).toContain("Run the focused test first.");
    } finally {
      if (previousSkillsHome === undefined) {
        delete process.env.ARIVU_SKILLS_HOME;
      } else {
        process.env.ARIVU_SKILLS_HOME = previousSkillsHome;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates global skills with normalized names and rejects duplicates", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-skills-create-"));
    const skillsHome = path.join(tempDir, "global-skills");
    try {
      const skill = await createSkill(
        {
          name: "Careful Reviews",
          description: "Use for careful code review.",
          instructions: "Read the relevant files before listing findings."
        },
        skillsHome
      );
      const content = await readSkill("careful-reviews", skillsHome);

      expect(skill.name).toBe("careful-reviews");
      expect(skill.path).toBe("careful-reviews/SKILL.md");
      expect(content.title).toBe("Careful Reviews");
      expect(content.description).toBe("Use for careful code review.");
      expect(content.content).toContain("Read the relevant files before listing findings.");
      await expect(
        createSkill(
          {
            name: "Careful Reviews",
            instructions: "Duplicate."
          },
          skillsHome
        )
      ).rejects.toThrow('Skill "careful-reviews" already exists.');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createRegistry(workspaceRoot = process.cwd()) {
  return createToolRegistry({
    workspaceRoot,
    approvals: new ApprovalManager("trusted")
  });
}

function largeReplacementDiff(filePath: string, original: string[], updated: string[]) {
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${original.length} +1,${updated.length} @@`,
    ...original.flatMap((line, index) => [`-${line}`, `+${updated[index] ?? ""}`]),
    ""
  ].join("\n");
}

function createFakeBrowser(): BrowserToolController {
  let activeMode: "visible" | "background" = "background";
  const state = () => ({
    paneOpen: activeMode === "visible",
    defaultMode: "background" as const,
    activeMode,
    visible: {
      id: "visible-tab-1",
      mode: "visible" as const,
      url: activeMode === "visible" ? "http://localhost:5173/" : "",
      title: "Fake visible browser",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      activeTabId: "visible-tab-1",
      tabs: [
        {
          id: "visible-tab-1",
          url: activeMode === "visible" ? "http://localhost:5173/" : "",
          title: "Fake visible browser",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          lastSnapshotAt: "2026-07-06T21:00:00.000Z",
          lastScreenshotAt: "2026-07-06T21:01:00.000Z",
          lastScreenshotPath: "/tmp/fake-browser.png"
        }
      ]
    },
    background: {
      id: "background",
      mode: "background" as const,
      url: activeMode === "background" ? "http://localhost:5173/" : "",
      title: "Fake background browser",
      loading: false,
      canGoBack: false,
      canGoForward: false
    }
  });
  return {
    getState() {
      return state();
    },
    async selectTab(args) {
      activeMode = "visible";
      return {
        mode: activeMode,
        tabId: args.tabId,
        activeTabId: args.tabId,
        url: "http://localhost:5173/",
        title: "Fake visible browser"
      };
    },
    async open(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        url: new URL(args.url).toString(),
        title: "Fake browser"
      };
    },
    async screenshot(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        screenshotPath: "/tmp/fake-browser.png"
      };
    },
    async snapshot(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        snapshot: { text: "Fake snapshot" }
      };
    },
    async console(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        logs: []
      };
    },
    async click(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        ok: true,
        target: args.target
      };
    },
    async clickAt(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        ok: true,
        x: args.x,
        y: args.y
      };
    },
    async type(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        ok: true,
        target: args.target,
        text: args.text
      };
    },
    async task(args) {
      activeMode = args.mode ?? activeMode;
      if (args.signal?.aborted) {
        return {
          mode: activeMode,
          success: false,
          data: "Browser task was cancelled.",
          stepCount: 0,
          stopped: true,
          stopReason: "cancelled",
          navigationCount: 0,
          durationMs: 0
        };
      }
      return {
        mode: activeMode,
        success: true,
        data: `Completed: ${args.instruction}`,
        stepCount: 3,
        stopped: false,
        navigationCount: 0,
        durationMs: 5,
        maxSteps: args.maxSteps,
        timeoutMs: args.timeoutMs,
        allowJavaScript: args.allowJavaScript,
        modelConfig: args.modelConfig
      };
    },
    async scroll(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        ok: true,
        direction: args.direction
      };
    },
    async selectOption(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        ok: true,
        index: args.index,
        optionText: args.optionText
      };
    }
  };
}
